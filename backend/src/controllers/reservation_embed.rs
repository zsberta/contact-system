//! Public reservation embed: port of old_backend/routes/reservation-embed.js.
//! Mounted at /api/public/reservations (CSRF-exempt, no auth — the
//! 22-char `secret_token` is the capability).
//!
//! Endpoints:
//! - GET    /:secret_token/availability (booked ranges in a window)
//! - POST   /:secret_token/customer-profiles/resolve
//! - POST   /:secret_token/bookings (create + e-mails + profile opt-in)
//! - GET    /:secret_token/catalog (services with localized content)
//! - GET    /:secret_token/services/:serviceId/availability (slots)
//! - GET    /assets/:filename (service cover images)
//! - GET    /:secret_token/bookings/by-token/:bookingToken
//! - DELETE /:secret_token/bookings/by-token/:bookingToken (12h guard)
//! - PATCH  /:secret_token/bookings/by-token/:bookingToken/reschedule
//!
//! Shared logic (timezone/DST, holidays, ISO parsing, slot alignment,
//! contact + custom-field validation, availability engine, customer
//! upsert, cancellation e-mails) is reused from the admin
//! `reservations` controller (`pub(crate)` helpers) so both paths run
//! the EXACT same checks.
//!
//! Degradations (same rationale as reservations.rs):
//! - `createNotification` (in-app + browser push) has no Rust equivalent:
//!   worker in-app/push notifications are skipped; e-mails go best-effort
//!   via `EmailMailer::send`.
//! - `logActivity`/`logError` → `tracing` only.
//! - Rate limiters from the old file (express-rate-limit) are NOT ported:
//!   no rate-limit middleware exists in this workspace yet. Documented as
//!   a hardening TODO; correctness is unaffected.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::mailers::email::EmailMailer;
use crate::controllers::reservations as R;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "Reservation not found")
}

fn check_token_format(t: &str) -> bool {
    t.len() == 22
}

struct PubReservation {
    id: i64,
    project_id: i64,
    name: String,
    allowed_origins: Vec<String>,
    granularity: String,
    slot_duration_minutes: Option<i64>,
    lead_time_minutes: i64,
    max_advance_days: i64,
    extra_fields_enabled: bool,
    embed_title: String,
    brand_color: String,
    iframe_width: String,
    iframe_height: String,
    privacy_policy_url: Option<String>,
    cookie_policy_url: Option<String>,
    default_locale: String,
    timezone: String,
}

async fn load_reservation(
    db: &sea_orm::DatabaseConnection,
    secret: &str,
) -> Result<Option<PubReservation>, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, project_id, name, status, allowed_origins, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days, extra_fields_enabled, embed_title, brand_color, iframe_width, iframe_height, privacy_policy_url, cookie_policy_url, default_locale, timezone FROM reservations WHERE trim(secret_token) = $1",
            vec![secret.to_string().into()],
        ))
        .await?;
    let Some(r) = row else { return Ok(None) };
    let status: String = r.try_get("", "status").unwrap_or_default();
    if status != "active" {
        return Ok(None);
    }
    Ok(Some(PubReservation {
        id: r.try_get("", "id").unwrap_or(0),
        project_id: r.try_get("", "project_id").unwrap_or(0),
        name: R::str_opt(&r, "name").unwrap_or_default(),
        allowed_origins: R::origins_of(&r),
        granularity: R::str_opt(&r, "granularity").unwrap_or_else(|| "hour".to_string()),
        slot_duration_minutes: r.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64),
        lead_time_minutes: r.try_get::<i32>("", "lead_time_minutes").unwrap_or(60) as i64,
        max_advance_days: r.try_get::<i32>("", "max_advance_days").unwrap_or(90) as i64,
        extra_fields_enabled: r.try_get("", "extra_fields_enabled").unwrap_or(false),
        embed_title: R::str_opt(&r, "embed_title").unwrap_or_else(|| "Időpont foglalás".to_string()),
        brand_color: R::str_opt(&r, "brand_color").unwrap_or_else(|| "#0A2540".to_string()),
        iframe_width: R::str_opt(&r, "iframe_width").unwrap_or_else(|| "100%".to_string()),
        iframe_height: R::str_opt(&r, "iframe_height").unwrap_or_else(|| "760px".to_string()),
        privacy_policy_url: R::str_opt(&r, "privacy_policy_url"),
        cookie_policy_url: R::str_opt(&r, "cookie_policy_url"),
        default_locale: R::str_opt(&r, "default_locale").unwrap_or_else(|| "hu".to_string()),
        timezone: R::str_opt(&r, "timezone").unwrap_or_else(|| "UTC".to_string()),
    }))
}

/// Strict origin gate: empty allowlist = open; otherwise the request
/// origin must match (mismatch → indistinguishable 404).
fn gate_origin(headers: &HeaderMap, allowed: &[String], parent_fallback: bool) -> Result<(), Response> {
    if allowed.is_empty() {
        return Ok(());
    }
    let origin = if parent_fallback {
        headers
            .get("x-reservation-parent-origin")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| headers.get("origin").and_then(|v| v.to_str().ok()).map(|s| s.to_string()).filter(|s| !s.is_empty()))
            .unwrap_or_default()
    } else {
        headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    };
    if parent_fallback && origin.is_empty() {
        return Ok(());
    }
    if origin.is_empty() || !R::is_origin_allowed(&origin, allowed) {
        return Err(not_found());
    }
    Ok(())
}

#[allow(dead_code)]
struct PubService {
    id: i64,
    name: Option<String>,
    duration_minutes: i64,
    price_amount: f64,
    currency: String,
    capacity: i64,
    worker_user_id: Option<i64>,
    granularity: String,
    slot_duration_minutes: Option<i64>,
    lead_time_minutes: i64,
    max_advance_days: i64,
}

async fn load_service(
    db: &sea_orm::DatabaseConnection,
    reservation: &PubReservation,
    service_id: Option<i64>,
) -> Result<Option<PubService>, sea_orm::DbErr> {
    let sql = "SELECT rs.id, rst.name, rs.duration_minutes, rs.price_amount::text AS price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status, rs.granularity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days FROM reservation_services rs LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id) WHERE rs.reservation_id = $1 AND rs.status = 'active'";
    let row = if let Some(sid) = service_id {
        db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!("{sql} AND rs.id = $2"),
            vec![reservation.id.into(), sid.into()],
        ))
        .await?
    } else {
        db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!("{sql} ORDER BY rs.sort_order, rs.id LIMIT 1"),
            vec![reservation.id.into()],
        ))
        .await?
    };
    Ok(row.map(|r| PubService {
        id: r.try_get("", "id").unwrap_or(0),
        name: R::str_opt(&r, "name"),
        duration_minutes: r.try_get::<i32>("", "duration_minutes").unwrap_or(60) as i64,
        price_amount: r.try_get::<Option<String>>("", "price_amount").ok().flatten().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        currency: R::str_opt(&r, "currency").unwrap_or_else(|| "HUF".to_string()),
        capacity: r.try_get::<i32>("", "capacity").unwrap_or(1) as i64,
        worker_user_id: r.try_get::<Option<i64>>("", "worker_user_id").ok().flatten(),
        granularity: R::str_opt(&r, "granularity").unwrap_or_else(|| reservation.granularity.clone()),
        slot_duration_minutes: r.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64).or(reservation.slot_duration_minutes),
        lead_time_minutes: r.try_get::<Option<i32>>("", "lead_time_minutes").ok().flatten().map(|v| v as i64).unwrap_or(reservation.lead_time_minutes),
        max_advance_days: r.try_get::<Option<i32>>("", "max_advance_days").ok().flatten().map(|v| v as i64).unwrap_or(reservation.max_advance_days),
    }))
}

async fn field_defs_for(
    db: &sea_orm::DatabaseConnection,
    service_id: i64,
) -> Result<Vec<R::FieldDef>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT field_key, field_type, required, options FROM reservation_service_fields WHERE service_id = $1",
            vec![service_id.into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| R::FieldDef {
            key: r.try_get::<String>("", "field_key").unwrap_or_default(),
            ftype: r.try_get::<String>("", "field_type").unwrap_or_else(|_| "text".to_string()),
            required: r.try_get::<bool>("", "required").unwrap_or(false),
            options: r.try_get::<Option<Value>>("", "options").ok().flatten().and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Customer profiles (port of reservation-customer-profiles.js)
// ---------------------------------------------------------------------------

fn valid_profile_token(v: &str) -> bool {
    let b = v.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != b'-' {
                    return false;
                }
            }
            14 => {
                if *c != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(*c, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            _ => {
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

async fn resolve_profiles(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
    tokens: &[String],
) -> Vec<Value> {
    let valid: Vec<&String> = tokens.iter().filter(|t| valid_profile_token(t)).take(10).collect();
    if valid.is_empty() {
        return vec![];
    }
    let hashes: Vec<String> = valid.iter().map(|t| R::sha256_hex(t)).collect();
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rcp.profile_token_hash, rc.first_name, rc.last_name, rc.email, rc.phone FROM reservation_customer_profiles rcp JOIN reservation_customers rc ON rc.id = rcp.customer_id WHERE rcp.reservation_id = $1 AND rcp.profile_token_hash = ANY($2::text[]) AND rc.status = 'active'",
            vec![reservation_id.into(), hashes.into()],
        ))
        .await
        .unwrap_or_default();
    let mut by_hash: HashMap<String, &sea_orm::QueryResult> = HashMap::new();
    for r in &rows {
        if let Ok(h) = r.try_get::<String>("", "profile_token_hash") {
            by_hash.insert(h, r);
        }
    }
    let mut out = vec![];
    for t in valid {
        let h = R::sha256_hex(t);
        if let Some(r) = by_hash.get(&h) {
            out.push(json!({
                "profileToken": t,
                "firstName": R::str_opt(r, "first_name"),
                "lastName": R::str_opt(r, "last_name"),
                "email": R::str_opt(r, "email"),
                "phone": R::str_opt(r, "phone"),
            }));
        }
    }
    out
}

async fn upsert_profile(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
    customer_id: i64,
    token: &str,
) -> Option<Value> {
    if !valid_profile_token(token) {
        return None;
    }
    let hash = R::sha256_hex(token);
    let ok = db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO reservation_customer_profiles (reservation_id, customer_id, profile_token_hash) VALUES ($1,$2,$3) ON CONFLICT (reservation_id, profile_token_hash) DO UPDATE SET customer_id = EXCLUDED.customer_id, updated_at = NOW()",
            vec![reservation_id.into(), customer_id.into(), hash.into()],
        ))
        .await
        .is_ok();
    if !ok {
        return None;
    }
    let c = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT first_name, last_name, email, phone FROM reservation_customers WHERE id = $1",
            vec![customer_id.into()],
        ))
        .await
        .ok()
        .flatten()?;
    Some(json!({
        "profileToken": token,
        "firstName": R::str_opt(&c, "first_name"),
        "lastName": R::str_opt(&c, "last_name"),
        "email": R::str_opt(&c, "email"),
        "phone": R::str_opt(&c, "phone"),
    }))
}

/// Budapest-based 12h guard (mirrors isWithin12Hours).
fn within_12h(starts_ms: i64) -> bool {
    let off = R::tz_east_min_at_utc("Europe/Budapest", starts_ms) as i64 * 60_000;
    let now = R::utc_ms_now();
    let now_off = R::tz_east_min_at_utc("Europe/Budapest", now) as i64 * 60_000;
    (starts_ms + off) - (now + now_off) < 12 * 3_600_000
}

// ---------------------------------------------------------------------------
// GET availability (booked ranges)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AvailQuery {
    from: Option<String>,
    to: Option<String>,
}

async fn availability(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(secret): Path<String>,
    Query(q): Query<AvailQuery>,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        if let Err(r) = gate_origin(&headers, &reservation.allowed_origins, false) {
            return Ok(r);
        }
        let now_ms = R::utc_ms_now();
        let from_ms = match q.from.as_deref().map(R::parse_strict_iso_ms) {
            Some(None) => return Ok(err(StatusCode::BAD_REQUEST, "from must be ISO 8601 UTC")),
            Some(Some(v)) => v,
            None => now_ms,
        };
        let default_to = now_ms + reservation.max_advance_days * 86_400_000;
        let to_ms = match q.to.as_deref().map(R::parse_strict_iso_ms) {
            Some(None) => return Ok(err(StatusCode::BAD_REQUEST, "to must be ISO 8601 UTC")),
            Some(Some(v)) => v,
            None => default_to,
        };
        if from_ms > to_ms {
            return Ok(err(StatusCode::BAD_REQUEST, "from must be <= to"));
        }
        let max_to = from_ms + reservation.max_advance_days * 86_400_000;
        let eff_to = to_ms.min(max_to);
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT starts_at, ends_at FROM reservation_bookings WHERE reservation_id = $1 AND tstzrange(starts_at, ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)') ORDER BY starts_at ASC",
                vec![reservation.id.into(), from_ms.into(), eff_to.into()],
            ))
            .await?;
        let booked: Vec<Value> = rows
            .iter()
            .map(|r| {
                let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at").unwrap_or(chrono::Utc::now());
                let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at").unwrap_or(chrono::Utc::now());
                json!({ "startsAt": R::ts(&s), "endsAt": R::ts(&e) })
            })
            .collect();
        Ok((
            StatusCode::OK,
            Json(json!({
                "reservationId": reservation.id,
                "windowStart": R::iso_of_ms(from_ms),
                "windowEnd": R::iso_of_ms(eff_to),
                "granularity": reservation.granularity,
                "slotDurationMinutes": reservation.slot_duration_minutes,
                "leadTimeMinutes": reservation.lead_time_minutes,
                "maxAdvanceDays": reservation.max_advance_days,
                "booked": booked,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/availability] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST customer-profiles/resolve
// ---------------------------------------------------------------------------

async fn resolve_profiles_handler(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(secret): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    let tokens: Vec<String> = match body.get("profileTokens").and_then(|v| v.as_array()) {
        Some(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        None => return err(StatusCode::BAD_REQUEST, "profileTokens must be an array"),
    };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        if let Err(r) = gate_origin(&headers, &reservation.allowed_origins, false) {
            return Ok(r);
        }
        let profiles = resolve_profiles(&ctx.db, reservation.id, &tokens).await;
        Ok((StatusCode::OK, Json(json!({ "profiles": profiles }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/profiles] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST bookings
// ---------------------------------------------------------------------------

async fn create_booking_public(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(secret): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(starts_ms), Some(ends_ms)) = (R::parse_strict_iso_ms(starts_raw), R::parse_strict_iso_ms(ends_raw)) else {
        return err(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601 UTC");
    };
    if ends_ms <= starts_ms {
        return err(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let starts_iso = R::iso_of_ms(starts_ms);
    let ends_iso = R::iso_of_ms(ends_ms);
    let mut locale: Option<String> = None;
    if let Some(l) = body.get("locale").and_then(|v| v.as_str()) {
        if l.len() > 10 {
            return err(StatusCode::BAD_REQUEST, "locale must be ≤ 10 chars");
        }
        if !l.is_empty() {
            locale = Some(l.to_string());
        }
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        if let Err(r) = gate_origin(&headers, &reservation.allowed_origins, false) {
            return Ok(r);
        }
        let svc_id_req: Option<i64> = body.get("serviceId").and_then(|v| v.as_i64()).filter(|n| *n > 0);
        let Some(svc) = load_service(&ctx.db, &reservation, svc_id_req).await? else {
            if svc_id_req.is_some() {
                return Ok(err(StatusCode::BAD_REQUEST, "Invalid or inactive service"));
            } else {
                return Ok(err(StatusCode::BAD_REQUEST, "No active service found"));
            }
        };
        let now_ms = R::utc_ms_now();
        if starts_ms - now_ms < svc.lead_time_minutes * 60_000 {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                format!("Booking must start at least {} minute(s) from now", svc.lead_time_minutes),
            ));
        }
        if starts_ms - now_ms > svc.max_advance_days * 86_400_000 {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                format!("Booking cannot start more than {} day(s) from now", svc.max_advance_days),
            ));
        }
        if let Some(slot) = svc.slot_duration_minutes {
            if reservation.granularity != "day" && svc.granularity != "day" {
                if slot > R::SLOT_GRID_MAX_MINUTES {
                    return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Server misconfiguration"));
                }
                let wmin = R::schedule_window_start_min(&ctx.db, reservation.id, Some(svc.id), starts_ms, &reservation.timezone).await?;
                if let Err(e) = R::validate_slot_alignment(starts_ms, ends_ms, slot, &reservation.timezone, wmin) {
                    return Ok(err(StatusCode::BAD_REQUEST, &e));
                }
            }
        }
        match R::check_slot_availability(&ctx.db, reservation.id, Some(svc.id), starts_ms, ends_ms).await? {
            Ok(()) => {}
            Err(reason) => return Ok(err(StatusCode::BAD_REQUEST, &reason)),
        }
        let mut data_json: Option<String> = None;
        if let Some(data) = body.get("data") {
            if !data.is_null() {
                if !reservation.extra_fields_enabled {
                    return Ok(err(StatusCode::BAD_REQUEST, "extra fields are not enabled for this reservation"));
                }
                match R::check_data_bag(data) {
                    Ok(s) => data_json = Some(s),
                    Err(e) => return Ok(err(StatusCode::BAD_REQUEST, &e)),
                }
            }
        }
        let contact = match R::validate_contact(&body) {
            Ok(c) => c,
            Err(e) => return Ok(err(StatusCode::BAD_REQUEST, &e)),
        };
        let defs = field_defs_for(&ctx.db, svc.id).await?;
        let mut fields_map = serde_json::Map::new();
        if body.get("fields").is_some() {
            match R::validate_service_fields(&defs, body.get("fields")) {
                Ok(m) => fields_map = m,
                Err(e) => return Ok(err(StatusCode::BAD_REQUEST, &e)),
            }
        }
        let locale = locale.unwrap_or_else(|| reservation.default_locale.clone());
        // transactional create (advisory lock + capacity + dup guard)
        let txn = ctx.db.begin().await.map_err(|_| sea_orm::DbErr::Custom("begin failed".to_string()))?;
        let outcome: Result<sea_orm::QueryResult, (StatusCode, String)> = (async {
            txn.execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT pg_advisory_xact_lock(hashtextextended('reservation-service:' || $1::text, 0))",
                vec![svc.id.to_string().into()],
            ))
            .await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?;
            let srow: Option<sea_orm::QueryResult> = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id, status, duration_minutes, capacity, worker_user_id FROM reservation_services WHERE id = $1 AND reservation_id = $2 FOR UPDATE",
                    vec![svc.id.into(), reservation.id.into()],
                ))
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?;
            let Some(srow) = srow else {
                txn.rollback().await.ok();
                return Err((StatusCode::BAD_REQUEST, "Service is not available".to_string()));
            };
            if srow.try_get::<String>("", "status").unwrap_or_default() != "active" {
                txn.rollback().await.ok();
                return Err((StatusCode::BAD_REQUEST, "Service is not available".to_string()));
            }
            match R::check_slot_availability(&txn, reservation.id, Some(svc.id), starts_ms, ends_ms).await {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => {
                    txn.rollback().await.ok();
                    return Err((StatusCode::BAD_REQUEST, reason));
                }
                Err(_) => {
                    txn.rollback().await.ok();
                    return Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()));
                }
            }
            let overlap: i64 = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT COUNT(*)::bigint AS cnt FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')",
                    vec![svc.id.into(), starts_iso.clone().into(), ends_iso.clone().into()],
                ))
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?
                .and_then(|r| r.try_get::<i64>("", "cnt").ok())
                .unwrap_or(0);
            let dup = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT 1 AS one FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)') AND email = $4 LIMIT 1",
                    vec![svc.id.into(), starts_iso.clone().into(), ends_iso.clone().into(), contact.email.clone().into()],
                ))
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?
                .is_some();
            if dup {
                txn.rollback().await.ok();
                return Err((StatusCode::CONFLICT, "Erre az időpontra már van foglalásod.".to_string()));
            }
            let cap: i64 = srow.try_get::<i32>("", "capacity").map(|v| v as i64).unwrap_or(1);
            if overlap >= cap {
                txn.rollback().await.ok();
                return Err((StatusCode::CONFLICT, "Slot already booked".to_string()));
            }
            let cust = R::upsert_customer(&txn, reservation.project_id, &contact).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?;
            let cust_id: i64 = cust.try_get("", "id").unwrap_or(0);
            let dur: i64 = srow.try_get::<i32>("", "duration_minutes").map(|v| v as i64).unwrap_or(svc.duration_minutes);
            let worker: Option<i64> = srow.try_get::<Option<i64>>("", "worker_user_id").ok().flatten().or(svc.worker_user_id);
            let mut merged = data_json.and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
            for (k, v) in fields_map {
                merged.insert(k, v);
            }
            let custom: Option<String> = if merged.is_empty() { None } else { Some(Value::Object(merged).to_string()) };
            let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).map(|s| s.split(',').next().unwrap_or("").trim().to_string());
            let ua: Option<String> = headers.get("user-agent").and_then(|v| v.to_str().ok()).map(|s| s.chars().take(500).collect());
            let row = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_bookings (reservation_id, service_id, starts_at, ends_at, first_name, last_name, email, phone, comment, customer_id, created_by_user_id, worker_user_id, service_name_snapshot, duration_minutes_snapshot, price_amount_snapshot, currency_snapshot, timezone, status, source, locale, data, ip_address, user_agent) VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15,$16,'confirmed','public',$17,$18::jsonb,$19::inet,$20) RETURNING id, starts_at, ends_at, booked_at, booking_token",
                    vec![
                        reservation.id.into(), svc.id.into(), starts_iso.clone().into(), ends_iso.clone().into(),
                        contact.first_name.clone().into(), contact.last_name.clone().into(), contact.email.clone().into(),
                        contact.phone.clone().into(), contact.comment.clone().into(), cust_id.into(), worker.into(),
                        svc.name.clone().into(), (dur as i32).into(), svc.price_amount.to_string().into(),
                        svc.currency.clone().into(), reservation.timezone.clone().into(), locale.clone().into(),
                        custom.into(), ip.into(), ua.into(),
                    ],
                ))
                .await
                .map_err(|e| {
                    if R::pg_debug_code(&e).as_deref() == Some("23P01") {
                        return (StatusCode::CONFLICT, "Slot already booked".to_string());
                    }
                    (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
                })?;
            txn.commit().await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?;
            row.ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))
        })
        .await;
        let booking = match outcome {
            Ok(b) => b,
            Err((code, msg)) => return Ok(err(code, &msg)),
        };
        let bid: i64 = booking.try_get("", "id").unwrap_or(0);
        let token: Option<String> = booking.try_get::<Option<String>>("", "booking_token").ok().flatten();
        let booked_at = R::ts_opt(&booking, "booked_at");
        let sname = svc.name.clone().unwrap_or_else(|| reservation.name.clone());
        // customer confirmation (best-effort)
        {
            let hu = locale == "hu";
            let subject = if hu { format!("Foglalás megerősítve – {sname}") } else { format!("Booking confirmed – {sname}") };
            let manage = token.clone().map(|t| format!("\nManage: /embed/reservations/{secret}?booking={t}")).unwrap_or_default();
            let text = if hu {
                format!("Tisztelt {} {}!\n\nFoglalása létrejött: {sname}\nIdőpont: {starts_iso} – {ends_iso} ({})\n\nÜdvözlettel", contact.last_name, contact.first_name, reservation.timezone) + &manage
            } else {
                format!("Dear {} {},\n\nYour booking was created: {sname}\nWhen: {starts_iso} – {ends_iso} ({})\n\nBest regards", contact.first_name, contact.last_name, reservation.timezone) + &manage
            };
            let _ = EmailMailer::send(&contact.email, &subject, &text, &text).await;
        }
        // worker e-mail (settings-gated, best-effort)
        if let Some(wid) = svc.worker_user_id {
            let wrow = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT first_name, last_name, email FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true",
                    vec![wid.into()],
                ))
                .await
                .ok()
                .flatten();
            if let Some(w) = wrow {
                if let Some(wemail) = R::str_opt(&w, "email") {
                    let enabled: bool = ctx
                        .db
                        .query_one_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "SELECT value::text AS v FROM system_settings WHERE key = 'worker_email_notifications'",
                            vec![],
                        ))
                        .await
                        .ok()
                        .flatten()
                        .and_then(|r| r.try_get::<String>("", "v").ok())
                        .map(|v| v != "false")
                        .unwrap_or(true);
                    if enabled {
                        let cname = format!("{} {}", contact.last_name, contact.first_name);
                        let wtext = format!("New booking: {sname}\nCustomer: {cname} <{}>\nPhone: {}\nWhen: {starts_iso} – {ends_iso} ({})", contact.email, contact.phone, reservation.timezone);
                        let _ = EmailMailer::send(&wemail, &format!("New booking – {sname}"), &wtext, &wtext).await;
                    }
                }
            }
        }
        // "remember me" profile opt-in (best-effort)
        let mut profile: Option<Value> = None;
        if body.get("rememberCustomer").and_then(|v| v.as_bool()).unwrap_or(false) {
            if let Some(t) = body.get("customerProfileToken").and_then(|v| v.as_str()) {
                let cust_id: i64 = R::upsert_customer(&ctx.db, reservation.project_id, &contact)
                    .await
                    .ok()
                    .and_then(|r| r.try_get::<i64>("", "id").ok())
                    .unwrap_or(0);
                // NOTE: customer id re-resolved (upsert is idempotent).
                if cust_id > 0 {
                    profile = upsert_profile(&ctx.db, reservation.id, cust_id, t).await;
                }
            }
        }
        tracing::info!("[reservation-embed] booking.create_public id={bid}");
        let mut resp = json!({
            "id": bid,
            "startsAt": starts_iso,
            "endsAt": ends_iso,
            "bookedAt": booked_at,
            "bookingToken": token,
        });
        if let Some(p) = profile {
            resp["customerProfile"] = p;
        }
        Ok((StatusCode::CREATED, Json(resp)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if R::pg_debug_code(&e).as_deref() == Some("23P01") {
                return err(StatusCode::CONFLICT, "Slot already booked");
            }
            tracing::error!("[reservation-embed/book] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CatalogQuery {
    locale: Option<String>,
}

async fn catalog(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(secret): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> Response {
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        if let Err(r) = gate_origin(&headers, &reservation.allowed_origins, true) {
            return Ok(r);
        }
        let locale = q.locale.unwrap_or_else(|| reservation.default_locale.clone());
        let svc_rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rs.*, rst_default.name AS default_name, rst_default.description AS default_description, rst_requested.name AS requested_name, rst_requested.description AS requested_description, u.first_name AS worker_first_name, u.last_name AS worker_last_name, rsa.stored_filename AS image_stored_filename FROM reservation_services rs LEFT JOIN reservation_service_translations rst_default ON rst_default.service_id = rs.id AND rst_default.locale = $2 LEFT JOIN reservation_service_translations rst_requested ON rst_requested.service_id = rs.id AND rst_requested.locale = $3 LEFT JOIN users u ON u.id = rs.worker_user_id LEFT JOIN reservation_service_attachments rsa ON rsa.service_id = rs.id AND rsa.purpose = 'cover' WHERE rs.reservation_id = $1 AND rs.status = 'active' ORDER BY rs.sort_order, rs.id",
                vec![reservation.id.into(), reservation.default_locale.clone().into(), locale.clone().into()],
            ))
            .await?;
        let sids: Vec<i64> = svc_rows.iter().filter_map(|r| r.try_get::<i64>("", "id").ok()).collect();
        let mut fields_map: HashMap<i64, Vec<Value>> = HashMap::new();
        if !sids.is_empty() {
            let frows = ctx
                .db
                .query_all_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT rsf.id, rsf.service_id, rsf.field_key, rsf.field_type, rsf.required, rsf.sort_order, rsf.options, rfft.label, rfft.placeholder FROM reservation_service_fields rsf LEFT JOIN reservation_service_field_translations rfft ON rfft.field_id = rsf.id AND rfft.locale = $2 WHERE rsf.service_id = ANY($1::bigint[])",
                    vec![sids.into(), locale.clone().into()],
                ))
                .await?;
            for f in &frows {
                let sid: i64 = f.try_get("", "service_id").unwrap_or(0);
                let key = R::str_opt(f, "field_key").unwrap_or_default();
                fields_map.entry(sid).or_default().push(json!({
                    "fieldKey": key,
                    "fieldType": R::str_opt(f, "field_type").unwrap_or_else(|| "text".to_string()),
                    "required": f.try_get::<bool>("", "required").unwrap_or(false),
                    "sortOrder": f.try_get::<i32>("", "sort_order").unwrap_or(0),
                    "options": f.try_get::<Option<Value>>("", "options").ok().flatten(),
                    "label": R::str_opt(f, "label").unwrap_or_else(|| key.clone()),
                    "placeholder": R::str_opt(f, "placeholder"),
                }));
            }
        }
        let services: Vec<Value> = svc_rows
            .iter()
            .map(|s| {
                let sid: i64 = s.try_get("", "id").unwrap_or(0);
                let name = R::str_opt(s, "requested_name").or_else(|| R::str_opt(s, "default_name")).unwrap_or_default();
                let desc = R::str_opt(s, "requested_description").or_else(|| R::str_opt(s, "default_description"));
                let wf = R::str_opt(s, "worker_first_name").unwrap_or_default();
                let wl = R::str_opt(s, "worker_last_name").unwrap_or_default();
                let worker_name = if wf.is_empty() && wl.is_empty() {
                    None
                } else if locale == "hu" {
                    Some(format!("{wl} {wf}").trim().to_string())
                } else {
                    Some(format!("{wf} {wl}").trim().to_string())
                };
                json!({
                    "id": sid,
                    "name": name,
                    "description": desc,
                    "durationMinutes": s.try_get::<i32>("", "duration_minutes").unwrap_or(60),
                    "priceAmount": s.try_get::<Option<String>>("", "price_amount").ok().flatten().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0),
                    "currency": R::str_opt(s, "currency").unwrap_or_else(|| "HUF".to_string()),
                    "capacity": s.try_get::<i32>("", "capacity").unwrap_or(1),
                    "workerName": worker_name,
                    "imageUrl": R::str_opt(s, "image_stored_filename").map(|f| format!("/api/public/reservations/assets/{f}")),
                    "fields": fields_map.get(&sid).cloned().unwrap_or_default(),
                })
            })
            .collect();
        Ok((
            StatusCode::OK,
            Json(json!({
                "reservation": {
                    "id": reservation.id,
                    "title": reservation.name,
                    "embedTitle": reservation.embed_title,
                    "brandColor": reservation.brand_color,
                    "iframeWidth": reservation.iframe_width,
                    "iframeHeight": reservation.iframe_height,
                    "privacyPolicyUrl": reservation.privacy_policy_url,
                    "cookiePolicyUrl": reservation.cookie_policy_url,
                    "defaultLocale": reservation.default_locale,
                    "timezone": reservation.timezone,
                },
                "services": services,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/catalog] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET service availability (public; lead time enforced)
// ---------------------------------------------------------------------------

async fn service_availability_public(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path((secret, service_id)): Path<(String, i64)>,
    Query(q): Query<AvailQuery>,
) -> Response {
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        if let Err(r) = gate_origin(&headers, &reservation.allowed_origins, true) {
            return Ok(r);
        }
        if service_id <= 0 {
            return Ok(err(StatusCode::BAD_REQUEST, "Invalid service id"));
        }
        let (Some(from), Some(to)) = (q.from, q.to) else {
            return Ok(err(StatusCode::BAD_REQUEST, "from and to query params are required (YYYY-MM-DD)"));
        };
        match R::get_service_availability(&ctx.db, reservation.id, service_id, &from, &to, false).await? {
            Some(v) => Ok((StatusCode::OK, Json(v)).into_response()),
            None => Ok(err(StatusCode::NOT_FOUND, "Service not found or invalid date range")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/svc-availability] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET assets/:filename
// ---------------------------------------------------------------------------

async fn asset(State(_ctx): State<AppContext>, Path(filename): Path<String>) -> Response {
    use regex::Regex;
    let re = Regex::new(r"^[a-f0-9-]{36}\.(webp|png|jpg|jpeg|avif)$").unwrap();
    // NOTE: stored names are `{uuid}-{serviceId}.{ext}`; accept that shape too.
    let re2 = Regex::new(r"^[a-f0-9-]{36}-\d+\.(webp|png|jpg|jpeg|avif)$").unwrap();
    if !re.is_match(&filename) && !re2.is_match(&filename) {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let db = &_ctx.db;
    let hit = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rsa.id, rsa.service_id FROM reservation_service_attachments rsa WHERE rsa.stored_filename = $1",
            vec![filename.clone().into()],
        ))
        .await;
    let Ok(Some(row)) = hit else {
        return err(StatusCode::NOT_FOUND, "Not found");
    };
    let service_id: i64 = row.try_get("", "service_id").unwrap_or(0);
    let root = std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string());
    let direct = std::path::Path::new(&root).join("reservation-services").join(&filename);
    let mut resolved = if direct.exists() { Some(direct) } else { None };
    if resolved.is_none() {
        let dir = std::path::Path::new(&root).join("reservation-services");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let cand = e.path().join(&filename);
                if cand.exists() {
                    resolved = Some(cand);
                    break;
                }
                if e.path().is_dir() {
                    // service-specific subdir named by id
                    let cand2 = std::path::Path::new(&root)
                        .join("reservation-services")
                        .join(service_id.to_string())
                        .join(&filename);
                    if cand2.exists() {
                        resolved = Some(cand2);
                        break;
                    }
                }
            }
        }
    }
    let Some(path) = resolved else {
        return err(StatusCode::NOT_FOUND, "File not found");
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return err(StatusCode::NOT_FOUND, "File not found"),
    };
    let ext = std::path::Path::new(&filename).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let ctype = match ext.as_str() {
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", ctype)
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"))
}

// ---------------------------------------------------------------------------
// Booking self-service by token
// ---------------------------------------------------------------------------

async fn booking_by_token(
    State(ctx): State<AppContext>,
    Path((secret, token)): Path<(String, String)>,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    if token.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Invalid booking token");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rb.id, rb.starts_at, rb.ends_at, rb.status, rb.first_name, rb.last_name, rb.email, rb.phone, rb.comment, rb.service_id, rb.service_name_snapshot, rb.duration_minutes_snapshot, rb.price_amount_snapshot::text AS price_amount_snapshot, rb.currency_snapshot, rb.locale, COALESCE(rst.name, rb.service_name_snapshot) AS service_name FROM reservation_bookings rb LEFT JOIN reservation_service_translations rst ON rst.service_id = rb.service_id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id) WHERE rb.reservation_id = $1 AND rb.booking_token = $2",
                vec![reservation.id.into(), token.into()],
            ))
            .await?;
        let Some(b) = row else {
            return Ok(err(StatusCode::NOT_FOUND, "Booking not found"));
        };
        let status: String = b.try_get("", "status").unwrap_or_default();
        if status == "cancelled" {
            return Ok(err(StatusCode::GONE, "Booking has been cancelled"));
        }
        Ok((
            StatusCode::OK,
            Json(json!({
                "id": b.try_get::<i64>("", "id").unwrap_or(0),
                "startsAt": R::ts_opt(&b, "starts_at"),
                "endsAt": R::ts_opt(&b, "ends_at"),
                "status": status,
                "firstName": R::str_opt(&b, "first_name"),
                "lastName": R::str_opt(&b, "last_name"),
                "email": R::str_opt(&b, "email"),
                "phone": R::str_opt(&b, "phone"),
                "comment": R::str_opt(&b, "comment"),
                "serviceId": b.try_get::<i64>("", "service_id").unwrap_or(0),
                "serviceName": R::str_opt(&b, "service_name"),
                "durationMinutes": b.try_get::<Option<i32>>("", "duration_minutes_snapshot").ok().flatten(),
                "priceAmount": b.try_get::<Option<String>>("", "price_amount_snapshot").ok().flatten().and_then(|s| s.parse::<f64>().ok()),
                "currency": R::str_opt(&b, "currency_snapshot"),
                "locale": R::str_opt(&b, "locale"),
                "timezone": reservation.timezone,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/by-token] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn cancel_by_token(
    State(ctx): State<AppContext>,
    Path((secret, token)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    if token.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Invalid booking token");
    }
    let body_json: Option<Value> = serde_json::from_slice(&body).ok();
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        let snap = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rb.id, rb.starts_at, rb.ends_at, rb.locale, rb.status, rb.service_name_snapshot, rb.email, rb.customer_id, rb.service_id, rs.worker_user_id, rc.first_name AS customer_first_name, rc.last_name AS customer_last_name, COALESCE(rst.name, rb.service_name_snapshot) AS service_name FROM reservation_bookings rb LEFT JOIN reservation_customers rc ON rc.id = rb.customer_id LEFT JOIN reservation_services rs ON rs.id = rb.service_id LEFT JOIN reservation_service_translations rst ON rst.service_id = rb.service_id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id) WHERE rb.reservation_id = $1 AND rb.booking_token = $2",
                vec![reservation.id.into(), token.clone().into()],
            ))
            .await?;
        let Some(b) = snap else {
            return Ok(err(StatusCode::NOT_FOUND, "Booking not found"));
        };
        let status: String = b.try_get("", "status").unwrap_or_default();
        if status == "cancelled" {
            return Ok(err(StatusCode::GONE, "Booking has been cancelled"));
        }
        let starts_ms: i64 = b
            .try_get::<chrono::DateTime<chrono::Utc>>("", "starts_at")
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        if within_12h(starts_ms) {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "A foglalás kezdete előtt 12 órán belül nem lehetséges a lemondás.",
            ));
        }
        let mut reason = "Cancelled by customer".to_string();
        if let Some(v) = body_json.as_ref() {
            if let Some(s) = v.get("reason").and_then(|x| x.as_str()) {
                let t = s.trim();
                if !t.is_empty() {
                    reason = t.chars().take(500).collect();
                }
            }
        }
        let bid: i64 = b.try_get("", "id").unwrap_or(0);
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE reservation_bookings SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $3, reminder_sent_at = NULL WHERE reservation_id = $1 AND booking_token = $2",
                vec![reservation.id.into(), token.into(), reason.into()],
            ))
            .await?;
        R::notify_booking_cancelled(&ctx.db, reservation.id, bid).await;
        tracing::info!("[reservation-embed] booking.cancel_public id={bid}");
        Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/cancel] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn reschedule_by_token(
    State(ctx): State<AppContext>,
    Path((secret, token)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    if !check_token_format(&secret) {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    if token.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Invalid booking token");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(starts_ms), Some(ends_ms)) = (R::parse_strict_iso_ms(starts_raw), R::parse_strict_iso_ms(ends_raw)) else {
        return err(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601 UTC");
    };
    if ends_ms <= starts_ms {
        return err(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let starts_iso = R::iso_of_ms(starts_ms);
    let ends_iso = R::iso_of_ms(ends_ms);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let Some(reservation) = load_reservation(&ctx.db, &secret).await? else {
            return Ok(not_found());
        };
        let ex = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rb.*, rst.name AS service_name FROM reservation_bookings rb LEFT JOIN reservation_service_translations rst ON rst.service_id = rb.service_id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id) WHERE rb.reservation_id = $1 AND rb.booking_token = $2",
                vec![reservation.id.into(), token.clone().into()],
            ))
            .await?;
        let Some(ex) = ex else {
            return Ok(err(StatusCode::NOT_FOUND, "Booking not found"));
        };
        let old_status: String = ex.try_get("", "status").unwrap_or_default();
        if old_status == "cancelled" {
            return Ok(err(StatusCode::GONE, "Booking has been cancelled"));
        }
        let old_starts: i64 = ex
            .try_get::<chrono::DateTime<chrono::Utc>>("", "starts_at")
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        if within_12h(old_starts) {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "A foglalás kezdete előtt 12 órán belül nem lehetséges a módosítás.",
            ));
        }
        let old_service_id: i64 = ex.try_get("", "service_id").unwrap_or(0);
        let svc = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, status, duration_minutes, capacity, worker_user_id, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days FROM reservation_services WHERE id = $1 AND reservation_id = $2",
                vec![old_service_id.into(), reservation.id.into()],
            ))
            .await?;
        let Some(svc) = svc else {
            return Ok(err(StatusCode::BAD_REQUEST, "Service is no longer available"));
        };
        if svc.try_get::<String>("", "status").unwrap_or_default() != "active" {
            return Ok(err(StatusCode::BAD_REQUEST, "Service is no longer available"));
        }
        let lead: i64 = svc.try_get::<i32>("", "lead_time_minutes").unwrap_or(0) as i64;
        let mad: i64 = svc.try_get::<i32>("", "max_advance_days").unwrap_or(90) as i64;
        let now_ms = R::utc_ms_now();
        if starts_ms - now_ms < lead * 60_000 {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                format!("Booking must start at least {lead} minute(s) from now"),
            ));
        }
        if starts_ms - now_ms > mad * 86_400_000 {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                format!("Booking cannot start more than {mad} day(s) from now"),
            ));
        }
        let slot: Option<i64> = svc.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64);
        let gran: String = svc.try_get::<Option<String>>("", "granularity").ok().flatten().unwrap_or_else(|| "hour".to_string());
        if let Some(slot) = slot {
            if gran != "day" {
                let wmin = R::schedule_window_start_min(&ctx.db, reservation.id, Some(old_service_id), starts_ms, &reservation.timezone).await?;
                if let Err(e) = R::validate_slot_alignment(starts_ms, ends_ms, slot, &reservation.timezone, wmin) {
                    return Ok(err(StatusCode::BAD_REQUEST, &e));
                }
            }
        }
        let old_id: i64 = ex.try_get("", "id").unwrap_or(0);
        // cancel old first (restored on failure, mirroring old code)
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE reservation_bookings SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = 'Rescheduled by customer', reminder_sent_at = NULL WHERE id = $1",
                vec![old_id.into()],
            ))
            .await?;
        let restore = || async {
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "UPDATE reservation_bookings SET status = 'confirmed', cancelled_at = NULL, cancellation_reason = NULL, reminder_sent_at = NULL WHERE id = $1",
                    vec![old_id.into()],
                ))
                .await;
        };
        match R::check_slot_availability(&ctx.db, reservation.id, Some(old_service_id), starts_ms, ends_ms).await? {
            Ok(()) => {}
            Err(_) => {
                restore().await;
                return Ok(err(StatusCode::CONFLICT, "Selected time slot is no longer available"));
            }
        }
        let overlap: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COUNT(*)::bigint AS cnt FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND id != $4 AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')",
                vec![old_service_id.into(), starts_iso.clone().into(), ends_iso.clone().into(), old_id.into()],
            ))
            .await?
            .and_then(|r| r.try_get::<i64>("", "cnt").ok())
            .unwrap_or(0);
        let cap: i64 = svc.try_get::<i32>("", "capacity").map(|v| v as i64).unwrap_or(1);
        if overlap >= cap {
            restore().await;
            return Ok(err(StatusCode::CONFLICT, "Selected time slot is no longer available"));
        }
        // create replacement (own advisory-locked txn)
        let txn = ctx.db.begin().await?;
        let new_row: Option<sea_orm::QueryResult> = (async {
            txn.execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT pg_advisory_xact_lock(hashtextextended('reservation-service:' || $1::text, 0))",
                vec![old_service_id.to_string().into()],
            ))
            .await
            .ok()?;
            let dup: bool = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT 1 AS one FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)') AND email = $4 LIMIT 1",
                    vec![
                        old_service_id.into(),
                        starts_iso.clone().into(),
                        ends_iso.clone().into(),
                        R::str_opt(&ex, "email").unwrap_or_default().into(),
                    ],
                ))
                .await
                .ok()
                .flatten()
                .is_some();
            if dup {
                txn.rollback().await.ok();
                return None;
            }
            let data_v: Option<String> = ex
                .try_get::<Option<Value>>("", "data")
                .ok()
                .flatten()
                .map(|v| v.to_string());
            let row = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_bookings (reservation_id, service_id, starts_at, ends_at, first_name, last_name, email, phone, comment, customer_id, worker_user_id, service_name_snapshot, duration_minutes_snapshot, price_amount_snapshot, currency_snapshot, timezone, status, source, locale, data) VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'confirmed','public',$17,$18::jsonb) RETURNING id, starts_at, ends_at, booked_at, booking_token",
                    vec![
                        reservation.id.into(), old_service_id.into(), starts_iso.clone().into(), ends_iso.clone().into(),
                        R::str_opt(&ex, "first_name").into(), R::str_opt(&ex, "last_name").into(),
                        R::str_opt(&ex, "email").unwrap_or_default().into(), R::str_opt(&ex, "phone").into(),
                        R::str_opt(&ex, "comment").into(),
                        ex.try_get::<Option<i64>>("", "customer_id").ok().flatten().into(),
                        ex.try_get::<Option<i64>>("", "worker_user_id").ok().flatten().into(),
                        R::str_opt(&ex, "service_name_snapshot").or_else(|| R::str_opt(&ex, "service_name")).into(),
                        ex.try_get::<Option<i32>>("", "duration_minutes_snapshot").ok().flatten().into(),
                        ex.try_get::<Option<String>>("", "price_amount_snapshot").ok().flatten().into(),
                        R::str_opt(&ex, "currency_snapshot").into(),
                        R::str_opt(&ex, "timezone").unwrap_or_else(|| reservation.timezone.clone()).into(),
                        R::str_opt(&ex, "locale").unwrap_or_else(|| "hu".to_string()).into(),
                        data_v.into(),
                    ],
                ))
                .await
                .ok()?;
            txn.commit().await.ok()?;
            row
        })
        .await;
        let Some(new_row) = new_row else {
            restore().await;
            return Ok(err(StatusCode::CONFLICT, "Selected time slot is no longer available"));
        };
        let new_id: i64 = new_row.try_get("", "id").unwrap_or(0);
        let new_token: Option<String> = new_row.try_get::<Option<String>>("", "booking_token").ok().flatten();
        R::notify_booking_cancelled(&ctx.db, reservation.id, old_id).await;
        if let Some(em) = R::str_opt(&ex, "email") {
            let sname = R::str_opt(&ex, "service_name").unwrap_or_else(|| "Reservation".to_string());
            let loc = R::str_opt(&ex, "locale").unwrap_or_else(|| "hu".to_string());
            R::send_booking_confirmation(&ctx.db, reservation.project_id, None, &em, &sname, &starts_iso, &ends_iso, &reservation.timezone, &loc, new_token.clone()).await;
        }
        tracing::info!("[reservation-embed] booking.reschedule_public old={old_id} new={new_id}");
        Ok((
            StatusCode::OK,
            Json(json!({
                "id": new_id,
                "bookingToken": new_token,
                "startsAt": starts_iso,
                "endsAt": ends_iso,
                "bookedAt": R::ts_opt(&new_row, "booked_at"),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[reservation-embed/reschedule] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/reservations")
        .add("/{secret_token}/availability", get(availability))
        .add("/{secret_token}/customer-profiles/resolve", post(resolve_profiles_handler))
        .add("/{secret_token}/bookings", post(create_booking_public))
        .add("/{secret_token}/catalog", get(catalog))
        .add("/{secret_token}/services/{serviceId}/availability", get(service_availability_public))
        .add("/assets/{filename}", get(asset))
        .add("/{secret_token}/bookings/by-token/{bookingToken}", get(booking_by_token))
        .add("/{secret_token}/bookings/by-token/{bookingToken}", delete(cancel_by_token))
        .add("/{secret_token}/bookings/by-token/{bookingToken}/reschedule", patch(reschedule_by_token))
}
