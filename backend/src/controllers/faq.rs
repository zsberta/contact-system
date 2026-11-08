//! Admin CRUD for FAQ items. Port of old_backend/routes/faq.js.
//!
//! Routes (under /api/faq, auth required; mutations admin-only):
//!   GET    /api/faq                  - paged list (endusers scoped)
//!   GET    /api/faq/:id              - single item
//!   POST   /api/faq                  - create (+ module registry)
//!   PUT    /api/faq/:id              - partial update (projectId immutable)
//!   DELETE /api/faq/:id              - hard delete (+ registry cleanup)
//!   POST   /api/faq/:id/publish      - flip to published
//!   POST   /api/faq/:id/unpublish    - flip to draft
//!
//! Simplifications vs the Express original:
//!   - Activity logging skipped (no shared helper in the Rust port yet).
//!   - Public-cache invalidation is a no-op: the Rust public surface
//!     (faq_public.rs) carries no in-memory cache, so there is nothing
//!     to invalidate.
//!   - Mutations allow scoped enduser writes (mirrors requireAuth +
//!     requireProjectAccess): admins bypass; endusers need the target
//!     project in their assignments else 403 "Access denied to this project".

use std::collections::HashMap;

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, scoped_project_ids};

/// Enduser project gate (mirrors requireProjectAccess in faq.js).
fn deny_unscoped(user: &CurrentUser, project_id: i64) -> Option<Response> {
    if user.role != "admin" && !user.project_ids.contains(&project_id) {
        Some(err(
            StatusCode::FORBIDDEN,
            "Access denied to this project",
        ))
    } else {
        None
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[faq/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|n| *n > 0)
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

const TEXT_MAX: usize = 50000;
// No-op: the Rust public surface keeps no in-memory cache.
fn invalidate_faq_cache(_project_id: i64) {}

fn first<'a>(q: &'a HashMap<String, Vec<String>>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| q.get(*k))
        .and_then(|v| v.first())
        .map(|s| s.as_str())
}

fn scoped_clause(scoped: &Option<Vec<i64>>, params: &mut Vec<sea_orm::Value>) -> String {
    match scoped {
        None => String::new(),
        Some(ids) => {
            use sea_orm::sea_query::{ArrayType, Value as QV};
            params.push(QV::Array(
                ArrayType::BigInt,
                Some(Box::new(ids.iter().map(|x| QV::BigInt(Some(*x))).collect())),
            ));
            format!("f.project_id = ANY(${}::bigint[])", params.len())
        }
    }
}

fn dto_from_row(r: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let created: chrono::DateTime<chrono::Utc> = r.try_get("", "created_at")?;
    let updated: chrono::DateTime<chrono::Utc> = r.try_get("", "updated_at")?;
    let created_by: Option<i32> = r.try_get("", "created_by").ok().flatten();
    Ok(json!({
        "id": r.try_get::<i64>("", "id")?,
        "projectId": r.try_get::<i64>("", "project_id")?,
        "projectName": r.try_get::<Option<String>>("", "project_name")?,
        "questionHu": r.try_get::<String>("", "question_hu")?,
        "answerHu": r.try_get::<String>("", "answer_hu")?,
        "questionEn": r.try_get::<String>("", "question_en")?,
        "answerEn": r.try_get::<String>("", "answer_en")?,
        "sortOrder": r.try_get::<i32>("", "sort_order")?,
        "status": r.try_get::<String>("", "status")?,
        "createdAt": iso(created),
        "updatedAt": iso(updated),
        "createdBy": created_by.map(|n| n as i64),
    }))
}

struct ValidFaq {
    out: HashMap<String, serde_json::Value>,
}

fn body_get<'a>(
    body: &'a serde_json::Value,
    camel: &str,
    snake: &str,
) -> Option<&'a serde_json::Value> {
    body.get(camel).or_else(|| body.get(snake))
}

fn validate_faq(body: &serde_json::Value, partial: bool) -> Result<ValidFaq, String> {
    let mut out: HashMap<String, serde_json::Value> = HashMap::new();
    let mut errors: Vec<String> = vec![];

    match body_get(body, "projectId", "project_id") {
        Some(v) => {
            if partial {
                errors.push("projectId cannot be changed".to_string());
            } else {
                let n = v
                    .as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()));
                match n {
                    Some(n) if n > 0 => {
                        out.insert("project_id".to_string(), json!(n));
                    }
                    _ => errors.push("projectId must be a positive integer".to_string()),
                }
            }
        }
        None => {
            if !partial {
                errors.push("projectId is required".to_string());
            }
        }
    }

    for (camel, snake, required) in [
        ("questionHu", "question_hu", true),
        ("answerHu", "answer_hu", true),
        ("questionEn", "question_en", false),
        ("answerEn", "answer_en", false),
    ] {
        match body_get(body, camel, snake) {
            Some(v) => match v.as_str() {
                Some(s) => {
                    let t = s.trim();
                    if required && (t.is_empty() || t.len() > TEXT_MAX) {
                        errors.push(format!("{camel} must be 1..{TEXT_MAX} chars"));
                    } else {
                        out.insert(snake.to_string(), json!(t));
                    }
                }
                None => errors.push(format!("{camel} must be a string")),
            },
            None => {
                if !partial {
                    if required {
                        errors.push(format!("{camel} is required"));
                    } else {
                        out.insert(snake.to_string(), json!(""));
                    }
                }
            }
        }
    }

    match body_get(body, "sortOrder", "sort_order") {
        Some(v) => {
            let n = v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()));
            match n {
                Some(n) => {
                    out.insert("sort_order".to_string(), json!(n as i32));
                }
                None => errors.push("sortOrder must be a number".to_string()),
            }
        }
        None => {
            if !partial {
                out.insert("sort_order".to_string(), json!(0));
            }
        }
    }

    match body.get("status") {
        Some(v) => match v.as_str() {
            Some(s) if ["draft", "published"].contains(&s) => {
                out.insert("status".to_string(), json!(s));
            }
            _ => errors.push("status must be one of: draft, published".to_string()),
        },
        None => {
            if !partial {
                out.insert("status".to_string(), json!("draft"));
            }
        }
    }

    if errors.is_empty() {
        Ok(ValidFaq { out })
    } else {
        Err(errors.join(", "))
    }
}

async fn ensure_module(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
) -> Result<i64, sea_orm::DbErr> {
    if let Some(r) = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO project_modules (project_id, module_type) VALUES ($1, 'faq') ON CONFLICT (project_id, module_type) DO NOTHING RETURNING id",
            vec![project_id.into()],
        ))
        .await?
    {
        return Ok(r.try_get("", "id")?);
    }
    let r = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'faq'",
            vec![project_id.into()],
        ))
        .await?
        .ok_or(sea_orm::DbErr::RecordNotFound(
            "faq module registry missing".to_string(),
        ))?;
    Ok(r.try_get("", "id")?)
}

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> impl IntoResponse {
    let page = first(&q, &["page"])
        .and_then(|s| s.parse().ok())
        .map(|n: i64| n.max(0))
        .unwrap_or(0);
    let size = first(&q, &["size"])
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| n.clamp(1, 100))
        .unwrap_or(10);
    let sort_field = first(&q, &["sortField"]).unwrap_or("sort_order");
    let descending = first(&q, &["sortOrder"]) != Some("asc");
    let scoped = scoped_project_ids(&user);

    let sort_col = match sort_field {
        "id" => "id",
        "questionHu" => "question_hu",
        "questionEn" => "question_en",
        "sortOrder" => "sort_order",
        "status" => "status",
        "createdAt" => "created_at",
        "updatedAt" => "updated_at",
        _ => "sort_order",
    };
    let dir = if descending { "DESC" } else { "ASC" };

    let mut conds: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    let scope_sql = scoped_clause(&scoped, &mut params);
    if !scope_sql.is_empty() {
        conds.push(scope_sql);
    }
    if let Some(pid) = first(&q, &["projectId", "project_id"])
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
    {
        params.push(pid.into());
        conds.push(format!("f.project_id = ${}", params.len()));
    }
    if let Some(s) = first(&q, &["status"]) {
        if !["draft", "published"].contains(&s) {
            return bad("Invalid status");
        }
        params.push(s.to_string().into());
        conds.push(format!("f.status = ${}", params.len()));
    }
    let queries: Vec<String> = q
        .get("queries")
        .map(|v| {
            v.iter()
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let conj = if first(&q, &["filterType"]) == Some("all") {
        " AND "
    } else {
        " OR "
    };
    let mut parts = vec![];
    for term in &queries {
        params.push(format!("%{term}%").into());
        let ph = format!("${}", params.len());
        parts.push(format!(
            "(f.question_hu ILIKE {ph} OR f.answer_hu ILIKE {ph} OR f.question_en ILIKE {ph} OR f.answer_en ILIKE {ph})"
        ));
    }
    if !parts.is_empty() {
        conds.push(parts.join(conj));
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let offset = page * size;

    let total: i64 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!("SELECT COUNT(*)::int AS total FROM faq_items f {where_sql}"),
            params.clone(),
        ))
        .await
    {
        Ok(Some(r)) => r.try_get::<i32>("", "total").map(|n| n as i64).unwrap_or(0),
        Ok(None) => 0,
        Err(e) => return internal("list", e),
    };
    let total_pages = ((total.max(0) as f64) / (size as f64)).ceil() as i64;
    let total_pages = total_pages.max(1);
    let mut dparams = params;
    dparams.push(size.into());
    dparams.push(offset.into());
    let lp = dparams.len() - 1;
    let op = dparams.len();
    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!(
                "SELECT f.*, p.name AS project_name FROM faq_items f LEFT JOIN projects p ON p.id = f.project_id {where_sql} ORDER BY {sort_col} {dir}, id DESC LIMIT ${lp} OFFSET ${op}"
            ),
            dparams,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("list", e),
    };
    let mut content = vec![];
    for r in &rows {
        match dto_from_row(r) {
            Ok(d) => content.push(d),
            Err(e) => return internal("list", e),
        }
    }
    (
        StatusCode::OK,
        Json(json!({
            "content": content,
            "totalElements": total,
            "totalPages": total_pages,
            "number": page,
            "size": size,
            "first": page == 0,
            "last": page >= total_pages - 1,
            "empty": total == 0,
            "numberOfElements": content.len(),
            "sort": { "sorted": true, "unsorted": false, "empty": false },
            "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": true, "unsorted": false, "empty": false } },
        })),
    )
        .into_response()
}

async fn get_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(fid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT f.*, p.name AS project_name FROM faq_items f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = $1",
            vec![fid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("get", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    };
    if user.role != "admin" && !user.project_ids.contains(&r.try_get::<i64>("", "project_id").unwrap_or(0)) {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    }
    match dto_from_row(&r) {
        Ok(d) => (StatusCode::OK, Json(d)).into_response(),
        Err(e) => internal("get", e),
    }
}

async fn create(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let body = if body.is_object() { body } else { json!({}) };
    let v = match validate_faq(&body, false) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    let project_id = v.out["project_id"].as_i64().unwrap();
    if let Some(r) = deny_unscoped(&user, project_id) {
        return r;
    }
    let module_id = match ensure_module(&ctx.db, project_id).await {
        Ok(m) => m,
        Err(e) => return internal("create", e),
    };
    let str_val = |k: &str| -> sea_orm::Value {
        v.out
            .get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
            .into()
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO faq_items (project_id, module_id, question_hu, answer_hu, question_en, answer_en, sort_order, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            vec![
                project_id.into(),
                module_id.into(),
                str_val("question_hu"),
                str_val("answer_hu"),
                str_val("question_en"),
                str_val("answer_en"),
                (v.out.get("sort_order").and_then(|x| x.as_i64()).unwrap_or(0) as i32).into(),
                v.out.get("status").and_then(|x| x.as_str()).unwrap_or("draft").to_string().into(),
                user.id.into(),
            ],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return internal("create", "insert returned nothing"),
        Err(e) => return internal("create", e),
    };
    invalidate_faq_cache(project_id);
    match dto_from_row(&row) {
        Ok(d) => (StatusCode::CREATED, Json(d)).into_response(),
        Err(e) => internal("create", e),
    }
}

async fn update(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(fid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let body = if body.is_object() { body } else { json!({}) };
    let v = match validate_faq(&body, true) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    if v.out.is_empty() {
        return bad("No valid fields to update");
    }
    let existing = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT * FROM faq_items WHERE id = $1",
            vec![fid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("update", e),
    };
    let Some(prev) = existing else {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    };
    let project_id: i64 = prev.try_get("", "project_id").unwrap_or(0);
    if let Some(r) = deny_unscoped(&user, project_id) {
        return r;
    }
    let cols = ["question_hu", "answer_hu", "question_en", "answer_en", "sort_order", "status"];
    let mut sets: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    for col in cols {
        if let Some(x) = v.out.get(col) {
            let val: sea_orm::Value = if *col == *"sort_order" {
                (x.as_i64().unwrap_or(0) as i32).into()
            } else {
                x.as_str().unwrap_or("").to_string().into()
            };
            params.push(val);
            sets.push(format!("{col} = ${}", params.len()));
        }
    }
    params.push(fid.into());
    let wp = params.len();
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!("UPDATE faq_items SET {} WHERE id = ${wp} RETURNING *", sets.join(", ")),
            params,
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "FAQ item not found"),
        Err(e) => return internal("update", e),
    };
    invalidate_faq_cache(project_id);
    match dto_from_row(&row) {
        Ok(d) => (StatusCode::OK, Json(d)).into_response(),
        Err(e) => internal("update", e),
    }
}

async fn delete_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(fid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let existing = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT project_id, module_id FROM faq_items WHERE id = $1",
            vec![fid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("delete", e),
    };
    let Some(prev) = existing else {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    };
    let project_id: i64 = prev.try_get("", "project_id").unwrap_or(0);
    if let Some(r) = deny_unscoped(&user, project_id) {
        return r;
    }
    let module_id: Option<i64> = prev.try_get("", "module_id").ok().flatten();
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM faq_items WHERE id = $1",
            vec![fid.into()],
        ))
        .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            return err(StatusCode::NOT_FOUND, "FAQ item not found")
        }
        Ok(_) => {}
        Err(e) => return internal("delete", e),
    }
    if let Some(mid) = module_id {
        let left: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT COUNT(*)::int AS c FROM faq_items WHERE module_id = $1",
                vec![mid.into()],
            ))
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i32>("", "c").ok())
            .unwrap_or(1) as i64;
        if left == 0 {
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "DELETE FROM project_modules WHERE id = $1",
                    vec![mid.into()],
                ))
                .await;
        }
    }
    invalidate_faq_cache(project_id);
    StatusCode::NO_CONTENT.into_response()
}

async fn set_status(
    ctx: &AppContext,
    fid: i64,
    status: &str,
) -> Result<sea_orm::QueryResult, sea_orm::DbErr> {
    ctx.db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE faq_items SET status = $1 WHERE id = $2 RETURNING *",
            vec![status.to_string().into(), fid.into()],
        ))
        .await
        .map(|r| r.ok_or(sea_orm::DbErr::RecordNotFound("FAQ item not found".to_string())))?
}

async fn publish(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(fid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let proj: Option<i64> = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT project_id FROM faq_items WHERE id = $1",
            vec![fid.into()],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("", "project_id").ok());
    let Some(project_id) = proj else {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    };
    if let Some(r) = deny_unscoped(&user, project_id) {
        return r;
    };
    match set_status(&ctx, fid, "published").await {
        Ok(r) => {
            invalidate_faq_cache(project_id);
            match dto_from_row(&r) {
                Ok(d) => (StatusCode::OK, Json(d)).into_response(),
                Err(e) => internal("publish", e),
            }
        }
        Err(sea_orm::DbErr::RecordNotFound(_)) => {
            err(StatusCode::NOT_FOUND, "FAQ item not found")
        }
        Err(e) => internal("publish", e),
    }
}

async fn unpublish(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(fid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let proj: Option<i64> = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT project_id FROM faq_items WHERE id = $1",
            vec![fid.into()],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("", "project_id").ok());
    let Some(project_id) = proj else {
        return err(StatusCode::NOT_FOUND, "FAQ item not found");
    };
    if let Some(r) = deny_unscoped(&user, project_id) {
        return r;
    };
    match set_status(&ctx, fid, "draft").await {
        Ok(r) => {
            invalidate_faq_cache(project_id);
            match dto_from_row(&r) {
                Ok(d) => (StatusCode::OK, Json(d)).into_response(),
                Err(e) => internal("unpublish", e),
            }
        }
        Err(sea_orm::DbErr::RecordNotFound(_)) => {
            err(StatusCode::NOT_FOUND, "FAQ item not found")
        }
        Err(e) => internal("unpublish", e),
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/faq")
        .add("/", get(list))
        .add("/", post(create))
        .add("/:id", get(get_one))
        .add("/:id", put(update))
        .add("/:id", delete(delete_one))
        .add("/:id/publish", post(publish))
        .add("/:id/unpublish", post(unpublish))
}
