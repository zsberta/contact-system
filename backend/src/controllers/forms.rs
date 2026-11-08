//! Admin forms module: 1:1 port of old_backend/routes/forms.js.
//!
//! Routes (all require auth; mutations reject endusers with 403):
//!   GET    /api/forms
//!   GET    /api/forms/:id
//!   POST   /api/forms
//!   PUT    /api/forms/:id
//!   DELETE /api/forms/:id
//!   GET    /api/forms/:id/snippet
//!   GET    /api/forms/:id/submissions
//!   GET    /api/forms/:id/submissions/:submissionId

use std::collections::HashMap;
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

// ---------------------------------------------------------------------------
// Small helpers (duplicated locally per porting rules)
// ---------------------------------------------------------------------------

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn unauthorized() -> Response {
    err(StatusCode::UNAUTHORIZED, "Unauthorized")
}

/// Endusers have read-only access: 401 when anonymous, 403 for endusers.
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

fn allowed_origins_of(
    row: &sea_orm::QueryResult,
) -> Vec<String> {
    row.try_get::<Option<Vec<String>>>("", "allowed_origins")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect()
}

fn row_to_dto(
    row: &sea_orm::QueryResult,
) -> serde_json::Value {
    let created: chrono::DateTime<chrono::Utc> =
        row.try_get("", "created_at").unwrap_or_else(|_| chrono::Utc::now());
    let updated: chrono::DateTime<chrono::Utc> =
        row.try_get("", "updated_at").unwrap_or_else(|_| chrono::Utc::now());
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": row.try_get::<Option<String>>("", "project_name").ok().flatten(),
        "name": row.try_get::<Option<String>>("", "name").ok().flatten().unwrap_or_default(),
        "slug": row.try_get::<Option<String>>("", "slug").ok().flatten().unwrap_or_default(),
        "secretToken": row.try_get::<Option<String>>("", "secret_token").ok().flatten().unwrap_or_default(),
        "allowedOrigins": allowed_origins_of(row),
        "status": row.try_get::<Option<String>>("", "status").ok().flatten().unwrap_or_else(|| "active".to_string()),
        "createdAt": iso(&created),
        "updatedAt": iso(&updated),
    })
}

// ---------------------------------------------------------------------------
// Allowed-origins validator (port of the forms.js validator)
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
fn re_slug() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap())
}

fn validate_allowed_origin(
    entry: &serde_json::Value,
    index: usize,
    seen: &mut std::collections::HashSet<String>,
) -> std::result::Result<String, String> {
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
        return Err(format!("allowedOrigins[{index}]: invalid origin ({entry})").replace('"', ""));
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

struct ValidatedForm {
    project_id: Option<i64>,
    name: Option<String>,
    slug: Option<String>,
    status: Option<String>,
    allowed_origins: Option<Vec<String>>,
}

/// Port of validateFormBody. POST: partial=false, PUT: partial=true.
fn validate_form_body(
    body: &serde_json::Value,
    partial: bool,
) -> std::result::Result<ValidatedForm, String> {
    let mut out = ValidatedForm {
        project_id: None,
        name: None,
        slug: None,
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
                let n = v.as_i64().or_else(|| {
                    v.as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                });
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

    match body.get("slug") {
        Some(v) => match v.as_str() {
            Some(s) => {
                let t = s.trim();
                if t.is_empty() || t.len() > 50 || !re_slug().is_match(t) {
                    errors.push(
                        "slug must be 1..50 chars, lowercase kebab-case (a-z, 0-9, hyphens)"
                            .to_string(),
                    );
                } else {
                    out.slug = Some(t.to_string());
                }
            }
            None => errors.push("slug must be a string".to_string()),
        },
        None => {
            if !partial {
                errors.push("slug is required".to_string());
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
                    let mut seen = std::collections::HashSet::new();
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

/// Format a TEXT[] bind value as a Postgres array literal; used with `$N::text[]`.
fn pg_text_array(items: &[String]) -> String {
    let inner: Vec<String> = items
        .iter()
        .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("{{{}}}", inner.join(","))
}

/// Inline an enduser project scope (ids come from our own JWT, always i64).
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

// ---------------------------------------------------------------------------
// GET /api/forms — paginated list
// ---------------------------------------------------------------------------

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, Vec<String>>>,
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
    let sort_order = if one("sortOrder") == "asc" {
        "asc"
    } else {
        "desc"
    };
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
        "id" => "f.id",
        "name" => "f.name",
        "slug" => "f.slug",
        "status" => "f.status",
        "createdAt" => "f.created_at",
        "updatedAt" => "f.updated_at",
        _ => "f.created_at",
    };
    let dir = if sort_order == "asc" { "ASC" } else { "DESC" };

    let mut conds: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    let mut next = 1i32;
    let mut ph = || {
        let p = format!("${next}");
        next += 1;
        p
    };

    if let Ok(n) = project_param.parse::<i64>() {
        if n > 0 {
            conds.push(format!("f.project_id = {}", ph()));
            params.push(n.into());
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
            let p = ph();
            parts.push(format!("(f.name ILIKE {p} OR f.slug ILIKE {p})"));
            params.push(format!("%{t}%").into());
        }
        conds.push(parts.join(conj));
    }
    // Enduser scope: admins see everything.
    if user.role == "enduser" {
        conds.push(scope_sql(&user.project_ids, "f"));
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };

    let limit_p = ph();
    let offset_p = ph();
    let order = format!("ORDER BY {col} {dir}, f.id DESC");

    let res: Result<Response, sea_orm::DbErr> = (async {
        let count_row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT COUNT(*)::int AS total FROM forms f
                     JOIN projects p ON p.id = f.project_id {where_sql}"
                ),
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
                    "SELECT f.id, f.project_id, p.name AS project_name,
                            f.name, f.slug, f.secret_token, f.allowed_origins,
                            f.status, f.created_at, f.updated_at
                     FROM forms f
                     JOIN projects p ON p.id = f.project_id
                     {where_sql} {order} LIMIT {limit_p} OFFSET {offset_p}"
                ),
                dp,
            ))
            .await?;
        let content: Vec<serde_json::Value> = rows.iter().map(row_to_dto).collect();
        let total_pages = (((total as i64) + size - 1) / size.max(1)).max(1);
        let sorted = q.contains_key("sortField");
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages,
                "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false,
                              "offset": page * size,
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
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/forms/:id
// ---------------------------------------------------------------------------

async fn get_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if user.role == "enduser" {
            let pre = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT project_id FROM forms WHERE id = $1",
                    vec![id.into()],
                ))
                .await?;
            let Some(r) = pre else {
                return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
            };
            let pid: i64 = r.try_get("", "project_id")?;
            if !user.project_ids.contains(&pid) {
                return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT f.id, f.project_id, p.name AS project_name,
                        f.name, f.slug, f.secret_token, f.allowed_origins,
                        f.status, f.created_at, f.updated_at
                 FROM forms f JOIN projects p ON p.id = f.project_id
                 WHERE f.id = $1",
                vec![id.into()],
            ))
            .await?;
        match row {
            Some(r) => Ok((StatusCode::OK, Json(row_to_dto(&r))).into_response()),
            None => Ok(err(StatusCode::NOT_FOUND, "Form not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/get] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/forms
// ---------------------------------------------------------------------------

async fn create(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Some(r) = deny_enduser_mutation(&u) {
        return r;
    }
    let v = match validate_form_body(&body, false) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };
    let project_id = v.project_id.unwrap_or(0);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM projects WHERE id = $1",
                vec![project_id.into()],
            ))
            .await?;
        if proj.is_none() {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        }
        // Friendly pre-checks instead of mapping pg 23505 constraint names.
        let slug_hit = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM forms WHERE slug = $1",
                vec![v.slug.clone().unwrap_or_default().into()],
            ))
            .await?;
        if slug_hit.is_some() {
            return Ok(err(StatusCode::CONFLICT, "Slug already in use"));
        }
        let proj_hit = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM forms WHERE project_id = $1",
                vec![project_id.into()],
            ))
            .await?;
        if proj_hit.is_some() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({
                    "errorMessage": "A module of this type already exists for this project",
                    "errorCode": "PROJECT_MODULE_EXISTS",
                })),
            )
                .into_response());
        }
        let token = secret_token();
        // Registry row (one form module per project).
        let pm = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO project_modules (project_id, module_type)
                 VALUES ($1, 'form')
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
                        "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'form'",
                        vec![project_id.into()],
                    ))
                    .await?;
                ex.and_then(|r| r.try_get("", "id").ok()).unwrap_or(0)
            }
        };
        let origins = pg_text_array(&v.allowed_origins.clone().unwrap_or_default());
        let inserted = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO forms (project_id, module_id, name, slug, secret_token, allowed_origins, status)
                 VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
                 RETURNING id",
                vec![
                    project_id.into(),
                    module_id.into(),
                    v.name.clone().unwrap_or_default().into(),
                    v.slug.clone().unwrap_or_default().into(),
                    token.into(),
                    origins.into(),
                    v.status.clone().unwrap_or_else(|| "active".to_string()).into(),
                ],
            ))
            .await?;
        let new_id: i64 = inserted
            .and_then(|r| r.try_get("", "id").ok())
            .unwrap_or(0);
        let joined = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT f.id, f.project_id, p.name AS project_name,
                        f.name, f.slug, f.secret_token, f.allowed_origins,
                        f.status, f.created_at, f.updated_at
                 FROM forms f JOIN projects p ON p.id = f.project_id
                 WHERE f.id = $1",
                vec![new_id.into()],
            ))
            .await?;
        match joined {
            Some(r) => Ok((StatusCode::CREATED, Json(row_to_dto(&r))).into_response()),
            None => Ok(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error",
            )),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/create] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// PUT /api/forms/:id
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
    let v = match validate_form_body(&body, true) {
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
    if let Some(slug) = v.slug {
        sets.push(format!("slug = ${n}"));
        params.push(slug.into());
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
        let before = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM forms WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        if before.is_none() {
            return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
        }
        // Slug collision pre-check (friendly 409 instead of pg error mapping).
        if let Some(slug) = body.get("slug").and_then(|s| s.as_str()) {
            let hit = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM forms WHERE slug = $1 AND id <> $2",
                    vec![slug.trim().to_string().into(), id.into()],
                ))
                .await?;
            if hit.is_some() {
                return Ok(err(StatusCode::CONFLICT, "Slug already in use"));
            }
        }
        sets.push("updated_at = now()".to_string());
        let upd = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("UPDATE forms SET {} WHERE id = $1", sets.join(", ")),
                params,
            ))
            .await;
        if let Err(e) = upd {
            let msg = format!("{e:?}");
            if msg.contains("23505") {
                return Ok(err(StatusCode::CONFLICT, "Slug already in use"));
            }
            if msg.contains("23514") {
                return Ok(err(StatusCode::BAD_REQUEST, "Invalid field value"));
            }
            tracing::error!("[forms/update] {e:?}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"));
        }
        let joined = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT f.id, f.project_id, p.name AS project_name,
                        f.name, f.slug, f.secret_token, f.allowed_origins,
                        f.status, f.created_at, f.updated_at
                 FROM forms f JOIN projects p ON p.id = f.project_id
                 WHERE f.id = $1",
                vec![id.into()],
            ))
            .await?;
        match joined {
            Some(r) => Ok((StatusCode::OK, Json(row_to_dto(&r))).into_response()),
            None => Ok(err(StatusCode::NOT_FOUND, "Form not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/update] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/forms/:id — hard delete (FK CASCADE wipes submissions)
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
        let deleted = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM forms WHERE id = $1 RETURNING module_id",
                vec![id.into()],
            ))
            .await?;
        match deleted {
            None => Ok(err(StatusCode::NOT_FOUND, "Form not found")),
            Some(r) => {
                if let Ok(Some(mid)) = r.try_get::<Option<i64>>("", "module_id") {
                    let _ = ctx
                        .db
                        .execute_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "DELETE FROM project_modules WHERE id = $1",
                            vec![mid.into()],
                        ))
                        .await;
                }
                Ok(StatusCode::NO_CONTENT.into_response())
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/delete] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/forms/:id/snippet — admin-only embed snippet
// ---------------------------------------------------------------------------

async fn snippet(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    if let Some(r) = deny_enduser_mutation(&u) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT name, slug, secret_token, allowed_origins FROM forms WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        match row {
            None => Ok(err(StatusCode::NOT_FOUND, "Form not found")),
            Some(r) => {
                let name: String = r.try_get::<Option<String>>("", "name").ok().flatten().unwrap_or_default();
                let slug: String = r.try_get::<Option<String>>("", "slug").ok().flatten().unwrap_or_default();
                let token: String = r.try_get::<Option<String>>("", "secret_token").ok().flatten().unwrap_or_default();
                let origins = allowed_origins_of(&r);
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
                let html = format!(
                    "<!-- CMS Form \"{name}\" (slug={slug}) -->\n<form action=\"{origin}/api/public/forms/{token}/submissions\" method=\"POST\" accept-charset=\"utf-8\" target=\"_self\">\n  <input type=\"hidden\" name=\"slug\" value=\"{slug}\" />\n  <!-- Add your fields below (input / textarea / select name=\"<key>\") -->\n</form>"
                );
                Ok((
                    StatusCode::OK,
                    Json(json!({
                        "html": html,
                        "secretToken": token,
                        "slug": slug,
                        "origin": origin,
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
            tracing::error!("[forms/snippet] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// Submissions sub-resource (mounted under /api/forms/:id)
// ---------------------------------------------------------------------------

fn submission_dto(row: &sea_orm::QueryResult) -> serde_json::Value {
    let submitted: chrono::DateTime<chrono::Utc> = row
        .try_get("", "submitted_at")
        .unwrap_or_else(|_| chrono::Utc::now());
    let created: chrono::DateTime<chrono::Utc> = row
        .try_get("", "created_at")
        .unwrap_or_else(|_| chrono::Utc::now());
    let data: serde_json::Value = row
        .try_get::<Option<serde_json::Value>>("", "data")
        .ok()
        .flatten()
        .unwrap_or(json!({}));
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "formId": row.try_get::<i64>("", "form_id").unwrap_or(0),
        "submittedAt": iso(&submitted),
        "ipAddress": row.try_get::<Option<String>>("", "ip_address").ok().flatten(),
        "userAgent": row.try_get::<Option<String>>("", "user_agent").ok().flatten(),
        "referer": row.try_get::<Option<String>>("", "referer").ok().flatten(),
        "data": data,
        "locale": row.try_get::<Option<String>>("", "locale").ok().flatten(),
        "createdAt": iso(&created),
    })
}

async fn submissions_list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid form id");
    }
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
        "submittedAt"
    } else {
        sort_field.as_str()
    };
    let col = match sort_field {
        "submittedAt" => "s.submitted_at",
        "ipAddress" => "s.ip_address",
        "locale" => "s.locale",
        "createdAt" => "s.created_at",
        _ => return err(StatusCode::BAD_REQUEST, "Invalid sortField"),
    };
    let dir = if one("sortOrder") == "asc" { "ASC" } else { "DESC" };
    let mut queries: Vec<String> = q.get("queries").cloned().unwrap_or_default();
    if let Some(extra) = q.get("queries[]") {
        queries.extend(extra.clone());
    }
    let filter_type = one("filterType");

    let res: Result<Response, sea_orm::DbErr> = (async {
        let form_check = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM forms WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        let Some(fc) = form_check else {
            return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
        };
        if user.role == "enduser" {
            let pid: i64 = fc.try_get("", "project_id")?;
            if !user.project_ids.contains(&pid) {
                return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
            }
        }
        let terms: Vec<String> = queries
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let mut where_sql = String::new();
        let mut params: Vec<sea_orm::Value> = vec![id.into()];
        let mut next = 2i32;
        if !terms.is_empty() {
            let conj = if filter_type == "all" { " AND " } else { " OR " };
            let mut parts = vec![];
            for t in terms {
                // Escape LIKE wildcards like the original.
                let esc = t.replace('%', "\\%").replace('_', "\\_");
                parts.push(format!(
                    "(s.ip_address::text ILIKE ${next} OR s.locale ILIKE ${next} OR s.data::text ILIKE ${next})"
                ));
                params.push(format!("%{esc}%").into());
                next += 1;
            }
            where_sql = format!(" AND ({})", parts.join(conj));
        }
        let order_sql = format!("ORDER BY {col} {dir}, s.id DESC");
        let limit_p = next;
        next += 1;
        let offset_p = next;
        let mut dp = params.clone();
        dp.push(size.into());
        dp.push((page * size).into());
        let data = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT s.id, s.form_id, s.submitted_at, s.ip_address, s.user_agent,
                            s.referer, s.data, s.locale, s.created_at
                     FROM form_submissions s
                     WHERE s.form_id = $1{where_sql} {order_sql}
                     LIMIT ${limit_p} OFFSET ${offset_p}"
                ),
                dp,
            ))
            .await?;
        let count_row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT COUNT(*)::bigint AS total FROM form_submissions s
                     WHERE s.form_id = $1{where_sql}"
                ),
                params,
            ))
            .await?;
        let total: i64 = count_row
            .and_then(|r| r.try_get("", "total").ok())
            .unwrap_or(0);
        let total_pages = ((total + size - 1) / size.max(1)).max(1);
        let content: Vec<serde_json::Value> = data.iter().map(submission_dto).collect();
        let sorted = q.contains_key("sortField");
        Ok((
            StatusCode::OK,
            Json(json!({
                "content": content,
                "totalElements": total,
                "totalPages": total_pages,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false,
                              "offset": page * size,
                              "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                "numberOfElements": content.len(),
                "size": size,
                "number": page,
                "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                "first": page == 0,
                "last": page >= total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/submissions/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn submission_get(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path((id, submission_id)): Path<(i64, i64)>,
) -> Response {
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid form id");
    }
    if submission_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid submission id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if user.role == "enduser" {
            let pre = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT project_id FROM forms WHERE id = $1",
                    vec![id.into()],
                ))
                .await?;
            let Some(r) = pre else {
                return Ok(err(StatusCode::NOT_FOUND, "Submission not found"));
            };
            let pid: i64 = r.try_get("", "project_id")?;
            if !user.project_ids.contains(&pid) {
                return Ok(err(StatusCode::NOT_FOUND, "Submission not found"));
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, form_id, submitted_at, ip_address, user_agent, referer,
                        data, locale, created_at
                 FROM form_submissions WHERE form_id = $1 AND id = $2",
                vec![id.into(), submission_id.into()],
            ))
            .await?;
        match row {
            Some(r) => Ok((StatusCode::OK, Json(submission_dto(&r))).into_response()),
            None => Ok(err(StatusCode::NOT_FOUND, "Submission not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[forms/submissions/get] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/forms")
        .add("/", get(list))
        .add("/", post(create))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(destroy))
        .add("/{id}/snippet", get(snippet))
        .add("/{id}/submissions", get(submissions_list))
        .add(
            "/{id}/submissions/{submission_id}",
            get(submission_get),
        )
}
