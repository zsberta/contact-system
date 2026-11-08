//! Port of old_backend/routes/projects.js.
//!
//! Project CRUD + attachment up/download. Reads are scoped to the caller's
//! assigned projects for endusers; all mutations are admin-only:
//!   GET    /api/projects
//!   GET    /api/projects/{id}
//!   POST   /api/projects
//!   PUT    /api/projects/{id}
//!   DELETE /api/projects/{id}            (204 + best-effort upload dir cleanup)
//!   GET    /api/projects/{id}/attachments
//!   POST   /api/projects/{id}/attachments            (multipart, field "file")
//!   GET    /api/projects/{id}/attachments/{attId}/download
//!   DELETE /api/projects/{id}/attachments/{attId}

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::middleware::auth::{scoped_project_ids, CurrentUser};
use crate::middleware::query::MultiQuery;

const MAX_FILE_SIZE: usize = 100 * 1024 * 1024; // 100 MB

fn upload_root() -> String {
    std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string())
}

const STATUS_VALUES: &[&str] = &[
    "under_construction", "customer_paid", "waiting_for_payment", "notified_customer",
    "have_to_notify", "paid", "cancelled", "completed",
];
const PERIOD_VALUES: &[&str] = &["monthly", "yearly", "one_off"];

fn sortable_col(field: &str) -> &'static str {
    match field {
        "id" => "id",
        "name" => "name",
        "status" => "status",
        "customerName" => "customer_name",
        "price" => "price",
        "fordulonap" => "fordulonap",
        "createdAt" => "created_at",
        "updatedAt" => "updated_at",
        _ => "created_at",
    }
}

fn one(q: &HashMap<String, Vec<String>>, k: &str) -> Option<String> {
    q.get(k).and_then(|v| v.last()).cloned().filter(|s| !s.is_empty())
}

fn row_to_dto(r: &sea_orm::QueryResult) -> serde_json::Value {
    let created: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "created_at").ok();
    let updated: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "updated_at").ok();
    let last_change: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "last_status_change_at").ok();
    let last_build: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "landing_last_build_at").ok();
    let env_txt: Option<String> = r.try_get("", "landing_build_env").ok().flatten();
    let env: Value = env_txt
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|v: &Value| v.is_object())
        .unwrap_or(json!({}));
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "name": r.try_get::<Option<String>>("", "name").ok().flatten(),
        "domainAddress": r.try_get::<Option<String>>("", "domain_address").ok().flatten(),
        "price": r.try_get::<Option<f64>>("", "price").ok().flatten(),
        "fordulonap": r.try_get::<Option<String>>("", "fordulonap").ok().flatten(),
        "billingPeriod": r.try_get::<Option<String>>("", "billing_period").ok().flatten(),
        "status": r.try_get::<Option<String>>("", "status").ok().flatten(),
        "comment": r.try_get::<Option<String>>("", "comment").ok().flatten(),
        "customerName": r.try_get::<Option<String>>("", "customer_name").ok().flatten(),
        "customerPhone": r.try_get::<Option<String>>("", "customer_phone").ok().flatten(),
        "customerEmail": r.try_get::<Option<String>>("", "customer_email").ok().flatten(),
        "createdAt": created.map(|t| t.to_rfc3339()),
        "updatedAt": updated.map(|t| t.to_rfc3339()),
        "lastStatusChangeAt": last_change.map(|t| t.to_rfc3339()),
        "landingRepoDir": r.try_get::<Option<String>>("", "landing_repo_dir").ok().flatten(),
        "landingBuildCommand": r.try_get::<Option<String>>("", "landing_build_command").ok().flatten().unwrap_or_else(|| "npm run build:content-only".to_string()),
        "landingBuildEnv": env,
        "landingDistPath": r.try_get::<Option<String>>("", "landing_dist_path").ok().flatten(),
        "landingEnabled": r.try_get::<bool>("", "landing_enabled").unwrap_or(false),
        "landingLastBuildAt": last_build.map(|t| t.to_rfc3339()),
        "landingLastBuildStatus": r.try_get::<Option<String>>("", "landing_last_build_status").ok().flatten(),
        "landingLastBuildLog": r.try_get::<Option<String>>("", "landing_last_build_log").ok().flatten(),
        "brandColor": r.try_get::<Option<String>>("", "brand_color").ok().flatten(),
        "gatewayMerchantId": r.try_get::<Option<String>>("", "gateway_merchant_id").ok().flatten(),
    })
}

fn row_to_attachment_dto(r: &sea_orm::QueryResult) -> serde_json::Value {
    let uploaded: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "uploaded_at").ok();
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": r.try_get::<i64>("", "project_id").unwrap_or(0),
        "originalFilename": r.try_get::<Option<String>>("", "original_filename").ok().flatten(),
        "storedFilename": r.try_get::<Option<String>>("", "stored_filename").ok().flatten(),
        "mimeType": r.try_get::<Option<String>>("", "mime_type").ok().flatten(),
        "sizeBytes": r.try_get::<i64>("", "size_bytes").unwrap_or(0),
        "uploadedAt": uploaded.map(|t| t.to_rfc3339()),
    })
}

fn empty_to_null(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        _ => Some(String::new()), // sentinel: non-string -> caught by type checks below
    }
}

fn looks_like_email(v: &str) -> bool {
    let parts: Vec<&str> = v.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    if parts[0].contains(' ') || parts[1].contains(' ') {
        return false;
    }
    match parts[1].find('.') {
        Some(i) if i > 0 && i < parts[1].len() - 1 => true,
        _ => false,
    }
}

fn is_uuid(v: &str) -> bool {
    if v.len() != 36 {
        return false;
    }
    for (i, c) in v.chars().enumerate() {
        if [8, 13, 18, 23].contains(&i) {
            if c != '-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

// Validate POST/PUT body. Returns (db_column -> Value-to-bind) on success.
// String values bind as text; price binds with ::numeric; landing env with ::jsonb.
fn validate_body(b: &Value, partial: bool) -> std::result::Result<HashMap<String, Value>, String> {
    let mut out: HashMap<String, Value> = HashMap::new();
    let get = |camel: &str, snake: &str| -> Option<&Value> {
        b.get(camel).or_else(|| b.get(snake))
    };

    match b.get("name") {
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 200 => {
            out.insert("name".into(), json!(s));
        }
        Some(_) => return Err("name must be a string 1..200 chars".into()),
        None if !partial => return Err("name is required".into()),
        None => {}
    }
    if let Some(raw) = get("domainAddress", "domain_address") {
        match empty_to_null(raw) {
            None => { out.insert("domain_address".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 500 => { out.insert("domain_address".into(), json!(s)); }
            _ => return Err("domainAddress must be a string up to 500 chars or null".into()),
        }
    }
    if let Some(raw) = b.get("price") {
        match raw {
            Value::Null => { out.insert("price".into(), Value::Null); }
            Value::String(s) if s.trim().is_empty() => { out.insert("price".into(), Value::Null); }
            Value::Number(n) => match n.as_f64() {
                Some(f) if f.is_finite() && f >= 0.0 => { out.insert("price".into(), json!(f)); }
                _ => return Err("price must be a non-negative number or null".into()),
            },
            Value::String(s) => match s.trim().parse::<f64>() {
                Ok(f) if f.is_finite() && f >= 0.0 => { out.insert("price".into(), json!(f)); }
                _ => return Err("price must be a non-negative number or null".into()),
            },
            _ => return Err("price must be a non-negative number or null".into()),
        }
    }
    if let Some(raw) = get("billingPeriod", "billing_period") {
        match empty_to_null(raw) {
            None => { out.insert("billing_period".into(), Value::Null); }
            Some(s) if raw.is_string() && PERIOD_VALUES.contains(&s.as_str()) => {
                out.insert("billing_period".into(), json!(s));
            }
            _ => return Err(format!("billingPeriod must be one of {} or null", PERIOD_VALUES.join(", "))),
        }
    }
    if let Some(raw) = b.get("status") {
        match raw.as_str() {
            Some(s) if STATUS_VALUES.contains(&s) => { out.insert("status".into(), json!(s)); }
            _ => return Err(format!("status must be one of {}", STATUS_VALUES.join(", "))),
        }
    }
    if let Some(raw) = b.get("comment") {
        match empty_to_null(raw) {
            None => { out.insert("comment".into(), Value::Null); }
            Some(s) if raw.is_string() => { out.insert("comment".into(), json!(s)); }
            _ => return Err("comment must be a string or null".into()),
        }
    }
    if let Some(raw) = get("customerName", "customer_name") {
        match empty_to_null(raw) {
            None => { out.insert("customer_name".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 200 => { out.insert("customer_name".into(), json!(s)); }
            _ => return Err("customerName must be a string up to 200 chars or null".into()),
        }
    }
    if let Some(raw) = get("customerPhone", "customer_phone") {
        match empty_to_null(raw) {
            None => { out.insert("customer_phone".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 50 => { out.insert("customer_phone".into(), json!(s)); }
            _ => return Err("customerPhone must be a string up to 50 chars or null".into()),
        }
    }
    if let Some(raw) = get("customerEmail", "customer_email") {
        match empty_to_null(raw) {
            None => { out.insert("customer_email".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 255 && looks_like_email(&s) => {
                out.insert("customer_email".into(), json!(s.to_lowercase()));
            }
            _ => return Err("customerEmail must be a valid email or null".into()),
        }
    }
    // fordulonap: validated against the effective billing period when known.
    if let Some(raw) = b.get("fordulonap") {
        let period = out.get("billing_period").and_then(|v| v.as_str()).map(|s| s.to_string());
        match period.as_deref() {
            Some("monthly") => match raw.as_str() {
                Some(s) if s.parse::<u32>().map(|d| (1..=28).contains(&d)).unwrap_or(false) && {
                    let d: u32 = s.parse().unwrap_or(0);
                    d.to_string() == s.trim_start_matches('0') || s == d.to_string()
                } => {
                    let d: u32 = s.parse().unwrap_or(0);
                    out.insert("fordulonap".into(), json!(d.to_string()));
                }
                _ => return Err("monthly fordulonap must be a day number 1..28".into()),
            },
            Some("yearly") => {
                let s = raw.as_str().unwrap_or("");
                let normalized = if let [m, d] = &s.split('-').collect::<Vec<_>>()[..] {
                    (m.parse::<u32>().ok(), d.parse::<u32>().ok())
                } else { (None, None) };
                let iso = s.split('-').collect::<Vec<_>>();
                let ok_md = matches!(normalized, (Some(m), Some(d)) if (1..=12).contains(&m) && (1..=31).contains(&d) && s.len() == 5);
                let ok_iso = iso.len() == 3 && iso[0].len() == 4 && iso[1].len() == 2 && iso[2].len() == 2;
                if ok_md {
                    out.insert("fordulonap".into(), json!(s));
                } else if ok_iso {
                    out.insert("fordulonap".into(), json!(format!("{}-{}", iso[1], iso[2])));
                } else {
                    return Err("yearly fordulonap must be MM-DD or YYYY-MM-DD".into());
                }
            }
            Some("one_off") => {
                let s = raw.as_str().unwrap_or("");
                let valid = s.len() == 10 && {
                    let p: Vec<&str> = s.split('-').collect();
                    p.len() == 3
                        && p[0].len() == 4 && p[1].len() == 2 && p[2].len() == 2
                        && p.iter().all(|x| x.chars().all(|c| c.is_ascii_digit()))
                        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                            .map(|d| d.format("%Y-%m-%d").to_string() == s)
                            .unwrap_or(false)
                };
                if valid {
                    out.insert("fordulonap".into(), json!(s));
                } else {
                    return Err("one_off fordulonap must be YYYY-MM-DD".into());
                }
            }
            _ => {
                // Period unknown (partial update without billing_period): trust but type-check.
                match raw {
                    Value::Null => { out.insert("fordulonap".into(), Value::Null); }
                    Value::String(s) => { out.insert("fordulonap".into(), json!(s)); }
                    _ => return Err("fordulonap must be a string or null".into()),
                }
            }
        }
    }
    if let Some(raw) = get("landingRepoDir", "landing_repo_dir") {
        match empty_to_null(raw) {
            None => { out.insert("landing_repo_dir".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 1000 => { out.insert("landing_repo_dir".into(), json!(s)); }
            _ => return Err("landingRepoDir must be a string up to 1000 chars or null".into()),
        }
    }
    if let Some(raw) = get("landingBuildCommand", "landing_build_command") {
        match empty_to_null(raw) {
            None => { out.insert("landing_build_command".into(), json!("npm run build:content-only")); }
            Some(s) if raw.is_string() && s.len() <= 1000 => { out.insert("landing_build_command".into(), json!(s)); }
            _ => return Err("landingBuildCommand must be a string up to 1000 chars or null".into()),
        }
    }
    if let Some(raw) = get("landingBuildEnv", "landing_build_env") {
        match raw {
            Value::Null => { out.insert("landing_build_env".into(), json!({})); }
            Value::Object(map) => {
                if map.len() > 50 {
                    return Err("landingBuildEnv: maximum 50 entries".into());
                }
                let mut cleaned = Map::new();
                for (k, val) in map {
                    if k.len() > 100 {
                        return Err(format!("landingBuildEnv key invalid: {k}"));
                    }
                    match val {
                        Value::Null => {}
                        Value::String(s) if s.len() > 1000 => {
                            return Err(format!("landingBuildEnv.{k}: value too long (max 1000 chars)"));
                        }
                        Value::String(_) | Value::Number(_) | Value::Bool(_) => {
                            cleaned.insert(k.clone(), val.clone());
                        }
                        _ => return Err(format!("landingBuildEnv.{k}: only string/number/boolean allowed")),
                    }
                }
                out.insert("landing_build_env".into(), Value::Object(cleaned));
            }
            _ => return Err("landingBuildEnv must be a JSON object or null".into()),
        }
    }
    if let Some(raw) = get("landingDistPath", "landing_dist_path") {
        match empty_to_null(raw) {
            None => { out.insert("landing_dist_path".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 1000 => { out.insert("landing_dist_path".into(), json!(s)); }
            _ => return Err("landingDistPath must be a string up to 1000 chars or null".into()),
        }
    }
    if let Some(raw) = get("landingEnabled", "landing_enabled") {
        match raw.as_bool() {
            Some(v) => { out.insert("landing_enabled".into(), json!(v)); }
            None => return Err("landingEnabled must be a boolean".into()),
        }
    }
    if let Some(raw) = get("brandColor", "brand_color") {
        match empty_to_null(raw) {
            None => { out.insert("brand_color".into(), Value::Null); }
            Some(s) if raw.is_string() && s.len() <= 50 => { out.insert("brand_color".into(), json!(s)); }
            _ => return Err("brandColor must be a string up to 50 chars or null".into()),
        }
    }
    if let Some(raw) = get("gatewayMerchantId", "gateway_merchant_id") {
        match empty_to_null(raw) {
            None => { out.insert("gateway_merchant_id".into(), Value::Null); }
            Some(s) if raw.is_string() && is_uuid(&s) => { out.insert("gateway_merchant_id".into(), json!(s)); }
            _ => return Err("gatewayMerchantId must be a UUID or null".into()),
        }
    }
    Ok(out)
}

const PROJECT_COLS: &str = "id, name, domain_address, price, fordulonap, billing_period,
              status, comment, customer_name, customer_phone, customer_email,
              landing_repo_dir, landing_build_command, landing_build_env,
              landing_dist_path, landing_enabled, landing_last_build_at,
              landing_last_build_status, landing_last_build_log,
              brand_color, gateway_merchant_id,
              created_at, updated_at, last_status_change_at";

const PROJECT_SELECT: &str = "SELECT id, name, domain_address, price::float8 AS price, fordulonap,
              billing_period, status, comment, customer_name, customer_phone, customer_email,
              landing_repo_dir, landing_build_command, landing_build_env::text AS landing_build_env,
              landing_dist_path, landing_enabled, landing_last_build_at,
              landing_last_build_status, landing_last_build_log,
              brand_color, gateway_merchant_id,
              created_at, updated_at, last_status_change_at
       FROM projects";

fn enduser_forbidden(user: &CurrentUser) -> Option<Response> {
    if user.role != "admin" {
        Some(
            (StatusCode::FORBIDDEN, Json(json!({ "errorMessage": "Endusers have read-only access" })))
                .into_response(),
        )
    } else {
        None
    }
}

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    MultiQuery(q): MultiQuery,
) -> Response {
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

    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<sea_orm::Value> = Vec::new();
    if !terms.is_empty() {
        let joiner = if filter_any { " OR " } else { " AND " };
        let mut clauses = Vec::new();
        for t in &terms {
            let ph = format!("${}", params.len() + 1);
            params.push(format!("%{t}%").into());
            let ors = ["name", "domain_address", "customer_name", "customer_email", "comment"]
                .iter()
                .map(|c| format!("{c} ILIKE {ph}"))
                .collect::<Vec<_>>()
                .join(" OR ");
            clauses.push(format!("({ors})"));
        }
        conds.push(format!("({})", clauses.join(joiner)));
    }
    // Enduser scoping on projects.id (validated i64s — safe to interpolate).
    if let Some(ids) = scoped_project_ids(&user) {
        if ids.is_empty() {
            conds.push("1 = 0".to_string());
        } else {
            let list = ids.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ");
            conds.push(format!("id IN ({list})"));
        }
    }
    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let dir = if sort_order == "asc" { "ASC" } else { "DESC" };
    let order = format!("ORDER BY {} {dir}, id DESC", sortable_col(&sort_field));
    let offset = page * size;

    let count_sql = format!("SELECT COUNT(*)::int AS total FROM projects {where_sql}");
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
            tracing::error!("[projects/list] count query failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    let data_sql = format!(
        "SELECT id, name, domain_address, price::float8 AS price, fordulonap,
                billing_period, status, comment, customer_name,
                customer_phone, customer_email, brand_color,
                gateway_merchant_id, created_at, updated_at, last_status_change_at
         FROM projects {where_sql} {order} LIMIT ${} OFFSET ${}",
        params.len() + 1,
        params.len() + 2
    );
    let mut dparams = params;
    dparams.push(size.into());
    dparams.push(offset.into());
    match ctx.db.query_all_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, &data_sql, dparams)).await {
        Ok(rows) => {
            // List DTO omits landing internals (matches the old list query).
            let content: Vec<_> = rows.iter().map(|r| {
                json!({
                    "id": r.try_get::<i64>("", "id").unwrap_or(0),
                    "name": r.try_get::<Option<String>>("", "name").ok().flatten(),
                    "domainAddress": r.try_get::<Option<String>>("", "domain_address").ok().flatten(),
                    "price": r.try_get::<Option<f64>>("", "price").ok().flatten(),
                    "fordulonap": r.try_get::<Option<String>>("", "fordulonap").ok().flatten(),
                    "billingPeriod": r.try_get::<Option<String>>("", "billing_period").ok().flatten(),
                    "status": r.try_get::<Option<String>>("", "status").ok().flatten(),
                    "comment": r.try_get::<Option<String>>("", "comment").ok().flatten(),
                    "customerName": r.try_get::<Option<String>>("", "customer_name").ok().flatten(),
                    "customerPhone": r.try_get::<Option<String>>("", "customer_phone").ok().flatten(),
                    "customerEmail": r.try_get::<Option<String>>("", "customer_email").ok().flatten(),
                    "brandColor": r.try_get::<Option<String>>("", "brand_color").ok().flatten(),
                    "gatewayMerchantId": r.try_get::<Option<String>>("", "gateway_merchant_id").ok().flatten(),
                    "createdAt": r.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "created_at").ok().flatten().map(|t| t.to_rfc3339()),
                    "updatedAt": r.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "updated_at").ok().flatten().map(|t| t.to_rfc3339()),
                    "lastStatusChangeAt": r.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "last_status_change_at").ok().flatten().map(|t| t.to_rfc3339()),
                })
            }).collect();
            let total_pages = if total <= 0 { 1 } else { ((total as i64 + size - 1) / size).max(1) };
            let sorted = q.contains_key("sortField");
            (StatusCode::OK, Json(json!({
                "totalPages": total_pages, "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false,
                    "offset": offset, "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                "numberOfElements": content.len(), "size": size, "content": content, "number": page,
                "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                "first": page == 0, "last": page == total_pages - 1, "empty": content.is_empty(),
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("[projects/list] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn get_one(State(ctx): State<AppContext>, user: CurrentUser, Path(id): Path<String>) -> Response {
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    if let Some(ids) = scoped_project_ids(&user) {
        if !ids.contains(&project_id) {
            return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response();
        }
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &format!("{PROJECT_SELECT} WHERE id = $1"),
            vec![project_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => (StatusCode::OK, Json(row_to_dto(&r))).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response(),
        Err(e) => {
            tracing::error!("[projects/get] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

fn bind_or_null(v: &Value) -> sea_orm::Value {
    match v {
        Value::Null => None::<String>.into(),
        Value::String(s) => Some(s.clone()).into(),
        Value::Bool(b) => Some(*b).into(),
        Value::Number(n) => n.as_f64().map(|f| f.to_string()).into(),
        _ => v.to_string().into(),
    }
}

async fn create(State(ctx): State<AppContext>, user: CurrentUser, Json(b): Json<Value>) -> Response {
    if let Some(r) = enduser_forbidden(&user) {
        return r;
    }
    let v = match validate_body(&b, false) {
        Ok(m) => m,
        Err(msg) => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": msg }))).into_response(),
    };
    let get = |k: &str| -> sea_orm::Value {
        match v.get(k) {
            Some(x) => bind_or_null(x),
            None => None::<String>.into(),
        }
    };
    let status: String = v.get("status").and_then(|x| x.as_str()).unwrap_or("under_construction").to_string();
    let price_txt: Option<String> = v.get("price").and_then(|x| match x {
        Value::Null => None,
        n => n.as_f64().map(|f| f.to_string()),
    });
    let env_txt: String = v.get("landing_build_env").map(|x| x.to_string()).unwrap_or_else(|| "{}".to_string());
    let sql = format!(
        "INSERT INTO projects
          (name, domain_address, price, fordulonap, billing_period,
           status, comment, customer_name, customer_phone, customer_email,
           landing_repo_dir, landing_build_command, landing_build_env,
           landing_dist_path, landing_enabled, brand_color, gateway_merchant_id)
         VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13::jsonb, $14, $15, $16, $17)
         RETURNING {PROJECT_COLS}"
    );
    // Re-select with display casts so price/env come back DTO-ready.
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &sql,
            vec![
                v.get("name").cloned().unwrap_or(Value::Null).as_str().unwrap_or("").to_string().into(),
                get("domain_address"),
                price_txt.into(),
                get("fordulonap"),
                get("billing_period"),
                status.into(),
                get("comment"),
                get("customer_name"),
                get("customer_phone"),
                get("customer_email"),
                get("landing_repo_dir"),
                v.get("landing_build_command").cloned().unwrap_or(json!("npm run build:content-only")).as_str().unwrap_or("npm run build:content-only").to_string().into(),
                env_txt.into(),
                get("landing_dist_path"),
                v.get("landing_enabled").and_then(|x| x.as_bool()).unwrap_or(false).into(),
                get("brand_color"),
                get("gateway_merchant_id"),
            ],
        ))
        .await
    {
        Ok(Some(r)) => {
            // Re-read through the display-cast select for a clean DTO.
            let id: i64 = r.try_get("", "id").unwrap_or(0);
            match ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    &format!("{PROJECT_SELECT} WHERE id = $1"),
                    vec![id.into()],
                ))
                .await
            {
                Ok(Some(full)) => (StatusCode::CREATED, Json(row_to_dto(&full))).into_response(),
                _ => (StatusCode::CREATED, Json(row_to_dto(&r))).into_response(),
            }
        }
        Ok(None) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response(),
        Err(e) => {
            let msg = format!("{e:?}");
            if msg.contains("22P02") {
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid enum value" }))).into_response();
            }
            tracing::error!("[projects/create] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn update(State(ctx): State<AppContext>, user: CurrentUser, Path(id): Path<String>, Json(b): Json<Value>) -> Response {
    if let Some(r) = enduser_forbidden(&user) {
        return r;
    }
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let v = match validate_body(&b, true) {
        Ok(m) => m,
        Err(msg) => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": msg }))).into_response(),
    };
    if v.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "No updatable fields provided" }))).into_response();
    }
    let bump_status = v.contains_key("status");
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<sea_orm::Value> = vec![project_id.into()];
    // Deterministic column order.
    let mut keys: Vec<&String> = v.keys().collect();
    keys.sort();
    for col in keys {
        let val = &v[col];
        let idx = params.len() + 1;
        if *col == "price" {
            let txt: Option<String> = match val {
                Value::Null => None,
                n => n.as_f64().map(|f| f.to_string()),
            };
            sets.push(format!("{col} = ${idx}::numeric"));
            params.push(txt.into());
        } else if *col == "landing_build_env" {
            sets.push(format!("{col} = ${idx}::jsonb"));
            params.push(val.to_string().into());
        } else if *col == "landing_enabled" {
            sets.push(format!("{col} = ${idx}"));
            params.push(val.as_bool().unwrap_or(false).into());
        } else {
            sets.push(format!("{col} = ${idx}"));
            params.push(bind_or_null(val));
        }
    }
    sets.push("updated_at = now()".to_string());
    if bump_status {
        sets.push("last_status_change_at = now()".to_string());
    }
    let sql = format!("UPDATE projects SET {} WHERE id = $1 RETURNING id", sets.join(", "));
    match ctx.db.query_one_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, &sql, params)).await {
        Ok(Some(r)) => {
            let pid: i64 = r.try_get("", "id").unwrap_or(project_id);
            match ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    &format!("{PROJECT_SELECT} WHERE id = $1"),
                    vec![pid.into()],
                ))
                .await
            {
                Ok(Some(full)) => (StatusCode::OK, Json(row_to_dto(&full))).into_response(),
                Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response(),
                Err(e) => {
                    tracing::error!("[projects/update] reread {e:?}");
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
                }
            }
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response(),
        Err(e) => {
            if format!("{e:?}").contains("22P02") {
                return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid enum value" }))).into_response();
            }
            tracing::error!("[projects/update] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn delete_project(State(ctx): State<AppContext>, user: CurrentUser, Path(id): Path<String>) -> Response {
    if let Some(r) = enduser_forbidden(&user) {
        return r;
    }
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(res) => {
            if res.rows_affected() == 0 {
                return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response();
            }
            // Best-effort disk cleanup after the FK cascade removed attachment rows.
            let dir = format!("{}/projects/{project_id}", upload_root());
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::error!("[projects/delete] failed to remove upload dir {project_id}: {e}");
                }
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::error!("[projects/delete] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn list_attachments(State(ctx): State<AppContext>, user: CurrentUser, Path(id): Path<String>) -> Response {
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    if let Some(ids) = scoped_project_ids(&user) {
        if !ids.contains(&project_id) {
            return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response();
        }
    }
    let exists = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten()
        .is_some();
    if !exists {
        return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response();
    }
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, project_id, original_filename, stored_filename, mime_type, size_bytes, uploaded_at
             FROM project_attachments WHERE project_id = $1 ORDER BY uploaded_at DESC, id DESC",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(rows.iter().map(row_to_attachment_dto).collect::<Vec<_>>())).into_response(),
        Err(e) => {
            tracing::error!("[projects/attachments/list] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

// Minimal magic-byte sniff (mirrors file-type's role: never trust the client header).
fn sniff_mime(buf: &[u8], original_name: &str) -> Option<String> {
    let ext = original_name.rsplit('.').next().unwrap_or("").to_lowercase();
    if buf.starts_with(b"%PDF") {
        return Some("application/pdf".to_string());
    }
    if buf.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png".to_string());
    }
    if buf.len() >= 3 && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF {
        return Some("image/jpeg".to_string());
    }
    if buf.len() >= 8 && buf[..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        // OLE container: legacy Office. Disambiguate by extension.
        return match ext.as_str() {
            "xls" | "xlt" => Some("application/vnd.ms-excel".to_string()),
            "doc" | "dot" => Some("application/msword".to_string()),
            _ => None,
        };
    }
    if buf.len() >= 4 && buf[..4] == [0x50, 0x4B, 0x03, 0x04] {
        // ZIP container: modern Office. Disambiguate by extension.
        return match ext.as_str() {
            "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
            "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()),
            _ => None,
        };
    }
    // Plain text has no magic bytes: accept by extension (csv/txt) when valid UTF-8.
    if std::str::from_utf8(buf).is_ok() {
        return match ext.as_str() {
            "csv" => Some("text/csv".to_string()),
            "txt" => Some("text/plain".to_string()),
            _ => None,
        };
    }
    None
}

async fn upload_attachment(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
    mut mp: Multipart,
) -> Response {
    if let Some(r) = enduser_forbidden(&user) {
        return r;
    }
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    // First "file" field wins (mirrors upload.single("file")).
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut original_name = String::new();
    while let Ok(Some(field)) = mp.next_field().await {
        if field.name().unwrap_or("") != "file" {
            continue;
        }
        original_name = field.file_name().unwrap_or("upload").to_string();
        let mut buf: Vec<u8> = Vec::new();
        let mut field = field;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() > MAX_FILE_SIZE {
                        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "errorMessage": "File too large" }))).into_response();
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::error!("[projects/attachments/upload] multipart {e:?}");
                    return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": e.to_string() }))).into_response();
                }
            }
        }
        file_bytes = Some(buf);
        break;
    }
    let buf = match file_bytes {
        Some(b) => b,
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "No file uploaded" }))).into_response(),
    };
    let mime = match sniff_mime(&buf, &original_name) {
        Some(m) => m,
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "File type not allowed" }))).into_response(),
    };
    let exists = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten()
        .is_some();
    if !exists {
        return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Project not found" }))).into_response();
    }
    let ext = original_name.rsplit('.').next().map(|e| format!(".{e}")).unwrap_or_default();
    let stored = format!("{}{ext}", uuid::Uuid::new_v4());
    let project_dir = format!("{}/projects/{project_id}", upload_root());
    let full_path = format!("{project_dir}/{stored}");
    if let Err(e) = std::fs::create_dir_all(&project_dir).and_then(|_| std::fs::write(&full_path, &buf)) {
        tracing::error!("[projects/attachments/upload] write failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Failed to store file" }))).into_response();
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO project_attachments
              (project_id, original_filename, stored_filename, mime_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, project_id, original_filename, stored_filename, mime_type, size_bytes, uploaded_at",
            vec![
                project_id.into(),
                original_name.clone().into(),
                stored.into(),
                mime.into(),
                (buf.len() as i64).into(),
            ],
        ))
        .await
    {
        Ok(Some(r)) => (StatusCode::CREATED, Json(row_to_attachment_dto(&r))).into_response(),
        _ => {
            // Roll back the disk write so we don't leak orphans.
            let _ = std::fs::remove_file(&full_path);
            tracing::error!("[projects/attachments/upload] db insert failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

async fn download_attachment(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path((id, att_id)): Path<(String, String)>,
) -> Response {
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let att: i64 = match att_id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid attachment id" }))).into_response(),
    };
    if let Some(ids) = scoped_project_ids(&user) {
        if !ids.contains(&project_id) {
            return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Attachment not found" }))).into_response();
        }
    }
    let row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT original_filename, stored_filename, mime_type FROM project_attachments
             WHERE id = $1 AND project_id = $2",
            vec![att.into(), project_id.into()],
        ))
        .await;
    let r = match row {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Attachment not found" }))).into_response();
        }
        Err(e) => {
            tracing::error!("[projects/attachments/download] {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response();
        }
    };
    let original: String = r.try_get::<Option<String>>("", "original_filename").ok().flatten().unwrap_or_else(|| "file".to_string());
    let stored: String = r.try_get::<Option<String>>("", "stored_filename").ok().flatten().unwrap_or_default();
    let mime: String = r.try_get::<Option<String>>("", "mime_type").ok().flatten().unwrap_or_else(|| "application/octet-stream".to_string());
    let full_path = format!("{}/projects/{project_id}/{stored}", upload_root());
    let bytes = match std::fs::read(&full_path) {
        Ok(b) => b,
        Err(_) => return (StatusCode::GONE, Json(json!({ "errorMessage": "File is no longer available" }))).into_response(),
    };
    let ascii: String = original.chars().map(|c| if c.is_ascii() && c != '"' { c } else { '_' }).collect();
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", mime.parse().unwrap_or("application/octet-stream".parse().unwrap()));
    // RFC 5987: ascii fallback + UTF-8 encoded form.
    let cd = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", url_encode(&original));
    headers.insert("Content-Disposition", cd.parse().unwrap_or("attachment".parse().unwrap()));
    (headers, Body::from(bytes)).into_response()
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-.~_".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn delete_attachment(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path((id, att_id)): Path<(String, String)>,
) -> Response {
    if let Some(r) = enduser_forbidden(&user) {
        return r;
    }
    let project_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid id" }))).into_response(),
    };
    let att: i64 = match att_id.parse() {
        Ok(n) if n > 0 => n,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "errorMessage": "Invalid attachment id" }))).into_response(),
    };
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM project_attachments WHERE id = $1 AND project_id = $2 RETURNING stored_filename",
            vec![att.into(), project_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => {
            let stored: String = r.try_get::<Option<String>>("", "stored_filename").ok().flatten().unwrap_or_default();
            if !stored.is_empty() {
                let full_path = format!("{}/projects/{project_id}/{stored}", upload_root());
                if let Err(e) = std::fs::remove_file(&full_path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::error!("[projects/attachments/delete] unlink failed {full_path}: {e}");
                    }
                }
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "errorMessage": "Attachment not found" }))).into_response(),
        Err(e) => {
            tracing::error!("[projects/attachments/delete] {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "errorMessage": "Internal server error" }))).into_response()
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/projects")
        .add("/", get(list))
        .add("/", post(create))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(delete_project))
        .add("/{id}/attachments", get(list_attachments))
        .add("/{id}/attachments", post(upload_attachment))
        .add("/{id}/attachments/{attId}/download", get(download_attachment))
        .add("/{id}/attachments/{attId}", delete(delete_attachment))
}
