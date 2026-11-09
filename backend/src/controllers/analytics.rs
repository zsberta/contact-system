//! Analytics admin module.
//!
//! One analytics_configs row per project (UNIQUE FK), created lazily via
//! GET /by-project/:projectId. Mutations reject endusers with 403.
//!   GET    /api/analytics
//!   GET    /api/analytics/by-project/:projectId
//!   GET    /api/analytics/:id
//!   PUT    /api/analytics/:id
//!   DELETE /api/analytics/:id
//!   GET    /api/analytics/:id/snippet
//!   GET    /api/analytics/:id/stats?days=

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use regex::Regex;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser};
use crate::middleware::query::MultiQuery;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn unauthorized() -> Response {
    err(StatusCode::UNAUTHORIZED, "Unauthorized")
}

fn deny_enduser_mutation(u: &Option<CurrentUser>) -> Option<Response> {
    match u {
        None => Some(unauthorized()),
        Some(x) if x.role == "enduser" => Some(err(
            StatusCode::FORBIDDEN,
            "Endusers have read-only access",
        )),
        _ => None,
    }
}

fn secret_token() -> String {
    use rand::RngCore;
    const ALPH: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    let mut out = String::with_capacity(22);
    let mut i = 0;
    while i < 16 {
        let b0 = buf[i] as u32;
        let b1 = if i + 1 < 16 { buf[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < 16 { buf[i + 2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        let rem = 16 - i;
        out.push(ALPH[((n >> 18) & 63) as usize] as char);
        out.push(ALPH[((n >> 12) & 63) as usize] as char);
        if rem > 1 {
            out.push(ALPH[((n >> 6) & 63) as usize] as char);
        }
        if rem > 2 {
            out.push(ALPH[(n & 63) as usize] as char);
        }
        i += 3;
    }
    out
}

fn iso(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ceil_div(a: i64, b: i64) -> i64 {
    ((a + b - 1) / b.max(1)).max(1)
}

// ---------------------------------------------------------------------------
// Allowed-origins validator (same semantics as forms — duplicated on purpose)
// ---------------------------------------------------------------------------

fn re_hostname() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$")
            .unwrap()
    })
}
fn re_scheme_hostname() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^https?://(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$")
            .unwrap()
    })
}
fn re_loopback_bare() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^localhost(:[0-9]{1,5})?$").unwrap())
}
fn re_loopback_ipv4() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$").unwrap()
    })
}
fn re_loopback_ipv6() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\[::1?\](:[0-9]{1,5})?$").unwrap())
}
fn re_loopback_scheme() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^https?://(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$")
            .unwrap()
    })
}

fn validate_allowed_origin(
    entry: &serde_json::Value,
    index: usize,
    seen: &mut HashSet<String>,
) -> Result<String, String> {
    let s = entry
        .as_str()
        .ok_or_else(|| format!("allowedOrigins[{index}]: must be a string"))?;
    let trimmed = s.trim().to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err(format!("allowedOrigins[{index}]: must be 1..253 chars"));
    }
    let is_bare = re_hostname().is_match(&trimmed);
    let is_scheme = re_scheme_hostname().is_match(&trimmed);
    let is_lb = re_loopback_bare().is_match(&trimmed)
        || re_loopback_ipv4().is_match(&trimmed)
        || re_loopback_ipv6().is_match(&trimmed);
    let is_lb_scheme = re_loopback_scheme().is_match(&trimmed);
    if !is_bare && !is_scheme && !is_lb && !is_lb_scheme {
        return Err(format!("allowedOrigins[{index}]: invalid origin"));
    }
    let normalised = if is_scheme || is_lb_scheme {
        trimmed
    } else {
        format!("https://{trimmed}")
    };
    if !seen.insert(normalised.clone()) {
        return Err(format!("allowedOrigins[{index}]: duplicate"));
    }
    Ok(normalised)
}

struct ValidatedConfig {
    project_id: Option<i64>,
    name: Option<String>,
    status: Option<String>,
    allowed_origins: Option<Vec<String>>,
}

/// Config body validator. POST path unused (creation is lazy), but the
/// strict branch is kept.
fn validate_config_body(
    body: &serde_json::Value,
    partial: bool,
) -> Result<ValidatedConfig, String> {
    let mut out = ValidatedConfig {
        project_id: None,
        name: None,
        status: None,
        allowed_origins: None,
    };
    let mut errors: Vec<String> = vec![];
    let get = |k1: &str, k2: &str| body.get(k1).or_else(|| body.get(k2));
    match get("projectId", "project_id") {
        Some(v) => {
            if partial {
                errors.push("projectId cannot be changed".to_string());
            } else {
                let n = v
                    .as_i64()
                    .or_else(|| v.as_str()?.parse::<i64>().ok());
                match n {
                    Some(n) if n > 0 => out.project_id = Some(n),
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
    match body.get("name") {
        Some(v) => match v.as_str() {
            Some(s) => {
                let t = s.trim();
                if t.is_empty() || t.len() > 200 {
                    errors.push("name must be 1..200 chars".to_string());
                } else {
                    out.name = Some(t.to_string());
                }
            }
            None => errors.push("name must be a string".to_string()),
        },
        None => {
            if !partial {
                errors.push("name is required".to_string());
            }
        }
    }
    if body.get("secretToken").is_some() || body.get("secret_token").is_some() {
        errors.push("secretToken cannot be set or changed".to_string());
    }
    match body.get("status") {
        Some(v) => match v.as_str() {
            Some(s) if s == "active" || s == "disabled" => {
                out.status = Some(s.to_string());
            }
            _ => errors.push("status must be one of active, disabled".to_string()),
        },
        None => {
            if !partial {
                out.status = Some("active".to_string());
            }
        }
    }
    match get("allowedOrigins", "allowed_origins") {
        Some(raw) => match raw.as_array() {
            Some(arr) => {
                if arr.len() > 100 {
                    errors.push("allowedOrigins: maximum 100 entries".to_string());
                } else {
                    let mut seen = HashSet::new();
                    let mut cleaned = vec![];
                    for (i, e) in arr.iter().enumerate() {
                        match validate_allowed_origin(e, i, &mut seen) {
                            Ok(v) => cleaned.push(v),
                            Err(e) => errors.push(e),
                        }
                    }
                    if errors.is_empty() {
                        out.allowed_origins = Some(cleaned);
                    }
                }
            }
            None => errors.push("allowedOrigins must be an array".to_string()),
        },
        None => {
            if !partial {
                out.allowed_origins = Some(vec![]);
            }
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors.join("; "))
    }
}

fn pg_text_array(items: &[String]) -> String {
    let inner: Vec<String> = items
        .iter()
        .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("{{{}}}", inner.join(","))
}

fn allowed_of(row: &sea_orm::QueryResult) -> Vec<String> {
    row.try_get::<Option<Vec<String>>>("", "allowed_origins")
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn scope_sql(ids: &[i64], alias: &str) -> String {
    if ids.is_empty() {
        return format!("{alias}.project_id = ANY(ARRAY[]::bigint[])");
    }
    let list = ids
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("{alias}.project_id = ANY(ARRAY[{list}]::bigint[])")
}

const CONFIG_SELECT: &str = "c.id, c.project_id, p.name AS project_name,
        c.name, c.secret_token, c.allowed_origins, c.status,
        c.created_at, c.updated_at";
const CONFIG_FROM: &str = "analytics_configs c JOIN projects p ON p.id = c.project_id";

fn row_to_dto(row: &sea_orm::QueryResult) -> serde_json::Value {
    let created: chrono::DateTime<chrono::Utc> = row
        .try_get("", "created_at")
        .unwrap_or_else(|_| chrono::Utc::now());
    let updated: chrono::DateTime<chrono::Utc> = row
        .try_get("", "updated_at")
        .unwrap_or_else(|_| chrono::Utc::now());
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": row.try_get::<Option<String>>("", "project_name").ok().flatten(),
        "name": row.try_get::<Option<String>>("", "name").ok().flatten().unwrap_or_default(),
        "secretToken": row.try_get::<Option<String>>("", "secret_token").ok().flatten().unwrap_or_default(),
        "allowedOrigins": allowed_of(row),
        "status": row.try_get::<Option<String>>("", "status").ok().flatten().unwrap_or_else(|| "active".to_string()),
        "createdAt": iso(&created),
        "updatedAt": iso(&updated),
    })
}

// ---------------------------------------------------------------------------
// GET /api/analytics — paginated list
// ---------------------------------------------------------------------------

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    let one = |k: &str| {
        q.get(k)
            .and_then(|v| v.first())
            .cloned()
            .unwrap_or_default()
    };
    let page: i64 = one("page").parse().unwrap_or(0).max(0);
    let size: i64 = one("size").parse().unwrap_or(10).clamp(1, 100);
    let sort_field = one("sortField");
    let sort_field = if sort_field.is_empty() {
        "createdAt"
    } else {
        Box::leak(sort_field.into_boxed_str()) as &str
    };
    let dir = if one("sortOrder") == "asc" { "ASC" } else { "DESC" };
    let mut queries: Vec<String> = q.get("queries").cloned().unwrap_or_default();
    if let Some(extra) = q.get("queries[]") {
        queries.extend(extra.clone());
    }
    let filter_type = one("filterType");
    let project_param = q
        .get("projectId")
        .or_else(|| q.get("project_id"))
        .and_then(|v| v.first())
        .cloned()
        .unwrap_or_default();

    let col = match sort_field {
        "id" => "c.id",
        "name" => "c.name",
        "status" => "c.status",
        "createdAt" => "c.created_at",
        "updatedAt" => "c.updated_at",
        _ => "c.created_at",
    };
    let mut conds: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    let mut next = 1i32;
    if let Ok(n) = project_param.parse::<i64>() {
        if n > 0 {
            conds.push(format!("c.project_id = ${next}"));
            params.push(n.into());
            next += 1;
        }
    }
    let terms: Vec<String> = queries
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !terms.is_empty() {
        let conj = if filter_type == "all" { " AND " } else { " OR " };
        let mut parts = vec![];
        for t in terms {
            parts.push(format!("(c.name ILIKE ${next})"));
            params.push(format!("%{t}%").into());
            next += 1;
        }
        conds.push(parts.join(conj));
    }
    if user.role == "enduser" {
        conds.push(scope_sql(&user.project_ids, "c"));
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let limit_p = next;
    let offset_p = next + 1;
    let order = format!("ORDER BY {col} {dir}, c.id DESC");

    let res: Result<Response, sea_orm::DbErr> = (async {
        let count_row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::int AS total FROM {CONFIG_FROM} {where_sql}"),
                params.clone(),
            ))
            .await?;
        let total: i32 = count_row
            .and_then(|r| r.try_get("", "total").ok())
            .unwrap_or(0);
        let mut dp = params.clone();
        dp.push(size.into());
        dp.push((page * size).into());
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT {CONFIG_SELECT} FROM {CONFIG_FROM}
                     {where_sql} {order} LIMIT ${limit_p} OFFSET ${offset_p}"
                ),
                dp,
            ))
            .await?;
        let content: Vec<serde_json::Value> = rows.iter().map(row_to_dto).collect();
        let total_pages = ceil_div(total as i64, size);
        let sorted = q.contains_key("sortField");
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages, "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false,
                              "offset": page * size,
                              "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                "numberOfElements": content.len(), "size": size, "content": content,
                "number": page,
                "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                "first": page == 0, "last": page == total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/analytics/by-project/:projectId — lazy upsert
// ---------------------------------------------------------------------------

async fn by_project(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(project_id): Path<i64>,
) -> Response {
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid project id");
    }
    if user.role == "enduser" && !user.project_ids.contains(&project_id) {
        return err(StatusCode::NOT_FOUND, "Analytics config not found");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, name FROM projects WHERE id = $1",
                vec![project_id.into()],
            ))
            .await?;
        let Some(pr) = proj else {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        };
        let project_name: String = pr
            .try_get::<Option<String>>("", "name")
            .ok()
            .flatten()
            .unwrap_or_default();
        let pm = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO project_modules (project_id, module_type)
                 VALUES ($1, 'analytics')
                 ON CONFLICT (project_id, module_type) DO NOTHING
                 RETURNING id",
                vec![project_id.into()],
            ))
            .await?;
        let module_id: i64 = match pm {
            Some(r) => r.try_get("", "id")?,
            None => {
                let ex = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'analytics'",
                        vec![project_id.into()],
                    ))
                    .await?;
                ex.and_then(|r| r.try_get("", "id").ok()).unwrap_or(0)
            }
        };
        let token = secret_token();
        let ins = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO analytics_configs (project_id, module_id, name, secret_token, allowed_origins, status)
                 VALUES ($1, $2, $3, $4, '{}', 'active')
                 ON CONFLICT (project_id) DO NOTHING
                 RETURNING id, project_id, name, secret_token, allowed_origins, status, created_at, updated_at",
                vec![
                    project_id.into(),
                    module_id.into(),
                    project_name.clone().into(),
                    token.into(),
                ],
            ))
            .await?;
        let row = match ins {
            Some(r) => r,
            None => {
                let ex = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT id, project_id, name, secret_token, allowed_origins, status, created_at, updated_at
                         FROM analytics_configs WHERE project_id = $1",
                        vec![project_id.into()],
                    ))
                    .await?;
                match ex {
                    Some(r) => r,
                    None => {
                        return Ok(err(StatusCode::CONFLICT, "Conflict, please retry"));
                    }
                }
            }
        };
        let mut dto = row_to_dto_raw(&row);
        dto["projectName"] = json!(project_name);
        Ok((StatusCode::OK, Json(dto)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/by-project] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// DTO for rows without the projects join (by-project fast path).
fn row_to_dto_raw(row: &sea_orm::QueryResult) -> serde_json::Value {
    let mut v = row_to_dto(row);
    if v.get("projectName").is_none() {
        v["projectName"] = serde_json::Value::Null;
    }
    v
}

// ---------------------------------------------------------------------------
// GET /api/analytics/:id
// ---------------------------------------------------------------------------

async fn scoped_config(
    db: &sea_orm::DatabaseConnection,
    user: &CurrentUser,
    id: i64,
) -> Result<Result<sea_orm::QueryResult, Response>, sea_orm::DbErr> {
    if user.role == "enduser" {
        let pre = db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT project_id FROM analytics_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        match pre {
            None => return Ok(Err(err(StatusCode::NOT_FOUND, "Analytics config not found"))),
            Some(r) => {
                let pid: i64 = r.try_get("", "project_id")?;
                if !user.project_ids.contains(&pid) {
                    return Ok(Err(err(
                        StatusCode::NOT_FOUND,
                        "Analytics config not found",
                    )));
                }
            }
        }
    }
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!("SELECT {CONFIG_SELECT} FROM {CONFIG_FROM} WHERE c.id = $1"),
            vec![id.into()],
        ))
        .await?;
    match row {
        Some(r) => Ok(Ok(r)),
        None => Ok(Err(err(
            StatusCode::NOT_FOUND,
            "Analytics config not found",
        ))),
    }
}

async fn get_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    match scoped_config(&ctx.db, &user, id).await {
        Ok(Ok(r)) => (StatusCode::OK, Json(row_to_dto(&r))).into_response(),
        Ok(Err(r)) => r,
        Err(e) => {
            tracing::error!("[analytics/get] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// PUT /api/analytics/:id
// ---------------------------------------------------------------------------

async fn update(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Some(r) = deny_enduser_mutation(&u) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let v = match validate_config_body(&body, true) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };
    let mut sets: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![id.into()];
    let mut n = 2i32;
    if let Some(name) = v.name {
        sets.push(format!("name = ${n}"));
        params.push(name.into());
        n += 1;
    }
    if let Some(status) = v.status {
        sets.push(format!("status = ${n}"));
        params.push(status.into());
        n += 1;
    }
    if let Some(origins) = v.allowed_origins {
        sets.push(format!("allowed_origins = ${n}::text[]"));
        params.push(pg_text_array(&origins).into());
        n += 1;
    }
    let _ = n;
    if sets.is_empty() {
        return err(StatusCode::BAD_REQUEST, "No updatable fields provided");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        sets.push("updated_at = now()".to_string());
        let upd = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("UPDATE analytics_configs SET {} WHERE id = $1", sets.join(", ")),
                params,
            ))
            .await;
        if let Err(e) = upd {
            let msg = format!("{e:?}");
            if msg.contains("23514") {
                return Ok(err(StatusCode::BAD_REQUEST, "Invalid field value"));
            }
            tracing::error!("[analytics/update] {e:?}");
            return Ok(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error",
            ));
        }
        let joined = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {CONFIG_SELECT} FROM {CONFIG_FROM} WHERE c.id = $1"),
                vec![id.into()],
            ))
            .await?;
        match joined {
            Some(r) => Ok((StatusCode::OK, Json(row_to_dto(&r))).into_response()),
            None => Ok(err(StatusCode::NOT_FOUND, "Analytics config not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/update] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/analytics/:id — hard delete (CASCADE wipes events)
// ---------------------------------------------------------------------------

async fn destroy(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    if let Some(r) = deny_enduser_mutation(&u) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let before = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM analytics_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        if before.is_none() {
            return Ok(err(StatusCode::NOT_FOUND, "Analytics config not found"));
        }
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM analytics_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/delete] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/analytics/:id/snippet (endusers allowed, scope-checked)
// ---------------------------------------------------------------------------

async fn snippet(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config(&ctx.db, &user, id).await? {
            Err(r) => Ok(r),
            Ok(r) => {
                let name: String = r
                    .try_get::<Option<String>>("", "name")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let token: String = r
                    .try_get::<Option<String>>("", "secret_token")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let origins = allowed_of(&r);
                let origin = std::env::var("APP_PUBLIC_URL").unwrap_or_else(|_| {
                    let host = headers
                        .get("host")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("localhost:3000");
                    let proto = headers
                        .get("x-forwarded-proto")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("http");
                    format!("{proto}://{host}")
                });
                let script_url =
                    format!("{origin}/api/public/analytics/{token}/script.js");
                let html = format!(
                    "<!-- Analytics \"{name}\" -->\n<script async src=\"{script_url}\" data-analytics-token=\"{token}\"></script>"
                );
                Ok((
                    StatusCode::OK,
                    Json(json!({
                        "html": html, "scriptUrl": script_url,
                        "secretToken": token, "origin": origin,
                        "allowedOrigins": origins,
                    })),
                )
                    .into_response())
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/snippet] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/analytics/:id/stats?days= (endusers allowed, scope-checked)
// ---------------------------------------------------------------------------

async fn stats(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let days: i32 = q
        .get("days")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(30)
        .clamp(1, 90);
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        // Sequential awaits (each is one round-trip; correctness first).
        let totals = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
                        COUNT(*) FILTER (WHERE event_type = 'event')::int AS events,
                        COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL)::int AS unique_visitors,
                        COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL)::int AS unique_sessions
                 FROM analytics_events WHERE config_id = $1
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')",
                vec![id.into(), days.into()],
            ))
            .await?;
        let bucket_fn = if days <= 7 { "hour" } else { "day" };
        let series = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT date_trunc('{bucket_fn}', occurred_at) AS bucket,
                            COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
                            COUNT(*) FILTER (WHERE event_type = 'event')::int AS events,
                            COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL)::int AS visitors
                     FROM analytics_events WHERE config_id = $1
                       AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                     GROUP BY bucket ORDER BY bucket ASC"
                ),
                vec![id.into(), days.into()],
            ))
            .await?;
        let top_paths = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT path, COUNT(*)::int AS views FROM analytics_events
                 WHERE config_id = $1 AND event_type = 'pageview' AND path IS NOT NULL
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY path ORDER BY views DESC LIMIT 10",
                vec![id.into(), days.into()],
            ))
            .await?;
        let top_referrers = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COALESCE(
                           regexp_replace(
                             substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'),
                             '^www\\.', ''
                           ),
                           '(direct)'
                         ) AS host,
                         COUNT(*)::int AS visits
                 FROM analytics_events
                 WHERE config_id = $1 AND event_type = 'pageview'
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY host ORDER BY visits DESC LIMIT 10",
                vec![id.into(), days.into()],
            ))
            .await?;
        let top_locales = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COALESCE(locale, '(unknown)') AS locale, COUNT(*)::int AS visits
                 FROM analytics_events
                 WHERE config_id = $1 AND event_type = 'pageview'
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY locale ORDER BY visits DESC LIMIT 10",
                vec![id.into(), days.into()],
            ))
            .await?;
        let devices_rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT CASE WHEN screen_width IS NULL THEN 'unknown'
                             WHEN screen_width < 768 THEN 'mobile'
                             WHEN screen_width < 1024 THEN 'tablet'
                             ELSE 'desktop' END AS device,
                        COUNT(*)::int AS visits
                 FROM analytics_events
                 WHERE config_id = $1 AND event_type = 'pageview'
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY device ORDER BY visits DESC",
                vec![id.into(), days.into()],
            ))
            .await?;
        let heatmap = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT EXTRACT(DOW FROM occurred_at)::int AS dow,
                        EXTRACT(HOUR FROM occurred_at)::int AS hour,
                        COUNT(*)::int AS events
                 FROM analytics_events WHERE config_id = $1
                   AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY dow, hour ORDER BY dow ASC, hour ASC",
                vec![id.into(), days.into()],
            ))
            .await?;
        let realtime = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "WITH bounds AS (
                   SELECT generate_series(
                     date_trunc('minute', NOW()) - INTERVAL '29 minutes',
                     date_trunc('minute', NOW()), INTERVAL '1 minute') AS bucket
                 ), counts AS (
                   SELECT date_trunc('minute', occurred_at) AS bucket,
                          COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
                          COUNT(*) FILTER (WHERE event_type = 'event')::int AS events
                   FROM analytics_events WHERE config_id = $1
                     AND occurred_at >= NOW() - INTERVAL '30 minutes'
                   GROUP BY bucket
                 )
                 SELECT b.bucket,
                        COALESCE(c.pageviews, 0)::int AS pageviews,
                        COALESCE(c.events, 0)::int AS events
                 FROM bounds b LEFT JOIN counts c ON c.bucket = b.bucket
                 ORDER BY b.bucket ASC",
                vec![id.into()],
            ))
            .await?;
        let recent = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, event_type, occurred_at, path, referrer, locale, session_id
                 FROM analytics_events WHERE config_id = $1
                 ORDER BY occurred_at DESC LIMIT 20",
                vec![id.into()],
            ))
            .await?;

        let t = totals.unwrap();
        let num = |row: &sea_orm::QueryResult, c: &str| -> i64 {
            row.try_get::<i32>("", c).map(|v| v as i64).unwrap_or(0)
        };
        let bucket_iso = |row: &sea_orm::QueryResult| -> String {
            row.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "bucket")
                .ok()
                .flatten()
                .map(|d| iso(&d))
                .unwrap_or_default()
        };
        let mut device_map = HashMap::new();
        for r in &devices_rows {
            let d: String = r
                .try_get::<Option<String>>("", "device")
                .ok()
                .flatten()
                .unwrap_or_default();
            device_map.insert(d, num(r, "visits"));
        }
        let dev = |k: &str| device_map.get(k).cloned().unwrap_or(0);
        let rt_series: Vec<serde_json::Value> = realtime
            .iter()
            .map(|r| {
                json!({
                    "bucket": bucket_iso(r),
                    "pageviews": num(r, "pageviews"),
                    "events": num(r, "events"),
                })
            })
            .collect();
        let rt_total_pv: i64 = rt_series.iter().map(|s| s["pageviews"].as_i64().unwrap_or(0)).sum();
        let rt_total_ev: i64 = rt_series.iter().map(|s| s["events"].as_i64().unwrap_or(0)).sum();
        Ok((
            StatusCode::OK,
            Json(json!({
                "days": days,
                "bucket": bucket_fn,
                "totals": {
                    "pageviews": num(&t, "pageviews"), "events": num(&t, "events"),
                    "uniqueVisitors": num(&t, "unique_visitors"),
                    "uniqueSessions": num(&t, "unique_sessions"),
                },
                "timeSeries": series.iter().map(|r| json!({
                    "bucket": bucket_iso(r), "pageviews": num(r, "pageviews"),
                    "events": num(r, "events"), "visitors": num(r, "visitors"),
                })).collect::<Vec<_>>(),
                "topPaths": top_paths.iter().map(|r| json!({
                    "path": r.try_get::<Option<String>>("", "path").ok().flatten(),
                    "views": num(r, "views"),
                })).collect::<Vec<_>>(),
                "topReferrers": top_referrers.iter().map(|r| json!({
                    "host": r.try_get::<Option<String>>("", "host").ok().flatten(),
                    "visits": num(r, "visits"),
                })).collect::<Vec<_>>(),
                "topLocales": top_locales.iter().map(|r| json!({
                    "locale": r.try_get::<Option<String>>("", "locale").ok().flatten(),
                    "visits": num(r, "visits"),
                })).collect::<Vec<_>>(),
                "devices": { "mobile": dev("mobile"), "tablet": dev("tablet"),
                             "desktop": dev("desktop"), "unknown": dev("unknown") },
                "hourlyHeatmap": heatmap.iter().map(|r| json!({
                    "dow": num(r, "dow"), "hour": num(r, "hour"), "events": num(r, "events"),
                })).collect::<Vec<_>>(),
                "realtime": {
                    "total30m": { "pageviews": rt_total_pv, "events": rt_total_ev },
                    "series": rt_series,
                },
                "recent": recent.iter().map(|r| json!({
                    "id": r.try_get::<i64>("", "id").unwrap_or(0),
                    "eventType": r.try_get::<Option<String>>("", "event_type").ok().flatten(),
                    "occurredAt": r.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "occurred_at").ok().flatten().map(|d| iso(&d)),
                    "path": r.try_get::<Option<String>>("", "path").ok().flatten(),
                    "referrer": r.try_get::<Option<String>>("", "referrer").ok().flatten(),
                    "locale": r.try_get::<Option<String>>("", "locale").ok().flatten(),
                    "sessionId": r.try_get::<Option<String>>("", "session_id").ok().flatten(),
                })).collect::<Vec<_>>(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics/stats] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/analytics")
        .add("/", get(list))
        .add("/by-project/{project_id}", get(by_project))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(destroy))
        .add("/{id}/snippet", get(snippet))
        .add("/{id}/stats", get(stats))
}
