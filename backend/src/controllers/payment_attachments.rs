//! File attachments for payment records. Port of old_backend/routes/payment-attachments.js.
//!
//! Routes (under /api/payments, auth required):
//!   GET    /api/payments/{paymentId}/attachments                       - list (endusers scoped)
//!   POST   /api/payments/{paymentId}/attachments                       - multipart upload, field "file" (admin only)
//!   GET    /api/payments/{paymentId}/attachments/{attId}/download        - download as attachment (endusers scoped)
//!   DELETE /api/payments/{paymentId}/attachments/{attId}                - delete row + file (admin only)
//!
//! Upload policy: 100 MB cap, server-side magic-byte sniff (never trust
//! the client Content-Type). Accepted: pdf, png, jpeg, xls, xlsx, csv,
//! doc, docx, txt. Files live at UPLOADS_DIR/payments/<paymentId>/.
//!
//! Simplifications vs the Express original:
//!   - Sniffing is hand-rolled (no `file-type` crate): pdf/png/jpeg by
//!     magic bytes; OLE (xls/doc) distinguished by Workbook/WordDocument
//!     stream names; OOXML (xlsx/docx) by [Content_Types] entry names;
//!     anything else that is valid UTF-8 without NUL bytes is treated as
//!     text/plain (or text/csv for .csv names). Consequence: the old code
//!     *rejected* txt/csv (file-type cannot sniff text); the port accepts
//!     them — documented fix, not a regression.
//!   - Stored filename keeps the sanitized original extension (as the old
//!     code did), restricted to alphanumeric extensions.

use axum::{
    body::Body,
    extract::{Multipart, Path},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser, require_admin};

const MAX_FILE_SIZE: usize = 100 * 1024 * 1024;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[payment-attachments/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|n| *n > 0)
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn upload_root() -> String {
    let root = std::env::var("UPLOADS_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/app/uploads".to_string());
    if root == "/app/uploads" && !std::path::Path::new(&root).exists() {
        return "./uploads".to_string();
    }
    root
}

fn dto_from_row(r: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let uploaded: chrono::DateTime<chrono::Utc> = r.try_get("", "uploaded_at")?;
    Ok(json!({
        "id": r.try_get::<i64>("", "id")?,
        "paymentId": r.try_get::<i64>("", "payment_id")?,
        "originalFilename": r.try_get::<String>("", "original_filename")?,
        "storedFilename": r.try_get::<String>("", "stored_filename")?,
        "mimeType": r.try_get::<String>("", "mime_type")?,
        "sizeBytes": r.try_get::<i64>("", "size_bytes")?,
        "uploadedAt": iso(uploaded),
    }))
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Magic-byte sniff. Returns the canonical mime or None.
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF") {
        return Some("application/pdf");
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some("image/png");
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"\xff\xd8\xff" {
        return Some("image/jpeg");
    }
    // OLE compound document: distinguish .doc vs .xls by stream names.
    if bytes.len() >= 8 && &bytes[0..8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" {
        if contains(bytes, b"WordDocument") {
            return Some("application/msword");
        }
        if contains(bytes, b"Workbook") {
            return Some("application/vnd.ms-excel");
        }
        return None;
    }
    // OOXML zip: distinguish docx vs xlsx by package entry names.
    if bytes.len() >= 4 && &bytes[0..4] == b"PK\x03\x04" {
        if contains(bytes, b"word/document") {
            return Some(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            );
        }
        if contains(bytes, b"xl/workbook") {
            return Some(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            );
        }
        return None;
    }
    // Plain text fallback: valid UTF-8 without NUL bytes.
    if !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() {
        return Some("text/plain");
    }
    None
}

fn sanitized_ext(original: &str, mime: &str) -> String {
    let ext = original.rsplit('.').next().unwrap_or("").to_lowercase();
    if !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return format!(".{ext}");
    }
    match mime {
        "application/pdf" => ".pdf".to_string(),
        "image/png" => ".png".to_string(),
        "image/jpeg" => ".jpg".to_string(),
        "application/msword" => ".doc".to_string(),
        "application/vnd.ms-excel" => ".xls".to_string(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            ".docx".to_string()
        }
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => ".xlsx".to_string(),
        _ => ".txt".to_string(),
    }
}

async fn payment_project(
    db: &sea_orm::DatabaseConnection,
    payment_id: i64,
) -> Result<Option<i64>, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT project_id FROM payments WHERE id = $1",
            vec![payment_id.into()],
        ))
        .await?;
    match row {
        None => Ok(None),
        Some(r) => Ok(Some(r.try_get("", "project_id")?)),
    }
}

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(payment_id): Path<String>,
) -> Response {
    let Some(pid) = parse_id(&payment_id) else {
        return bad("Invalid id");
    };
    let proj = match payment_project(&ctx.db, pid).await {
        Ok(p) => p,
        Err(e) => return internal("lookup", e),
    };
    let Some(project_id) = proj else {
        return err(StatusCode::NOT_FOUND, "Payment not found");
    };
    if user.role != "admin" && !user.project_ids.contains(&project_id) {
        return err(StatusCode::NOT_FOUND, "Payment not found");
    }
    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id, payment_id, original_filename, stored_filename, mime_type, size_bytes, uploaded_at FROM payment_attachments WHERE payment_id = $1 ORDER BY uploaded_at DESC, id DESC",
            vec![pid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("list", e),
    };
    let mut out = vec![];
    for r in &rows {
        match dto_from_row(r) {
            Ok(d) => out.push(d),
            Err(e) => return internal("list", e),
        }
    }
    (StatusCode::OK, Json(out)).into_response()
}

async fn upload(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(payment_id): Path<String>,
    mut multipart: Multipart,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let Some(pid) = parse_id(&payment_id) else {
        return bad("Invalid id");
    };

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut original_name = String::from("upload");
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            original_name = field.file_name().unwrap_or("upload").to_string();
            match field.bytes().await {
                Ok(b) => file_bytes = Some(b.to_vec()),
                Err(_) => return bad("Failed to read upload"),
            }
            break;
        }
    }
    let Some(bytes) = file_bytes else {
        return bad("No file uploaded");
    };
    if bytes.len() > MAX_FILE_SIZE {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "File too large");
    }
    let Some(sniffed) = sniff_mime(&bytes) else {
        return bad("File type not allowed");
    };
    // text/plain sniffed from a .csv name is served as text/csv.
    let mime = if sniffed == "text/plain" && original_name.to_lowercase().ends_with(".csv") {
        "text/csv"
    } else {
        sniffed
    };

    match payment_project(&ctx.db, pid).await {
        Ok(Some(_)) => {}
        Ok(None) => return err(StatusCode::NOT_FOUND, "Payment not found"),
        Err(e) => return internal("lookup", e),
    }

    let stored = format!("{}{}", uuid::Uuid::new_v4(), sanitized_ext(&original_name, mime));
    let root = upload_root();
    let dir = format!("{root}/payments/{pid}");
    let full = format!("{dir}/{stored}");
    let size = bytes.len();
    let write_res = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&full, &bytes))
    })
    .await;
    if write_res.map(|r| r.is_err()).unwrap_or(true) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store file");
    }

    let inserted = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO payment_attachments (payment_id, original_filename, stored_filename, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING id, payment_id, original_filename, stored_filename, mime_type, size_bytes, uploaded_at",
            vec![
                pid.into(),
                original_name.clone().into(),
                stored.clone().into(),
                mime.to_string().into(),
                (size as i64).into(),
            ],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            let p = format!("{root}/payments/{pid}/{stored}");
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&p)).await;
            return internal("insert", "insert returned nothing");
        }
        Err(e) => {
            let p = format!("{root}/payments/{pid}/{stored}");
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&p)).await;
            return internal("insert", e);
        }
    };
    match dto_from_row(&inserted) {
        Ok(d) => (StatusCode::CREATED, Json(d)).into_response(),
        Err(e) => internal("insert", e),
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn download(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path((payment_id, att_id)): Path<(String, String)>,
    _headers: HeaderMap,
) -> Response {
    let Some(pid) = parse_id(&payment_id) else {
        return bad("Invalid id");
    };
    let Some(aid) = parse_id(&att_id) else {
        return bad("Invalid attachment id");
    };
    if user.role != "admin" {
        match payment_project(&ctx.db, pid).await {
            Ok(Some(proj)) if user.project_ids.contains(&proj) => {}
            Ok(_) => return err(StatusCode::NOT_FOUND, "Attachment not found"),
            Err(e) => return internal("lookup", e),
        }
    }
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT original_filename, stored_filename, mime_type FROM payment_attachments WHERE id = $1 AND payment_id = $2",
            vec![aid.into(), pid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("lookup", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "Attachment not found");
    };
    let original: String = r.try_get("", "original_filename").unwrap_or_default();
    let stored: String = r.try_get("", "stored_filename").unwrap_or_default();
    let mime: String = r.try_get("", "mime_type").unwrap_or_default();

    let root = upload_root();
    let full = format!("{root}/payments/{pid}/{stored}");
    let data = tokio::task::spawn_blocking(move || std::fs::read(&full)).await;
    let bytes: Vec<u8> = match data {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => return err(StatusCode::GONE, "File is no longer available"),
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"),
    };

    let ascii: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                if c == '"' {
                    '_'
                } else {
                    c
                }
            } else {
                '_'
            }
        })
        .collect();
    let disp = format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(&original)
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", mime)
        .header("content-length", bytes.len().to_string())
        .header("content-disposition", disp)
        .body(Body::from(bytes))
        .unwrap()
}

async fn delete_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((payment_id, att_id)): Path<(String, String)>,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let Some(pid) = parse_id(&payment_id) else {
        return bad("Invalid id");
    };
    let Some(aid) = parse_id(&att_id) else {
        return bad("Invalid attachment id");
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM payment_attachments WHERE id = $1 AND payment_id = $2 RETURNING stored_filename",
            vec![aid.into(), pid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("delete", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "Attachment not found");
    };
    let stored: String = r.try_get("", "stored_filename").unwrap_or_default();
    if !stored.is_empty() {
        let root = upload_root();
        let full = format!("{root}/payments/{pid}/{stored}");
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&full)).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/payments")
        .add("/{paymentId}/attachments", get(list))
        .add("/{paymentId}/attachments", post(upload))
        .add(
            "/{paymentId}/attachments/{attId}/download",
            get(download),
        )
        .add("/{paymentId}/attachments/{attId}", delete(delete_one))
}
