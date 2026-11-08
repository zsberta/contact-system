//! Admin-only CSV import module: 1:1 port of old_backend/routes/imports.js.
//!
//!   POST /api/imports/dry-run            — parse + validate CSV, no writes
//!   GET  /api/imports/services?projectId — existing services for mapping UI
//!   POST /api/imports/bookings/services  — create services from Calendar col
//!   POST /api/imports/customers          — upsert customers by (project,email)
//!   POST /api/imports/bookings          — import bookings (future confirmed
//!                                          ones get a best-effort confirmation)
//!
//! Simplifications vs the original:
//! - The dry-run accepts JSON `{ projectId, importType, csv }` (raw CSV text)
//!   instead of a multipart file upload; the RFC4180 parser is ported 1:1.
//! - Confirmation e-mails use renderBookingAutoReply through the paced queue
//!   (best-effort); the EMAIL_SENDING=false kill-switch is honoured inside
//!   the mailer and reported via `emailsSending`.

use std::sync::OnceLock;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use regex::Regex;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

use crate::middleware::auth::MaybeUser;
use crate::middleware::auth::require_admin;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn re_email() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap())
}

// ---------------------------------------------------------------------------
// CSV parsing — small RFC4180 parser (quotes, escaped quotes, BOM, CRLF)
// ---------------------------------------------------------------------------

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let mut in_quotes = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            if row.len() > 1 || !row[0].is_empty() {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            field.push(c);
        }
        i += 1;
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.len() > 1 || !row[0].is_empty() {
            rows.push(row);
        }
    }
    rows
}

fn rows_to_records(
    rows: Vec<Vec<String>>,
) -> (Vec<String>, Vec<std::collections::HashMap<String, String>>) {
    if rows.is_empty() {
        return (vec![], vec![]);
    }
    let headers: Vec<String> = rows[0].iter().map(|h| h.trim().to_string()).collect();
    let mut records = vec![];
    for (idx, r) in rows.into_iter().skip(1).enumerate() {
        let mut rec = std::collections::HashMap::new();
        rec.insert("__row".to_string(), (idx + 2).to_string());
        for (hi, h) in headers.iter().enumerate() {
            rec.insert(
                h.clone(),
                r.get(hi).map(|s| s.trim().to_string()).unwrap_or_default(),
            );
        }
        records.push(rec);
    }
    (headers, records)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CUSTOMER_REQUIRED: &[&str] = &["First Name", "Last Name", "Email"];
const BOOKING_REQUIRED: &[&str] = &[
    "Calendar",
    "First Name",
    "Last Name",
    "Email",
    "Start Time",
    "End Time",
    "Status",
];

fn map_status(raw: &str) -> Option<&'static str> {
    match raw.to_lowercase().as_str() {
        "confirmed" => Some("confirmed"),
        "cancelled" => Some("cancelled"),
        "showed" => Some("attended"),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct CustomerData {
    first_name: String,
    last_name: String,
    email: String,
    phone: String,
}

fn validate_customer(
    rec: &std::collections::HashMap<String, String>,
) -> (bool, Vec<String>, CustomerData) {
    let mut errors = vec![];
    let g = |k: &str| rec.get(k).cloned().unwrap_or_default();
    let first_name = g("First Name");
    let last_name = g("Last Name");
    let email = g("Email").to_lowercase();
    let phone = g("Phone");
    if first_name.is_empty() {
        errors.push("First Name is required".to_string());
    }
    if last_name.is_empty() {
        errors.push("Last Name is required".to_string());
    }
    if email.is_empty() {
        errors.push("Email is required (email is the unique key)".to_string());
    } else if !re_email().is_match(&email) {
        errors.push(format!("Invalid email: {email}"));
    }
    let ok = errors.is_empty();
    (
        ok,
        errors,
        CustomerData {
            first_name,
            last_name,
            email,
            phone,
        },
    )
}

#[derive(Debug, Clone)]
struct BookingData {
    first_name: String,
    last_name: String,
    email: String,
    phone: String,
    service_name: String,
    starts_at: Option<String>,
    ends_at: Option<String>,
    status: Option<String>,
}

fn parse_ts(
    v: &str,
    label: &str,
    errors: &mut Vec<String>,
) -> Option<String> {
    if v.is_empty() {
        errors.push(format!("{label} is required"));
        return None;
    }
    let dt = chrono::DateTime::parse_from_rfc3339(v)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|n| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(n, chrono::Utc)
                })
        })
        .or_else(|| {
            chrono::DateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S %:z")
                .ok()
                .map(|d| d.with_timezone(&chrono::Utc))
        });
    match dt {
        Some(d) => Some(d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => {
            // Last resort: chrono lenient parse via NaiveDateTime w/ offset.
            errors.push(format!("Invalid {label}: {v}"));
            None
        }
    }
}

fn validate_booking(
    rec: &std::collections::HashMap<String, String>,
) -> (bool, Vec<String>, BookingData) {
    let mut errors = vec![];
    let g = |k: &str| rec.get(k).cloned().unwrap_or_default();
    let first_name = g("First Name");
    let last_name = g("Last Name");
    let email = g("Email").to_lowercase();
    let phone = g("Phone");
    let service_name = g("Calendar");
    let raw_status = g("Status").to_lowercase();
    if service_name.is_empty() {
        errors.push("Calendar (service name) is required".to_string());
    }
    if first_name.is_empty() {
        errors.push("First Name is required".to_string());
    }
    if last_name.is_empty() {
        errors.push("Last Name is required".to_string());
    }
    if email.is_empty() {
        errors.push("Email is required".to_string());
    } else if !re_email().is_match(&email) {
        errors.push(format!("Invalid email: {email}"));
    }
    let starts_at = parse_ts(&g("Start Time"), "Start Time", &mut errors);
    let ends_at = parse_ts(&g("End Time"), "End Time", &mut errors);
    if let (Some(s), Some(e)) = (starts_at.clone(), ends_at.clone()) {
        if e <= s {
            errors.push("End Time must be after Start Time".to_string());
        }
    }
    let status = if raw_status.is_empty() {
        errors.push("Status is required".to_string());
        None
    } else {
        match map_status(&raw_status) {
            Some(s) => Some(s.to_string()),
            None => {
                errors.push(format!(
                    "Unknown status: {raw_status} (expected confirmed | cancelled | showed)"
                ));
                None
            }
        }
    };
    let ok = errors.is_empty();
    (
        ok,
        errors,
        BookingData {
            first_name,
            last_name,
            email,
            phone,
            service_name,
            starts_at,
            ends_at,
            status,
        },
    )
}

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

async fn project_exists(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
) -> Result<bool, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await?;
    Ok(row.is_some())
}

async fn resolve_reservation(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
) -> Result<Option<sea_orm::QueryResult>, sea_orm::DbErr> {
    db.query_one_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT id, project_id, secret_token, timezone, default_locale
         FROM reservations WHERE project_id = $1
         ORDER BY (status = 'active') DESC, id LIMIT 1",
        vec![project_id.into()],
    ))
    .await
}

struct Svc {
    id: i64,
    name: String,
    duration_minutes: Option<i32>,
    price_amount: Option<f64>,
    currency: Option<String>,
    capacity: Option<i32>,
    status: Option<String>,
}

async fn list_services(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
) -> Result<Vec<Svc>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rs.id, rs.duration_minutes, rs.price_amount::float8 AS price_amount,
                    rs.currency, rs.capacity, rs.status,
                    COALESCE(rst.name, rst_any.name) AS name
             FROM reservation_services rs
             LEFT JOIN reservation_service_translations rst
               ON rst.service_id = rs.id AND rst.name IS NOT NULL
             LEFT JOIN LATERAL (
               SELECT t.name FROM reservation_service_translations t
               WHERE t.service_id = rs.id AND t.name IS NOT NULL LIMIT 1
             ) rst_any ON rst.name IS NULL
             WHERE rs.reservation_id = $1
             ORDER BY rs.sort_order, rs.id",
            vec![reservation_id.into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| Svc {
            id: r.try_get("", "id").unwrap_or(0),
            name: r
                .try_get::<Option<String>>("", "name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            duration_minutes: r.try_get("", "duration_minutes").ok().flatten(),
            price_amount: r.try_get("", "price_amount").ok().flatten(),
            currency: r.try_get("", "currency").ok().flatten(),
            capacity: r.try_get("", "capacity").ok().flatten(),
            status: r.try_get("", "status").ok().flatten(),
        })
        .collect())
}

/// Port of upsertReservationCustomer: upsert by (project_id, email).
async fn upsert_customer(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
    c: &CustomerData,
) -> Result<i64, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO reservation_customers (project_id, first_name, last_name, email, phone, status)
             VALUES ($1, $2, $3, $4, $5, 'active')
             ON CONFLICT (project_id, email) DO UPDATE SET
               first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
               phone = EXCLUDED.phone, updated_at = now()
             RETURNING id",
            vec![
                project_id.into(),
                c.first_name.clone().into(),
                c.last_name.clone().into(),
                c.email.clone().into(),
                c.phone.clone().into(),
            ],
        ))
        .await?;
    row.and_then(|r| r.try_get("", "id").ok()).ok_or_else(|| {
        sea_orm::DbErr::Custom("customer upsert returned no id".to_string())
    })
}

// ---------------------------------------------------------------------------
// POST /api/imports/dry-run — JSON { projectId, importType, csv }
// ---------------------------------------------------------------------------

async fn dry_run(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id = body
        .get("projectId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    let import_type = body
        .get("importType")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid projectId");
    }
    if import_type != "customers" && import_type != "bookings" {
        return err(
            StatusCode::BAD_REQUEST,
            "importType must be 'customers' or 'bookings'",
        );
    }
    let csv = body.get("csv").and_then(|v| v.as_str()).unwrap_or("");
    if csv.is_empty() {
        return err(StatusCode::BAD_REQUEST, "CSV text is required");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if !project_exists(&ctx.db, project_id).await? {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        }
        let (headers, records) = rows_to_records(parse_csv(csv));
        let required: &[&str] = if import_type == "customers" {
            CUSTOMER_REQUIRED
        } else {
            BOOKING_REQUIRED
        };
        let missing: Vec<&str> = required
            .iter()
            .filter(|h| !headers.iter().any(|x| x == **h))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "errorMessage": format!("Missing required columns: {}", missing.join(", ")),
                    "headers": headers,
                })),
            )
                .into_response());
        }
        let mut rows_out = vec![];
        let mut valid_count = 0i64;
        let mut invalid_count = 0i64;
        if import_type == "customers" {
            for rec in &records {
                let row_no: i64 = rec
                    .get("__row")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let (ok, errors, data) = validate_customer(rec);
                if ok {
                    valid_count += 1;
                } else {
                    invalid_count += 1;
                }
                rows_out.push(json!({
                    "rowNumber": row_no, "ok": ok, "errors": errors,
                    "data": { "firstName": data.first_name, "lastName": data.last_name,
                              "email": data.email, "phone": data.phone },
                }));
            }
            return Ok((
                StatusCode::OK,
                Json(json!({
                    "importType": import_type, "headers": headers,
                    "totalRows": rows_out.len(), "validCount": valid_count,
                    "invalidCount": invalid_count, "rows": rows_out,
                })),
            )
                .into_response());
        }
        // bookings
        let mut valid_rows: Vec<(i64, BookingData)> = vec![];
        for rec in &records {
            let row_no: i64 = rec
                .get("__row")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let (ok, errors, data) = validate_booking(rec);
            if ok {
                valid_count += 1;
                valid_rows.push((row_no, data.clone()));
            } else {
                invalid_count += 1;
            }
            rows_out.push(json!({
                "rowNumber": row_no, "ok": ok, "errors": errors,
                "data": { "firstName": data.first_name, "lastName": data.last_name,
                          "email": data.email, "phone": data.phone,
                          "serviceName": data.service_name, "status": data.status,
                          "startsAt": data.starts_at, "endsAt": data.ends_at },
            }));
        }
        let reservation = resolve_reservation(&ctx.db, project_id).await?;
        let Some(rv) = reservation else {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "No reservation module found for this project. Create one first.",
            ));
        };
        let reservation_id: i64 = rv.try_get("", "id")?;
        let timezone: Option<String> = rv.try_get("", "timezone").ok().flatten();
        let services = list_services(&ctx.db, reservation_id).await?;
        let mut by_name: std::collections::HashMap<String, (i64, Option<String>, Option<String>)> =
            std::collections::HashMap::new();
        for (row_no, b) in &valid_rows {
            let _ = row_no;
            by_name
                .entry(b.service_name.clone())
                .or_insert((0, b.starts_at.clone(), b.ends_at.clone()))
                .0 += 1;
        }
        let services_out: Vec<serde_json::Value> = by_name
            .iter()
            .map(|(name, (count, s, e))| {
                let m = services.iter().find(|x| &x.name == name);
                json!({
                    "name": name, "rowCount": count,
                    "sampleStart": s, "sampleEnd": e,
                    "existingServiceId": m.map(|x| x.id),
                    "existingDurationMinutes": m.and_then(|x| x.duration_minutes),
                })
            })
            .collect();
        Ok((
            StatusCode::OK,
            Json(json!({
                "importType": import_type, "headers": headers,
                "totalRows": rows_out.len(), "validCount": valid_count,
                "invalidCount": invalid_count, "rows": rows_out,
                "reservationId": reservation_id, "timezone": timezone,
                "existingServices": services.iter().map(|s| json!({
                    "id": s.id, "name": s.name,
                    "durationMinutes": s.duration_minutes, "capacity": s.capacity,
                })).collect::<Vec<_>>(),
                "services": services_out,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[imports/dry-run] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/imports/services?projectId=N
// ---------------------------------------------------------------------------

async fn services_list(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id: i64 = q.get("projectId").and_then(|s| s.parse().ok()).unwrap_or(0);
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid projectId");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let reservation = resolve_reservation(&ctx.db, project_id).await?;
        let Some(rv) = reservation else {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "No reservation module found for this project",
            ));
        };
        let reservation_id: i64 = rv.try_get("", "id")?;
        let timezone: Option<String> = rv.try_get("", "timezone").ok().flatten();
        let services = list_services(&ctx.db, reservation_id).await?;
        Ok((
            StatusCode::OK,
            Json(json!({
                "reservationId": reservation_id, "timezone": timezone,
                "services": services.iter().map(|s| json!({
                    "id": s.id, "name": s.name,
                    "durationMinutes": s.duration_minutes,
                    "priceAmount": s.price_amount,
                    "currency": s.currency, "capacity": s.capacity,
                    "status": s.status,
                })).collect::<Vec<_>>(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[imports/services/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/imports/bookings/services
// ---------------------------------------------------------------------------

async fn services_create(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id = body
        .get("projectId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid projectId");
    }
    let services = body.get("services").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if services.is_empty() {
        return err(StatusCode::BAD_REQUEST, "services array is required");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let reservation = resolve_reservation(&ctx.db, project_id).await?;
        let Some(rv) = reservation else {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "No reservation module found for this project",
            ));
        };
        let reservation_id: i64 = rv.try_get("", "id")?;
        let default_locale: String = rv
            .try_get::<Option<String>>("", "default_locale")
            .ok()
            .flatten()
            .unwrap_or_else(|| "hu".to_string());
        let mut created = vec![];
        let mut errors = vec![];
        for (i, svc) in services.iter().enumerate() {
            let name = svc
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let duration: Option<i64> = svc.get("durationMinutes").and_then(|v| {
                v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok())
            });
            let price: f64 = svc
                .get("priceAmount")
                .and_then(|v| {
                    v.as_f64().or_else(|| {
                        v.as_str()
                            .and_then(|s| if s.is_empty() { Some(0.0) } else { s.parse().ok() })
                    })
                })
                .unwrap_or(0.0);
            let currency = svc
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("HUF")
                .to_uppercase();
            let capacity: Option<i64> = svc.get("capacity").and_then(|v| {
                v.as_i64().or_else(|| {
                    v.as_str()
                        .and_then(|s| if s.is_empty() { Some(1) } else { s.parse().ok() })
                })
            });
            if name.is_empty() {
                errors.push(json!({ "index": i, "name": name, "error": "Service name is required" }));
                continue;
            }
            let duration = duration.unwrap_or(0);
            if duration <= 0 {
                errors.push(json!({ "index": i, "name": name, "error": "durationMinutes must be > 0" }));
                continue;
            }
            if !(price >= 0.0) {
                errors.push(json!({ "index": i, "name": name, "error": "priceAmount must be >= 0" }));
                continue;
            }
            if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
                errors.push(json!({ "index": i, "name": name, "error": "currency must be 3 uppercase letters" }));
                continue;
            }
            let capacity = capacity.unwrap_or(1);
            if capacity < 1 {
                errors.push(json!({ "index": i, "name": name, "error": "capacity must be >= 1" }));
                continue;
            }
            let existing = list_services(&ctx.db, reservation_id).await?;
            if let Some(m) = existing.iter().find(|e| e.name == name) {
                created.push(json!({ "id": m.id, "name": name, "existing": true }));
                continue;
            }
            let sort_order = existing.len() as i64 + i as i64;
            let ins = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_services
                       (reservation_id, status, sort_order, duration_minutes, price_amount, currency, capacity,
                        granularity, lead_time_minutes, max_advance_days)
                     VALUES ($1, 'active', $2, $3, $4, $5, $6, 'hour', 0, 365)
                     RETURNING id",
                    vec![
                        reservation_id.into(),
                        sort_order.into(),
                        duration.into(),
                        price.into(),
                        currency.clone().into(),
                        capacity.into(),
                    ],
                ))
                .await?;
            let sid: i64 = ins.and_then(|r| r.try_get("", "id").ok()).unwrap_or(0);
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_service_translations (service_id, locale, name)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (service_id, locale) DO UPDATE SET name = EXCLUDED.name",
                    vec![sid.into(), default_locale.clone().into(), name.clone().into()],
                ))
                .await;
            created.push(json!({ "id": sid, "name": name, "existing": false }));
        }
        Ok((StatusCode::CREATED, Json(json!({ "created": created, "errors": errors }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[imports/bookings/services] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/imports/customers
// ---------------------------------------------------------------------------

async fn customers_import(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id = body
        .get("projectId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid projectId");
    }
    let rows = body.get("rows").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if rows.is_empty() {
        return err(StatusCode::BAD_REQUEST, "rows array is required");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if !project_exists(&ctx.db, project_id).await? {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        }
        let mut results = vec![];
        for (i, row) in rows.iter().enumerate() {
            let mut rec = std::collections::HashMap::new();
            let g = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            rec.insert("First Name".to_string(), g("firstName"));
            rec.insert("Last Name".to_string(), g("lastName"));
            rec.insert("Email".to_string(), g("email"));
            rec.insert("Phone".to_string(), g("phone"));
            let row_no = row
                .get("rowNumber")
                .and_then(|v| v.as_i64())
                .unwrap_or(i as i64 + 2);
            let (ok, errs, data) = validate_customer(&rec);
            if !ok {
                results.push(json!({ "rowNumber": row_no, "ok": false, "errors": errs }));
                continue;
            }
            match upsert_customer(&ctx.db, project_id, &data).await {
                Ok(id) => results.push(json!({ "rowNumber": row_no, "ok": true, "customerId": id })),
                Err(e) => results.push(
                    json!({ "rowNumber": row_no, "ok": false, "errors": [e.to_string()] }),
                ),
            }
        }
        let imported = results.iter().filter(|r| r["ok"] == json!(true)).count();
        let failed = results.len() - imported;
        Ok((
            StatusCode::OK,
            Json(json!({ "imported": imported, "failed": failed, "results": results })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[imports/customers] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/imports/bookings
// ---------------------------------------------------------------------------

async fn bookings_import(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id = body
        .get("projectId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid projectId");
    }
    let bookings = body
        .get("bookings")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if bookings.is_empty() {
        return err(StatusCode::BAD_REQUEST, "bookings array is required");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let reservation = resolve_reservation(&ctx.db, project_id).await?;
        let Some(rv) = reservation else {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "No reservation module found for this project",
            ));
        };
        let reservation_id: i64 = rv.try_get("", "id")?;
        let timezone: String = rv
            .try_get::<Option<String>>("", "timezone")
            .ok()
            .flatten()
            .unwrap_or_else(|| "Europe/Budapest".to_string());
        let secret_token: Option<String> = rv.try_get("", "secret_token").ok().flatten();
        let services = list_services(&ctx.db, reservation_id).await?;
        let sending = crate::mailers::email::sending_enabled();
        let mut results = vec![];
        let mut emailed = 0i64;
        for (i, b) in bookings.iter().enumerate() {
            let row_no = b
                .get("rowNumber")
                .and_then(|v| v.as_i64())
                .unwrap_or(i as i64 + 2);
            let fail = |msgs: Vec<String>| json!({ "rowNumber": row_no, "ok": false, "errors": msgs });
            let service_id = b
                .get("serviceId")
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
                .unwrap_or(0);
            let service = services.iter().find(|s| s.id == service_id);
            let Some(service) = service else {
                results.push(fail(vec![format!("Unknown serviceId: {}", b.get("serviceId").map(|v| v.to_string()).unwrap_or_default())]));
                continue;
            };
            let email = b
                .get("email")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if !re_email().is_match(&email) {
                results.push(fail(vec!["Valid email is required".to_string()]));
                continue;
            }
            let parse_iso = |k: &str| {
                b.get(k)
                    .and_then(|v| v.as_str())
                    .and_then(|s| {
                        chrono::DateTime::parse_from_rfc3339(s)
                            .ok()
                            .map(|d| d.with_timezone(&chrono::Utc))
                    })
                    .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            };
            let (Some(starts_at), Some(ends_at)) = (parse_iso("startsAt"), parse_iso("endsAt"))
            else {
                results.push(fail(vec!["Invalid time range".to_string()]));
                continue;
            };
            if ends_at <= starts_at {
                results.push(fail(vec!["Invalid time range".to_string()]));
                continue;
            }
            let status = b.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if !["confirmed", "cancelled", "attended", "completed", "no_show"]
                .contains(&status)
            {
                results.push(fail(vec![format!("Invalid status: {status}")]));
                continue;
            }
            let dup = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT 1 AS one FROM reservation_bookings
                     WHERE service_id = $1 AND starts_at = $2 AND email = $3 LIMIT 1",
                    vec![service.id.into(), starts_at.clone().into(), email.clone().into()],
                ))
                .await?;
            if dup.is_some() {
                results.push(json!({ "rowNumber": row_no, "ok": true, "skipped": "duplicate" }));
                continue;
            }
            let first_name = b.get("firstName").and_then(|v| v.as_str()).unwrap_or("");
            let last_name = b.get("lastName").and_then(|v| v.as_str()).unwrap_or("");
            let phone = b.get("phone").and_then(|v| v.as_str()).unwrap_or("");
            let customer_id = match upsert_customer(
                &ctx.db,
                project_id,
                &CustomerData {
                    first_name: first_name.to_string(),
                    last_name: last_name.to_string(),
                    email: email.clone(),
                    phone: phone.to_string(),
                },
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    results.push(fail(vec![e.to_string()]));
                    continue;
                }
            };
            let ins = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_bookings (
                       reservation_id, service_id, starts_at, ends_at,
                       first_name, last_name, email, phone,
                       customer_id, service_name_snapshot, duration_minutes_snapshot,
                       price_amount_snapshot, currency_snapshot, timezone,
                       status, source, locale
                     ) VALUES (
                       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'import', 'hu'
                     )
                     RETURNING id, booking_token",
                    vec![
                        reservation_id.into(),
                        service.id.into(),
                        starts_at.clone().into(),
                        ends_at.clone().into(),
                        if first_name.is_empty() { None::<String>.into() } else { first_name.to_string().into() },
                        if last_name.is_empty() { None::<String>.into() } else { last_name.to_string().into() },
                        email.clone().into(),
                        if phone.is_empty() { None::<String>.into() } else { phone.to_string().into() },
                        customer_id.into(),
                        service.name.clone().into(),
                        service.duration_minutes.unwrap_or(0).into(),
                        service.price_amount.unwrap_or(0.0).into(),
                        service.currency.clone().unwrap_or_else(|| "HUF".to_string()).into(),
                        timezone.clone().into(),
                        status.to_string().into(),
                    ],
                ))
                .await;
            let row = match ins {
                Ok(Some(r)) => r,
                _ => {
                    results.push(fail(vec!["Insert failed".to_string()]));
                    continue;
                }
            };
            let booking_id: i64 = row.try_get("", "id").unwrap_or(0);
            results.push(json!({ "rowNumber": row_no, "ok": true, "bookingId": booking_id }));
            // Only confirmed future bookings get a customer confirmation
            // e-mail (same template/kind as the old notifySubmitter
            // reservation path: renderBookingAutoReply, queued).
            if sending && status == "confirmed" {
                let today = chrono::Utc::now().date_naive().to_string();
                if starts_at.get(..10).map(|d| d >= today.as_str()).unwrap_or(false) {
                    let token: String = row
                        .try_get::<Option<String>>("", "booking_token")
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    send_import_confirmation(
                        &ctx.db,
                        project_id,
                        &token,
                        secret_token.as_deref(),
                        &timezone,
                        &email,
                        &service.name,
                        &starts_at,
                        &ends_at,
                        booking_id,
                    )
                    .await;
                    emailed += 1;
                }
            }
        }
        let imported = results
            .iter()
            .filter(|r| r["ok"] == json!(true) && r.get("skipped").is_none())
            .count();
        let skipped = results
            .iter()
            .filter(|r| r.get("skipped").is_some())
            .count();
        let failed = results.iter().filter(|r| r["ok"] == json!(false)).count();
        Ok((
            StatusCode::OK,
            Json(json!({
                "imported": imported, "skippedDuplicates": skipped, "failed": failed,
                "emailsQueued": emailed, "emailsSending": sending, "results": results,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[imports/bookings] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/imports")
        .add("/dry-run", post(dry_run))
        .add("/services", get(services_list))
        .add("/bookings/services", post(services_create))
        .add("/customers", post(customers_import))
        .add("/bookings", post(bookings_import))
}

/// Customer confirmation for an imported booking. Same template/kind as the
/// old `notifySubmitter({ kind: "reservation", ... })` path in
/// `old_backend/routes/imports.js`: `renderBookingAutoReply` (HU),
/// project-branded From, queued (non-blocking, best-effort).
#[allow(clippy::too_many_arguments)]
async fn send_import_confirmation(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
    booking_token: &str,
    secret_token: Option<&str>,
    timezone: &str,
    email: &str,
    service_name: &str,
    starts_at: &str,
    ends_at: &str,
    booking_id: i64,
) {
    use crate::mailers::{
        email::{EmailJob, enqueue_mail},
        templates::{BookingAutoReplyParams, render_booking_auto_reply},
    };
    let proj = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, domain_address, customer_email FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let project_name: Option<String> = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "name").ok().flatten());
    let domain_address: Option<String> = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "domain_address").ok().flatten());
    let customer_email: Option<String> = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "customer_email").ok().flatten());
    // Manage-link base: APP_PUBLIC_URL + embed secret (no buttons when the
    // public URL is unset — same as the old `embedBaseUrl` null branch).
    let app_url = std::env::var("APP_PUBLIC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let embed_base_url: Option<String> =
        match (app_url.is_empty(), secret_token.map(str::trim)) {
            (false, Some(sec)) if !sec.is_empty() => {
                Some(format!("{app_url}/embed/reservations/{sec}"))
            }
            _ => None,
        };
    let rendered = render_booking_auto_reply(BookingAutoReplyParams {
        reservation_name: Some(service_name),
        project_name: project_name.as_deref(),
        domain_address: domain_address.as_deref(),
        customer_email: customer_email.as_deref(),
        starts_at: Some(starts_at),
        ends_at: Some(ends_at),
        booking_id: Some(booking_id),
        service_name: Some(service_name),
        worker_name: None,
        locale: Some("hu"),
        timezone: Some(timezone),
        signer_name: None,
        hide_reply_hint: false,
        hide_sign_off: false,
        booking_token: if booking_token.is_empty() {
            None
        } else {
            Some(booking_token)
        },
        embed_base_url: embed_base_url.as_deref(),
        cancelled: false,
    });
    enqueue_mail(EmailJob {
        to: email.to_string(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        from_name: project_name.filter(|s| !s.is_empty()),
        from_address: None,
    });
}
