//! Admin cover-image upload for blog posts.
//!
//! Routes (under /api/blog, auth required, admin-only mutations):
//!   POST   /api/blog/:id/cover   - multipart upload, field "file" (10 MB, image-only)
//!   DELETE /api/blog/:id/cover   - remove cover row + file, NULL the URL
//!
//! The public file surface is GET /api/public/blog/attachments/:filename
//! (see blog_public.rs). The stored URL is absolute, built from
//! APP_PUBLIC_URL (or the request Host in dev).
//!
//! Notes:
//!   - Magic-byte sniffing is hand-rolled (png/jpeg/webp/avif); HEIC and
//!     other exotic types are rejected.
//!   - Enduser uploads are admin-only (require_admin -> 401/403).
//!   - File writes go through tokio spawn_blocking.

use axum::{
    extract::{Multipart, Path},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

use crate::middleware::auth::{MaybeUser, require_admin};

const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[blog-attachments/{ctx}] {e:?}");
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

fn public_base(headers: &HeaderMap) -> String {
    if let Ok(v) = std::env::var("APP_PUBLIC_URL") {
        if !v.trim().is_empty() {
            return v.trim_end_matches('/').to_string();
        }
    }
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    format!("http://{host}")
}

/// Sniff image magic bytes. Returns the canonical mime or None.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some("image/png");
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"\xff\xd8\xff" {
        return Some("image/jpeg");
    }
    // AVIF: ftyp box with an avif-family brand.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" {
            return Some("image/avif");
        }
    }
    None
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/webp" => ".webp",
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/avif" => ".avif",
        _ => "",
    }
}

async fn upload_cover(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    headers: HeaderMap,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Response {
    let admin_id = match require_admin(&u) {
        Ok(a) => a.id,
        Err(r) => return r,
    };
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };

    // Field name is "file" (single image).
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut original_name = String::from("upload");
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            original_name = field
                .file_name()
                .unwrap_or("upload")
                .to_string();
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
    let Some(mime) = sniff_image(&bytes) else {
        return bad(
            "File type not allowed. Accepted: image/webp, image/png, image/jpeg, image/avif",
        );
    };

    // Verify the post exists before dropping bytes on disk.
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM blog_posts WHERE id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => return internal("lookup", e),
    }

    let stored = format!("{}{}", uuid::Uuid::new_v4(), ext_for_mime(mime));
    let root = upload_root();
    let post_dir = format!("{root}/blog/{post_id}");
    let full_path = format!("{post_dir}/{stored}");
    let bytes_len = bytes.len();
    let write_res = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&post_dir).and_then(|_| std::fs::write(&full_path, &bytes))
    })
    .await;
    if write_res.map(|r| r.is_err()).unwrap_or(true) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store file");
    }

    // Delete previous cover (one row per (post, 'cover')). Non-fatal.
    let prev: Vec<String> = ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT stored_filename FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'",
            vec![post_id.into()],
        ))
        .await
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.try_get::<String>("", "stored_filename").ok())
                .collect()
        })
        .unwrap_or_default();
    for name in &prev {
        let p = format!("{root}/blog/{post_id}/{name}");
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&p)).await;
    }
    let _ = ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'",
            vec![post_id.into()],
        ))
        .await;

    let inserted = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO blog_attachments (post_id, original_filename, stored_filename, mime_type, size_bytes, purpose, uploaded_by) VALUES ($1,$2,$3,$4,$5,'cover',$6) RETURNING id, post_id, original_filename, stored_filename, mime_type, size_bytes, purpose, uploaded_at",
            vec![
                post_id.into(),
                original_name.clone().into(),
                stored.clone().into(),
                mime.to_string().into(),
                (bytes_len as i64).into(),
                admin_id.into(),
            ],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return internal("insert", "insert returned nothing"),
        Err(e) => {
            let p = format!("{root}/blog/{post_id}/{stored}");
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&p)).await;
            return internal("insert", e);
        }
    };

    let public_url = format!("{}/api/public/blog/attachments/{stored}", public_base(&headers));
    // Non-fatal: the file is uploaded and the URL returned either way.
    let _ = ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE blog_posts SET cover_image_url = $1 WHERE id = $2",
            vec![public_url.clone().into(), post_id.into()],
        ))
        .await;

    let uploaded_at: chrono::DateTime<chrono::Utc> =
        inserted.try_get("", "uploaded_at").unwrap_or_else(|_| chrono::Utc::now());
    (
        StatusCode::CREATED,
        Json(json!({
            "id": inserted.try_get::<i64>("", "id").unwrap_or(0),
            "postId": post_id,
            "originalFilename": original_name,
            "storedFilename": stored,
            "mimeType": mime,
            "sizeBytes": bytes_len,
            "purpose": "cover",
            "uploadedAt": iso(uploaded_at),
            "url": public_url,
        })),
    )
        .into_response()
}

async fn delete_cover(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let root = upload_root();
    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT stored_filename FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("lookup", e),
    };
    for r in &rows {
        if let Ok(name) = r.try_get::<String>("", "stored_filename") {
            let p = format!("{root}/blog/{post_id}/{name}");
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&p)).await;
        }
    }
    if let Err(e) = ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'",
            vec![post_id.into()],
        ))
        .await
    {
        return internal("delete", e);
    }
    // NULL the cover URL even if the post row is gone — harmless.
    let _ = ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE blog_posts SET cover_image_url = NULL WHERE id = $1",
            vec![post_id.into()],
        ))
        .await;
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/blog")
        .add("/{id}/cover", post(upload_cover))
        .add("/{id}/cover", delete(delete_cover))
}
