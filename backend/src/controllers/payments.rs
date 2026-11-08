//! Payment records. Port of old_backend/routes/payments.js.
//!
//! Routes (under /api/payments, auth required; mutations admin-only):
//!   GET    /api/payments          - paged list, optional ?projectId= (endusers scoped)
//!   GET    /api/payments/:id      - single payment (out-of-scope -> 404)
//!   POST   /api/payments          - create (project must exist, paid_at auto-set)
//!   PUT    /api/payments/:id      - partial update (projectId immutable, paid_at bookkeeping)
//!   DELETE /api/payments/:id      - delete (paid payments -> 409)
//!
//! Simplifications vs the Express original:
//!   - Activity logging skipped (no shared helper in the Rust port yet).
//!   - Mutations are admin-only via require_admin (401/403). The old code
//!     forbade enduser writes with 403 "Endusers have read-only access";
//!     the code is the same, the message differs.
//!   - DB error mapping uses message-substring matching (23505 -> 409,
//!     22P02 -> 400) instead of pg error codes.

use std::collections::HashMap;

use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser, require_admin, scoped_project_ids};
use crate::middleware::query::MultiQuery;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[payments/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|n| *n > 0)
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn first<'a>(q: &'a HashMap<String, Vec<String>>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| q.get(*k))
        .and_then(|v| v.first())
        .map(|s| s.as_str())
}

fn is_unique_violation(e: &sea_orm::DbErr) -> bool {
    format!("{e:?}").contains("23505")
}

fn is_enum_error(e: &sea_orm::DbErr) -> bool {
    format!("{e:?}").contains("22P02")
}

fn dto_from_row(r: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let due: chrono::NaiveDate = r.try_get("", "due_date")?;
    let paid: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "paid_at")?;
    let created: chrono::DateTime<chrono::Utc> = r.try_get("", "created_at")?;
    let updated: chrono::DateTime<chrono::Utc> = r.try_get("", "updated_at")?;
    Ok(json!({
        "id": r.try_get::<i64>("", "id")?,
        "projectId": r.try_get::<i64>("", "project_id")?,
        "amount": r.try_get::<Option<f64>>("", "amount")?,
        "status": r.try_get::<String>("", "status")?,
        "dueDate": due.format("%Y-%m-%d").to_string(),
        "createdBy": r.try_get::<Option<String>>("", "created_by")?,
        "paidAt": paid.map(iso),
        "note": r.try_get::<Option<String>>("", "note")?,
        "createdAt": iso(created),
        "updatedAt": iso(updated),
    }))
}

const PAY_COLS: &str = "id, project_id, amount::float8 AS amount, status::text AS status, due_date, created_by::text AS created_by, paid_at, note, created_at, updated_at";

fn body_get<'a>(
    body: &'a serde_json::Value,
    camel: &str,
    snake: &str,
) -> Option<&'a serde_json::Value> {
    body.get(camel).or_else(|| body.get(snake))
}

fn is_valid_date(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-'
        || !b[..4].iter().all(|c| c.is_ascii_digit())
        || !b[5..7].iter().all(|c| c.is_ascii_digit())
        || !b[8..10].iter().all(|c| c.is_ascii_digit())
    {
        return false;
    }
    // calendar round-trip (rejects 2024-02-31)
    match chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        Ok(d) => d.format("%Y-%m-%d").to_string() == s,
        Err(_) => false,
    }
}

struct ValidPayment {
    out: HashMap<String, serde_json::Value>,
}

fn validate_payment(body: &serde_json::Value, partial: bool) -> Result<ValidPayment, String> {
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

    match body.get("amount") {
        Some(v) => {
            if v.is_null() || v.as_str() == Some("") {
                out.insert("amount".to_string(), serde_json::Value::Null);
            } else {
                let n = v.as_f64().or_else(|| {
                    v.as_str()
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| v.as_i64().map(|n| n as f64))
                });
                match n {
                    Some(n) if n.is_finite() && n >= 0.0 => {
                        out.insert("amount".to_string(), json!(n));
                    }
                    _ => errors.push("amount must be a non-negative number or null".to_string()),
                }
            }
        }
        None => {
            if !partial {
                errors.push("amount is required".to_string());
            }
        }
    }

    match body_get(body, "dueDate", "due_date") {
        Some(v) => {
            if v.is_null() || v.as_str() == Some("") {
                out.insert("due_date".to_string(), serde_json::Value::Null);
            } else if let Some(s) = v.as_str() {
                if !is_valid_date(s) {
                    errors.push("dueDate must be a valid YYYY-MM-DD date".to_string());
                } else {
                    out.insert("due_date".to_string(), json!(s));
                }
            } else {
                errors.push("dueDate must be a valid YYYY-MM-DD date".to_string());
            }
        }
        None => {
            if !partial {
                errors.push("dueDate is required".to_string());
            }
        }
    }

    match body.get("status") {
        Some(v) => match v.as_str() {
            Some(s) if ["pending", "paid", "overdue", "cancelled"].contains(&s) => {
                out.insert("status".to_string(), json!(s));
            }
            _ => errors.push("status must be one of pending, paid, overdue, cancelled".to_string()),
        },
        None => {
            if !partial {
                out.insert("status".to_string(), json!("pending"));
            }
        }
    }

    match body_get(body, "createdBy", "created_by") {
        Some(v) => match v.as_str() {
            Some(s) if ["auto", "manual"].contains(&s) => {
                out.insert("created_by".to_string(), json!(s));
            }
            _ => errors.push("createdBy must be one of auto, manual".to_string()),
        },
        None => {
            if !partial {
                out.insert("created_by".to_string(), json!("manual"));
            }
        }
    }

    match body_get(body, "paidAt", "paid_at") {
        Some(v) => {
            if v.is_null() || v.as_str() == Some("") {
                out.insert("paid_at".to_string(), serde_json::Value::Null);
            } else if let Some(s) = v.as_str() {
                match chrono::DateTime::parse_from_rfc3339(s) {
                    Ok(dt) => {
                        out.insert("paid_at".to_string(), json!(dt.with_timezone(&chrono::Utc).to_rfc3339()));
                    }
                    Err(_) => errors.push("paidAt must be an ISO timestamp string or null".to_string()),
                }
            } else {
                errors.push("paidAt must be an ISO timestamp string or null".to_string());
            }
        }
        None => {}
    }

    if let Some(v) = body.get("note") {
        if v.is_null() || v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false) {
            out.insert("note".to_string(), serde_json::Value::Null);
        } else if let Some(s) = v.as_str() {
            if s.len() > 5000 {
                errors.push("note must be a string up to 5000 chars or null".to_string());
            } else {
                out.insert("note".to_string(), json!(s.trim()));
            }
        } else {
            errors.push("note must be a string up to 5000 chars or null".to_string());
        }
    }

    if errors.is_empty() {
        Ok(ValidPayment { out })
    } else {
        Err(errors.join("; "))
    }
}

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    MultiQuery(q): MultiQuery,
) -> impl IntoResponse {
    let page = first(&q, &["page"])
        .and_then(|s| s.parse().ok())
        .map(|n: i64| n.max(0))
        .unwrap_or(0);
    let size = first(&q, &["size"])
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| n.clamp(1, 100))
        .unwrap_or(10);

    let mut conds: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    if let Some(pid) = first(&q, &["projectId", "project_id"])
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
    {
        params.push(pid.into());
        conds.push(format!("project_id = ${}", params.len()));
    } else if first(&q, &["projectId", "project_id"]).is_some() {
        return bad("Invalid projectId");
    }

    let scoped = scoped_project_ids(&user);
    if let Some(ids) = scoped {
        use sea_orm::sea_query::{ArrayType, Value as QV};
        params.push(QV::Array(
            ArrayType::BigInt,
            Some(Box::new(ids.iter().map(|x| QV::BigInt(Some(*x))).collect())),
        ));
        conds.push(format!("project_id = ANY(${}::bigint[])", params.len()));
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
            &format!("SELECT COUNT(*)::int AS total FROM payments {where_sql}"),
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
                "SELECT {PAY_COLS} FROM payments {where_sql} ORDER BY due_date DESC, id DESC LIMIT ${lp} OFFSET ${op}"
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
            "totalPages": total_pages,
            "totalElements": total,
            "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": offset, "sort": { "sorted": false, "unsorted": true, "empty": false } },
            "numberOfElements": content.len(),
            "size": size,
            "content": content,
            "number": page,
            "sort": { "sorted": false, "unsorted": true, "empty": false },
            "first": page == 0,
            "last": page == total_pages - 1,
            "empty": content.is_empty(),
        })),
    )
        .into_response()
}

async fn get_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(pid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!("SELECT {PAY_COLS} FROM payments WHERE id = $1"),
            vec![pid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("get", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "Payment not found");
    };
    if user.role != "admin"
        && !user
            .project_ids
            .contains(&r.try_get::<i64>("", "project_id").unwrap_or(0))
    {
        return err(StatusCode::NOT_FOUND, "Payment not found");
    }
    match dto_from_row(&r) {
        Ok(d) => (StatusCode::OK, Json(d)).into_response(),
        Err(e) => internal("get", e),
    }
}

async fn create(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let body = if body.is_object() { body } else { json!({}) };
    let mut v = match validate_payment(&body, false) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    let project_id = v.out["project_id"].as_i64().unwrap();
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return err(StatusCode::NOT_FOUND, "Project not found"),
        Err(e) => return internal("create", e),
    }

    // Auto-set paid_at when status='paid' and caller didn't supply one.
    if v.out.get("status").and_then(|s| s.as_str()) == Some("paid")
        && !v.out.contains_key("paid_at")
    {
        v.out.insert(
            "paid_at".to_string(),
            json!(iso(chrono::Utc::now())),
        );
    }
    let val_or_null = |v: &HashMap<String, serde_json::Value>, k: &str| -> sea_orm::Value {
        match v.get(k) {
            Some(x) if !x.is_null() => {
                if k == "amount" {
                    x.as_f64().map(|n| n.into()).unwrap_or(sea_orm::Value::Double(None))
                } else {
                    x.as_str().unwrap_or("").to_string().into()
                }
            }
            _ => {
                if k == "amount" {
                    sea_orm::Value::Double(None)
                } else {
                    sea_orm::Value::String(None)
                }
            }
        }
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!(
                "INSERT INTO payments (project_id, amount, status, due_date, created_by, paid_at, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING {PAY_COLS}"
            ),
            vec![
                project_id.into(),
                val_or_null(&v.out, "amount"),
                v.out.get("status").and_then(|x| x.as_str()).unwrap_or("pending").to_string().into(),
                val_or_null(&v.out, "due_date"),
                v.out.get("created_by").and_then(|x| x.as_str()).unwrap_or("manual").to_string().into(),
                val_or_null(&v.out, "paid_at"),
                val_or_null(&v.out, "note"),
            ],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return internal("create", "insert returned nothing"),
        Err(e) => {
            if is_unique_violation(&e) {
                return err(
                    StatusCode::CONFLICT,
                    "A payment for this project and due date already exists",
                );
            }
            if is_enum_error(&e) {
                return bad("Invalid enum value");
            }
            return internal("create", e);
        }
    };
    match dto_from_row(&row) {
        Ok(d) => (StatusCode::CREATED, Json(d)).into_response(),
        Err(e) => internal("create", e),
    }
}

async fn update(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let Some(pid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let body = if body.is_object() { body } else { json!({}) };
    let mut v = match validate_payment(&body, true) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    if v.out.is_empty() {
        return bad("No updatable fields provided");
    }
    // paid_at bookkeeping when the caller moves status but passes no paid_at.
    if v.out.contains_key("status") && !v.out.contains_key("paid_at") {
        if v.out.get("status").and_then(|s| s.as_str()) == Some("paid") {
            v.out.insert("paid_at".to_string(), json!(iso(chrono::Utc::now())));
        } else {
            v.out.insert("paid_at".to_string(), serde_json::Value::Null);
        }
    }
    let mut sets: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![pid.into()];
    for col in ["amount", "status", "due_date", "created_by", "paid_at", "note"] {
        if let Some(x) = v.out.get(col) {
            let val: sea_orm::Value = if x.is_null() {
                if col == "amount" {
                    sea_orm::Value::Double(None)
                } else {
                    sea_orm::Value::String(None)
                }
            } else if col == "amount" {
                x.as_f64().map(|n| n.into()).unwrap_or(sea_orm::Value::Double(None))
            } else {
                x.as_str().unwrap_or("").to_string().into()
            };
            params.push(val);
            sets.push(format!("{col} = ${}", params.len()));
        }
    }
    sets.push("updated_at = now()".to_string());
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!("UPDATE payments SET {} WHERE id = $1 RETURNING {PAY_COLS}", sets.join(", ")),
            params,
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Payment not found"),
        Err(e) => {
            if is_unique_violation(&e) {
                return err(
                    StatusCode::CONFLICT,
                    "A payment for this project and due date already exists",
                );
            }
            if is_enum_error(&e) {
                return bad("Invalid enum value");
            }
            return internal("update", e);
        }
    };
    match dto_from_row(&row) {
        Ok(d) => (StatusCode::OK, Json(d)).into_response(),
        Err(e) => internal("update", e),
    }
}

async fn delete_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let Some(pid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT status::text AS status FROM payments WHERE id = $1",
            vec![pid.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("delete", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "Payment not found");
    };
    if r.try_get::<String>("", "status").as_deref() == Ok("paid") {
        return err(StatusCode::CONFLICT, "Cannot delete a paid payment");
    }
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM payments WHERE id = $1",
            vec![pid.into()],
        ))
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal("delete", e),
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/payments")
        .add("/", get(list))
        .add("/", post(create))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(delete_one))
}
