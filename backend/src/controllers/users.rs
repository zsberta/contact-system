//! Port of old_backend/routes/users.js.
//!
//! Admin-only CRUD for the users table plus the enduser invite flow:
//!   GET    /api/users
//!   GET    /api/users/{id}            (includes projectIds)
//!   POST   /api/users                 (admin: password required; enduser: invite issued)
//!   PUT    /api/users/{id}
//!   DELETE /api/users/{id}            (refuses to delete the last enabled user)
//!   POST   /api/users/{id}/invite     (new invite supersedes prior ones)
//!   DELETE /api/users/{id}/invite     (revoke outstanding invites)
//!   PUT    /api/users/{id}/projects          (replace assignment set)
//!   POST   /api/users/{id}/projects          (add one, idempotent)
//!   DELETE /api/users/{id}/projects/{pid}    (remove one, idempotent)

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::middleware::auth::{require_admin, MaybeUser};
use crate::middleware::query::MultiQuery;

const INVITE_TTL_SEC: i64 = 24 * 60 * 60; // 24 hours

const PASSWORD_DENY: &[&str] = &["changeme", "changeme123", "admin", "password", "12345678", "qwerty", "letmein"];

fn bcrypt_cost() -> u32 {
    std::env::var("BCRYPT_COST").ok().and_then(|v| v.parse().ok()).unwrap_or(12)
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    const H: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(s.as_bytes()) {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0xf) as usize] as char);
    }
    out
}

fn rand_hex(nbytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; nbytes];
    rand::thread_rng().fill_bytes(&mut buf);
    const H: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(nbytes * 2);
    for b in buf {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0xf) as usize] as char);
    }
    out
}

fn is_unique_violation(e: &sea_orm::DbErr) -> bool {
    format!("{e:?}").contains("23505")
}

fn public_url() -> String {
    std::env::var("APP_PUBLIC_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "http://localhost:3000".to_string())
}

/// Best-effort invite email (never fails the request). Port of the old
/// `renderInvite` + `sendMail` pair in `old_backend/routes/users.js`, routed
/// through the paced queue instead of a direct send.
fn send_invite_email(to: &str, name: Option<&str>, link: &str, is_reinvite: bool) {
    let rendered = crate::mailers::templates::render_invite(
        crate::mailers::templates::InviteParams {
            user_name: name,
            invite_link: link,
            is_reinvite,
        },
    );
    crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
        to: to.to_string(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        from_name: None,
        from_address: None,
    });
}

fn row_to_dto(r: &sea_orm::QueryResult, project_ids: Vec<i64>) -> serde_json::Value {
    let created: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "created_at").ok();
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "firstName": r.try_get::<Option<String>>("", "first_name").ok().flatten(),
        "lastName": r.try_get::<Option<String>>("", "last_name").ok().flatten(),
        "email": r.try_get::<Option<String>>("", "email").ok().flatten().unwrap_or_default(),
        "enabled": r.try_get::<bool>("", "enabled").unwrap_or(true),
        "role": r.try_get::<Option<String>>("", "role").ok().flatten().unwrap_or_else(|| "admin".to_string()),
        "mustSetPassword": r.try_get::<Option<bool>>("", "must_set_password").ok().flatten().unwrap_or(false),
        "createdAt": created.map(|t| t.to_rfc3339()),
        "projectIds": project_ids,
    })
}

async fn project_ids_of(db: &sea_orm::DatabaseConnection, user_id: i64) -> Vec<i64> {
    db.query_all_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT project_id FROM user_project_assignments WHERE user_id = $1 ORDER BY project_id ASC",
        vec![user_id.into()],
    ))
    .await
    .map(|rows| rows.iter().filter_map(|r| r.try_get::<i64>("", "project_id").ok()).collect())
    .unwrap_or_default()
}

fn one(q: &HashMap<String, Vec<String>>, k: &str) -> Option<String> {
    q.get(k).and_then(|v| v.last()).cloned().filter(|s| !s.is_empty())
}

fn sortable_col(field: &str) -> &'static str {
    match field {
        "id" => "id",
        "firstName" => "first_name",
        "lastName" => "last_name",
        "email" => "email",
        "createdAt" => "created_at",
        "enabled" => "enabled",
        "role" => "role",
        _ => "created_at",
    }
}

async fn list(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let page: i64 = one(&q, "page").and_then(|v| v.parse().ok()).unwrap_or(0).max(0);
    let size: i64 = one(&q, "size").and_then(|v| v.parse().ok()).unwrap_or(10).clamp(1, 100);
    let sort_field = one(&q, "sortField").unwrap_or_else(|| "createdAt".to_string());
    let sort_order = one(&q, "sortOrder").unwrap_or_default();
    let filter_any = one(&q, "filterType").as_deref() != Some("all");
    let mut terms: Vec<String> = Vec::new();
    for k in ["queries", "queries[]"] {
        if let Some(v) = q.get(k) {
            for t in v {
                let t = t.trim().to_string();
                if !t.is_empty() {
                    terms.push(t);
                }
            }
        }
    }
    let role_filter = one(&q, "role").filter(|r| r == "admin" || r == "enduser");

    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<sea_orm::Value> = Vec::new();
    if !terms.is_empty() {
        let joiner = if filter_any { " OR " } else { " AND " };
        let mut clauses = Vec::new();
        for t in &terms {
            let ph = format!("${}", params.len() + 1);
            params.push(format!("%{t}%").into());
            let ors = ["email", "first_name", "last_name"]
                .iter()
                .map(|c| format!("{c} ILIKE {ph}"))
                .collect::<Vec<_>>()
                .join(" OR ");
            clauses.push(format!("({ors})"));
        }
        conds.push(format!("({})", clauses.join(joiner)));
    }
    if let Some(role) = role_filter {
        let ph = format!("${}", params.len() + 1);
        params.push(role.into());
        conds.push(format!("role = {ph}"));
    }
    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let dir = if sort_order == "asc" { "ASC" } else { "DESC" };
    let order = format!("ORDER BY {} {dir}, id DESC", sortable_col(&sort_field));
    let offset = page * size;

    let count_sql = format!("SELECT COUNT(*)::int AS total FROM users {where_sql}");
    let total: i32 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &count_sql,
            params.clone(),
        ))
        .await
    {
        Ok(Some(r)) => r.try_get("", "total").unwrap_or(0),
        _ => {
            tracing::error!("[users/list] count query failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response();
        }
    };
    let data_sql = format!(
        "SELECT id, first_name, last_name, email, enabled, role, must_set_password, created_at
         FROM users {where_sql} {order} LIMIT ${} OFFSET ${}",
        params.len() + 1,
        params.len() + 2
    );
    let mut dparams = params;
    dparams.push(size.into());
    dparams.push(offset.into());
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &data_sql,
            dparams,
        ))
        .await
    {
        Ok(rows) => {
            let content: Vec<_> = rows.iter().map(|r| row_to_dto(r, vec![])).collect();
            let total_pages = if total <= 0 { 1 } else { ((total as i64 + size - 1) / size).max(1) };
            let sorted = q.contains_key("sortField");
            (
                StatusCode::OK,
                Json(json!({
                    "totalPages": total_pages,
                    "totalElements": total,
                    "pageable": { "paged": true, "pageSize": size, "pageNumber": page,
                        "unpaged": false, "offset": offset,
                        "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                    "numberOfElements": content.len(),
                    "size": size,
                    "content": content,
                    "number": page,
                    "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                    "first": page == 0,
                    "last": page == total_pages - 1,
                    "empty": content.is_empty(),
                })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("[users/list] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response()
        }
    }
}

async fn get_one(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response();
        }
    };
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, first_name, last_name, email, enabled, role, must_set_password, created_at
             FROM users WHERE id = $1",
            vec![user_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => {
            let pids = project_ids_of(&ctx.db, user_id).await;
            (StatusCode::OK, Json(row_to_dto(&r, pids))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response(),
        Err(e) => {
            tracing::error!("[users/get] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

fn valid_name(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if !s.is_empty() && s.len() <= 50)
}

async fn create(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Json(b): Json<Value>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    if !valid_name(b.get("firstName")) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid first name" }))).into_response();
    }
    if !valid_name(b.get("lastName")) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid last name" }))).into_response();
    }
    let email = b.get("email").and_then(|v| v.as_str()).unwrap_or("");
    if email.is_empty() || email.len() > 255 || !email.contains('@') {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid email" }))).into_response();
    }
    let role = if b.get("role").and_then(|v| v.as_str()) == Some("enduser") { "enduser" } else { "admin" };

    if role == "admin" {
        match b.get("password").and_then(|v| v.as_str()) {
            Some(pw) if pw.len() >= 8 && !PASSWORD_DENY.contains(&pw.to_lowercase().as_str()) => {}
            Some(_) => {
                let msg = if b.get("password").and_then(|v| v.as_str()).map(|p| p.len()).unwrap_or(0) < 8 {
                    "Password must be at least 8 characters"
                } else {
                    "Password is too weak"
                };
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": msg }))).into_response();
            }
            None => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Password must be at least 8 characters" }))).into_response();
            }
        }
    } else if let Some(pw) = b.get("password").and_then(|v| v.as_str()) {
        if !pw.is_empty() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Endusers are created via the invite flow — leave password empty" }))).into_response();
        }
    }

    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[users/create] begin {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    let res: std::result::Result<(serde_json::Value, Option<String>, String, Option<String>), sea_orm::DbErr> = (async {
        let (password_hash, must_set): (Option<String>, bool) = if role == "admin" {
            let pw = b.get("password").and_then(|v| v.as_str()).unwrap_or("");
            let hash = bcrypt::hash(pw, bcrypt_cost()).map_err(|e| sea_orm::DbErr::Custom(e.to_string()))?;
            (Some(hash), false)
        } else {
            (None, true)
        };
        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO users (email, password_hash, first_name, last_name, enabled, role, must_set_password)
                 VALUES ($1, $2, $3, $4, true, $5, $6)
                 RETURNING id, first_name, last_name, email, enabled, role, must_set_password, created_at",
                vec![
                    email.to_lowercase().into(),
                    password_hash.into(),
                    b.get("firstName").and_then(|v| v.as_str()).unwrap_or("").to_string().into(),
                    b.get("lastName").and_then(|v| v.as_str()).unwrap_or("").to_string().into(),
                    role.to_string().into(),
                    must_set.into(),
                ],
            ))
            .await?;
        let r = row.ok_or_else(|| sea_orm::DbErr::Custom("insert returned no row".to_string()))?;
        let uid: i64 = r.try_get("", "id")?;
        let mut invite_token: Option<String> = None;
        if role == "enduser" {
            let plain = rand_hex(32);
            let thash = sha256_hex(&plain);
            txn.execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO invite_tokens (user_id, token_hash, expires_at)
                 VALUES ($1, $2, now() + ($3 || ' seconds')::interval)",
                vec![uid.into(), thash.into(), INVITE_TTL_SEC.to_string().into()],
            ))
            .await?;
            invite_token = Some(plain);
        }
        txn.commit().await?;
        Ok((r, invite_token))
    })
    .await
    .map(|(r, invite_token)| {
        let mut dto = row_to_dto(&r, vec![]);
        if let Some(t) = invite_token.clone() {
            dto["inviteToken"] = json!(t);
        }
        (dto, invite_token, r.try_get::<Option<String>>("", "email").ok().flatten().unwrap_or_default(), r.try_get::<Option<String>>("", "first_name").ok().flatten())
    });

    match res {
        Ok((dto, invite_token, email_s, first_name)) => {
            // Best-effort invite email after commit (never rolls back the create).
            if let Some(plain) = invite_token {
                let link = format!("{}/set-password?token={plain}", public_url());
                send_invite_email(&email_s, first_name.as_deref(), &link, false);
            }
            (StatusCode::CREATED, Json(dto)).into_response()
        }
        Err(e) => {
            if is_unique_violation(&e) {
                return (StatusCode::CONFLICT, Json(json!({ "errorMessage": "Email already exists" }))).into_response();
            }
            tracing::error!("[users/create] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn update(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<Value>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    if !valid_name(b.get("firstName")) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid first name" }))).into_response();
    }
    if !valid_name(b.get("lastName")) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid last name" }))).into_response();
    }
    let email = b.get("email").and_then(|v| v.as_str()).unwrap_or("");
    if email.is_empty() || email.len() > 255 || !email.contains('@') {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid email" }))).into_response();
    }
    if let Some(role) = b.get("role").and_then(|v| v.as_str()) {
        if role != "admin" && role != "enduser" {
            return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid role" }))).into_response();
        }
    }
    let mut password_hash: Option<String> = None;
    if let Some(pw) = b.get("password").and_then(|v| v.as_str()) {
        if !pw.is_empty() {
            if pw.len() < 8 {
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Password must be at least 8 characters" }))).into_response();
            }
            if PASSWORD_DENY.contains(&pw.to_lowercase().as_str()) {
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Password is too weak" }))).into_response();
            }
            password_hash = match bcrypt::hash(pw, bcrypt_cost()) {
                Ok(h) => Some(h),
                Err(e) => {
                    tracing::error!("[users/update] hash {e:?}");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
                }
            };
        }
    }
    let enabled = b.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

    let mut sets: Vec<String> = vec![
        "first_name = $2".into(),
        "last_name = $3".into(),
        "email = $4".into(),
        "enabled = $5".into(),
        "updated_at = now()".into(),
    ];
    let first = b.get("firstName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let last = b.get("lastName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut params: Vec<sea_orm::Value> = vec![user_id.into(), first.into(), last.into(), email.to_lowercase().into(), enabled.into()];
    if let Some(h) = password_hash {
        sets.push(format!("password_hash = ${}", params.len() + 1));
        params.push(h.into());
    }
    if let Some(role) = b.get("role").and_then(|v| v.as_str()) {
        sets.push(format!("role = ${}", params.len() + 1));
        params.push(role.to_string().into());
    }
    let sql = format!(
        "UPDATE users SET {} WHERE id = $1
         RETURNING id, first_name, last_name, email, enabled, role, must_set_password, created_at",
        sets.join(", ")
    );
    match ctx.db.query_one_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, &sql, params)).await {
        Ok(Some(r)) => {
            let pids = project_ids_of(&ctx.db, user_id).await;
            (StatusCode::OK, Json(row_to_dto(&r, pids))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response(),
        Err(e) => {
            if is_unique_violation(&e) {
                return (StatusCode::CONFLICT, Json(json!({ "errorMessage": "Email already exists" }))).into_response();
            }
            tracing::error!("[users/update] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn remove_user(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[users/delete] begin {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    let res: Result<Response> = (async {
        let target = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, email, enabled FROM users WHERE id = $1 FOR UPDATE",
                vec![user_id.into()],
            ))
            .await?;
        let Some(t) = target else {
            txn.rollback().await.ok();
            return Ok((StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response());
        };
        if t.try_get::<bool>("", "enabled").unwrap_or(false) {
            let count: i32 = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT COUNT(*)::int AS total FROM users WHERE enabled = true",
                    vec![],
                ))
                .await?
                .and_then(|r| r.try_get("", "total").ok())
                .unwrap_or(0);
            if count <= 1 {
                txn.rollback().await.ok();
                return Ok((StatusCode::CONFLICT, Json(json!({ "errorMessage": "Cannot delete the last enabled user" }))).into_response());
            }
        }
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
            vec![user_id.into()],
        ))
        .await?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            vec![user_id.into()],
        ))
        .await?;
        txn.commit().await?;
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[users/delete] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn invite(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, email, first_name, role FROM users WHERE id = $1",
            vec![user_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response(),
        Err(e) => {
            tracing::error!("[users/invite] lookup {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    if row.try_get::<Option<String>>("", "role").ok().flatten().as_deref() == Some("admin") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Admins cannot be re-invited" }))).into_response();
    }
    let email: String = row.try_get::<Option<String>>("", "email").ok().flatten().unwrap_or_default();
    let first_name: Option<String> = row.try_get::<Option<String>>("", "first_name").ok().flatten();
    let res: Result<String> = (async {
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE invite_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
            vec![user_id.into()],
        )).await?;
        let plain = rand_hex(32);
        let thash = sha256_hex(&plain);
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO invite_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + ($3 || ' seconds')::interval)",
            vec![user_id.into(), thash.into(), INVITE_TTL_SEC.to_string().into()],
        )).await?;
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE users SET must_set_password = true, updated_at = now() WHERE id = $1",
            vec![user_id.into()],
        )).await?;
        Ok(plain)
    })
    .await;
    match res {
        Ok(plain) => {
            let link = format!("{}/set-password?token={plain}", public_url());
            send_invite_email(&email, first_name.as_deref(), &link, true);
            let expires = (chrono::Utc::now() + chrono::Duration::seconds(INVITE_TTL_SEC)).to_rfc3339();
            (StatusCode::OK, Json(json!({ "inviteToken": plain, "expiresAt": expires }))).into_response()
        }
        Err(e) => {
            tracing::error!("[users/invite] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn revoke_invite(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE invite_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
            vec![user_id.into()],
        ))
        .await
    {
        Ok(res) => (StatusCode::OK, Json(json!({ "revoked": res.rows_affected() }))).into_response(),
        Err(e) => {
            tracing::error!("[users/invite/revoke] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn replace_projects(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<Value>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let arr = match b.get("projectIds").and_then(|v| v.as_array()) {
        Some(a) => a.clone(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "projectIds must be an array" }))).into_response(),
    };
    if arr.len() > 200 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "projectIds: maximum 200 entries" }))).into_response();
    }
    let mut cleaned: Vec<i64> = Vec::new();
    for p in &arr {
        let n = match p {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        };
        match n {
            Some(x) if x > 0 && !cleaned.contains(&x) => cleaned.push(x),
            _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "projectIds contains invalid id" }))).into_response(),
        }
    }
    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[users/assignments/replace] begin {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    let res: std::result::Result<Vec<i64>, sea_orm::DbErr> = (async {
        let exists = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM users WHERE id = $1",
                vec![user_id.into()],
            ))
            .await?
            .is_some();
        if !exists {
            txn.rollback().await.ok();
            return Err(sea_orm::DbErr::RecordNotFound("User not found".to_string()));
        }
        if !cleaned.is_empty() {
            // IDs are validated i64s — safe to interpolate for the IN list.
            let list = cleaned.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ");
            let found: i32 = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    &format!("SELECT COUNT(*)::int AS n FROM projects WHERE id IN ({list})"),
                    vec![],
                ))
                .await?
                .and_then(|r| r.try_get("", "n").ok())
                .unwrap_or(0);
            if found as usize != cleaned.len() {
                txn.rollback().await.ok();
                return Err(sea_orm::DbErr::Custom("One or more projectIds do not exist".to_string()));
            }
        }
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM user_project_assignments WHERE user_id = $1",
            vec![user_id.into()],
        ))
        .await?;
        for pid in &cleaned {
            txn.execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO user_project_assignments (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                vec![user_id.into(), (*pid).into()],
            ))
            .await?;
        }
        txn.commit().await?;
        Ok(cleaned.clone())
    })
    .await;
    match res {
        Ok(pids) => (StatusCode::OK, Json(json!({ "userId": user_id, "projectIds": pids }))).into_response(),
        Err(sea_orm::DbErr::RecordNotFound(_)) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response(),
        Err(sea_orm::DbErr::Custom(msg)) if msg == "One or more projectIds do not exist" => {
            (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": msg }))).into_response()
        }
        Err(e) => {
            tracing::error!("[users/assignments/replace] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn add_project(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<Value>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let pid: Option<i64> = match b.get("projectId") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    let pid = match pid {
        Some(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid projectId" }))).into_response(),
    };
    let res: Result<&str> = (async {
        let user_exists = ctx.db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres, "SELECT 1 AS one FROM users WHERE id = $1", vec![user_id.into()],
        )).await?.is_some();
        if !user_exists {
            return Ok("user");
        }
        let proj_exists = ctx.db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres, "SELECT 1 AS one FROM projects WHERE id = $1", vec![pid.into()],
        )).await?.is_some();
        if !proj_exists {
            return Ok("project");
        }
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO user_project_assignments (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            vec![user_id.into(), pid.into()],
        )).await?;
        Ok("ok")
    })
    .await;
    match res {
        Ok("ok") => StatusCode::NO_CONTENT.into_response(),
        Ok("user") => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "User not found" }))).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response(),
        Err(e) => {
            tracing::error!("[users/assignments/add] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn remove_project(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path((id, pid)): Path<(String, String)>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let user_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let proj_id: i64 = match pid.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid project id" }))).into_response(),
    };
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM user_project_assignments WHERE user_id = $1 AND project_id = $2",
            vec![user_id.into(), proj_id.into()],
        ))
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("[users/assignments/remove] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/users")
        .add("/", get(list))
        .add("/", post(create))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(remove_user))
        .add("/{id}/invite", post(invite))
        .add("/{id}/invite", delete(revoke_invite))
        .add("/{id}/projects", put(replace_projects))
        .add("/{id}/projects", post(add_project))
        .add("/{id}/projects/{pid}", delete(remove_project))
}
