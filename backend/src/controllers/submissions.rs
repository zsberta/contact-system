//! Cross-project aggregation reads: 1:1 port of old_backend/routes/submissions.js.
//!
//! All routes require auth; endusers are scoped to assigned projects.
//!   GET  /api/submissions/forms
//!   GET  /api/submissions/bookings
//!   GET  /api/submissions/bookings/calendar?from=&to=&projectId=
//!   POST /api/submissions/bookings  (manual admin-portal booking)
//!
//! Simplification vs the original: the manual-booking endpoint keeps the
//! strict ISO validation, reservation-active check, service resolution and
//! overlap guard, but skips the slot-grid alignment + schedule-window
//! availability helpers (reservation lib lives with another module team).
//! The DB EXCLUDE constraint remains the backstop: any insert conflict
//! surfaces as 409.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

use crate::middleware::auth::CurrentUser;
use crate::middleware::query::MultiQuery;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn iso(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ceil_div(a: i64, b: i64) -> i64 {
    ((a + b - 1) / b.max(1)).max(1)
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

struct Page {
    page: i64,
    size: i64,
    sort_field: String,
    sort_order: String,
    queries: Vec<String>,
    filter_type: String,
    project_filter: Option<i64>,
    sorted: bool,
}

fn parse_page(q: &HashMap<String, Vec<String>>) -> Page {
    let one = |k: &str| {
        q.get(k)
            .and_then(|v| v.first())
            .cloned()
            .unwrap_or_default()
    };
    let mut queries: Vec<String> = q.get("queries").cloned().unwrap_or_default();
    if let Some(extra) = q.get("queries[]") {
        queries.extend(extra.clone());
    }
    let project_filter = q
        .get("projectId")
        .and_then(|v| v.first())
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0);
    Page {
        page: one("page").parse().unwrap_or(0).max(0),
        size: one("size").parse().unwrap_or(10).clamp(1, 100),
        sort_field: one("sortField"),
        sort_order: if one("sortOrder") == "asc" { "asc".into() } else { "desc".into() },
        queries,
        filter_type: one("filterType"),
        project_filter,
        sorted: q.contains_key("sortField"),
    }
}

fn page_envelope(
    content: Vec<serde_json::Value>,
    total: i64,
    p: &Page,
) -> serde_json::Value {
    let total_pages = ceil_div(total, p.size);
    json!({
        "content": content,
        "totalElements": total,
        "totalPages": total_pages,
        "pageable": { "paged": true, "pageSize": p.size, "pageNumber": p.page,
                      "unpaged": false, "offset": p.page * p.size,
                      "sort": { "sorted": p.sorted, "unsorted": !p.sorted, "empty": false } },
        "numberOfElements": content.len(),
        "size": p.size,
        "number": p.page,
        "sort": { "sorted": p.sorted, "unsorted": !p.sorted, "empty": false },
        "first": p.page == 0,
        "last": p.page >= total_pages - 1,
        "empty": content.is_empty(),
    })
}

fn empty_page(p: &Page) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "content": [], "totalElements": 0, "totalPages": 0,
            "pageable": { "paged": true, "pageSize": p.size, "pageNumber": p.page,
                          "unpaged": false, "offset": p.page * p.size,
                          "sort": { "sorted": false, "unsorted": true, "empty": false } },
            "numberOfElements": 0, "size": p.size, "number": p.page,
            "sort": { "sorted": false, "unsorted": true, "empty": false },
            "first": true, "last": true, "empty": true,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/submissions/forms
// ---------------------------------------------------------------------------

fn form_row(row: &sea_orm::QueryResult) -> serde_json::Value {
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
        "formName": row.try_get::<Option<String>>("", "form_name").ok().flatten().unwrap_or_default(),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": row.try_get::<Option<String>>("", "project_name").ok().flatten().unwrap_or_default(),
        "submittedAt": iso(&submitted),
        "ipAddress": row.try_get::<Option<String>>("", "ip_address").ok().flatten(),
        "userAgent": row.try_get::<Option<String>>("", "user_agent").ok().flatten(),
        "referer": row.try_get::<Option<String>>("", "referer").ok().flatten(),
        "data": data,
        "locale": row.try_get::<Option<String>>("", "locale").ok().flatten(),
        "createdAt": iso(&created),
    })
}

async fn forms_list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    let p = parse_page(&q);
    let sort_field = if p.sort_field.is_empty() {
        "submittedAt"
    } else {
        p.sort_field.as_str()
    };
    let col = match sort_field {
        "submittedAt" => "s.submitted_at",
        "createdAt" => "s.created_at",
        _ => return err(StatusCode::BAD_REQUEST, "Invalid sortField"),
    };
    let dir = if p.sort_order == "asc" { "ASC" } else { "DESC" };

    let res: Result<Response, sea_orm::DbErr> = (async {
        // Search across ip/locale/data + parent form/project names.
        let terms: Vec<String> = p
            .queries
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let mut where_sql = String::new();
        let mut params: Vec<sea_orm::Value> = vec![];
        let mut next = 1i32;
        let mut scope_parts: Vec<String> = vec![];
        if user.role == "enduser" {
            if user.project_ids.is_empty() {
                return Ok(empty_page(&p));
            }
            scope_parts.push(scope_sql(&user.project_ids, "f"));
        }
        if let Some(pid) = p.project_filter {
            scope_parts.push(format!("f.project_id = ${next}"));
            params.push(pid.into());
            next += 1;
        }
        if !terms.is_empty() {
            let conj = if p.filter_type == "all" { " AND " } else { " OR " };
            let mut parts = vec![];
            for t in terms {
                let e = t.replace('%', "\\%").replace('_', "\\_");
                parts.push(format!(
                    "(s.ip_address::text ILIKE ${next} OR s.locale ILIKE ${next} OR s.data::text ILIKE ${next} OR f.name ILIKE ${next} OR proj.name ILIKE ${next})"
                ));
                params.push(format!("%{e}%").into());
                next += 1;
            }
            where_sql = format!(" AND ({})", parts.join(conj));
        }
        let scope_sql_str = if scope_parts.is_empty() {
            String::new()
        } else {
            // Re-number scope placeholders: they were built with $next voice;
            // rebuild here positionally for clarity.
            let mut s = String::new();
            for part in scope_parts {
                // `f.project_id = $N` placeholders already correct; ANY-lists inline.
                s.push_str(" AND ");
                s.push_str(&part);
            }
            s
        };
        let order = format!("ORDER BY {col} {dir}, s.id DESC");
        // Positional tail: search/scope params first, then size/offset.
        let base = params.len() as i32;
        let data_params: Vec<sea_orm::Value> = params
            .iter()
            .cloned()
            .chain(vec![p.size.into(), (p.page * p.size).into()])
            .collect();
        let limit_p = base + 1;
        let offset_p = base + 2;
        let data = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT s.id, s.form_id, s.submitted_at, s.ip_address, s.user_agent,
                            s.referer, s.data, s.locale, s.created_at,
                            f.name AS form_name, f.project_id, proj.name AS project_name
                     FROM form_submissions s
                     JOIN forms f ON f.id = s.form_id
                     JOIN projects proj ON proj.id = f.project_id
                     WHERE 1=1{scope_sql_str}{where_sql} {order}
                     LIMIT ${limit_p} OFFSET ${offset_p}"
                ),
                data_params,
            ))
            .await?;
        let count_row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT COUNT(*)::bigint AS total FROM form_submissions s
                     JOIN forms f ON f.id = s.form_id
                     JOIN projects proj ON proj.id = f.project_id
                     WHERE 1=1{scope_sql_str}{where_sql}"
                ),
                params,
            ))
            .await?;
        let total: i64 = count_row
            .and_then(|r| r.try_get("", "total").ok())
            .unwrap_or(0);
        let content: Vec<serde_json::Value> = data.iter().map(form_row).collect();
        Ok((StatusCode::OK, Json(page_envelope(content, total, &p))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[submissions/forms] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/submissions/bookings
// ---------------------------------------------------------------------------

fn booking_row(row: &sea_orm::QueryResult) -> serde_json::Value {
    let ts = |col: &str| -> serde_json::Value {
        match row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>>("", col)
            .ok()
            .flatten()
        {
            Some(d) => json!(iso(&d)),
            None => serde_json::Value::Null,
        }
    };
    let data: serde_json::Value = row
        .try_get::<Option<serde_json::Value>>("", "data")
        .ok()
        .flatten()
        .unwrap_or(serde_json::Value::Null);
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "reservationId": row.try_get::<i64>("", "reservation_id").unwrap_or(0),
        "reservationName": row.try_get::<Option<String>>("", "reservation_name").ok().flatten().unwrap_or_default(),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": row.try_get::<Option<String>>("", "project_name").ok().flatten().unwrap_or_default(),
        "startsAt": ts("starts_at"),
        "endsAt": ts("ends_at"),
        "bookedAt": ts("booked_at"),
        "ipAddress": row.try_get::<Option<String>>("", "ip_address").ok().flatten(),
        "userAgent": row.try_get::<Option<String>>("", "user_agent").ok().flatten(),
        "referer": row.try_get::<Option<String>>("", "referer").ok().flatten(),
        "locale": row.try_get::<Option<String>>("", "locale").ok().flatten(),
        "data": data,
    })
}

async fn bookings_list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    let p = parse_page(&q);
    let sort_field = if p.sort_field.is_empty() {
        "bookedAt"
    } else {
        p.sort_field.as_str()
    };
    let col = match sort_field {
        "startsAt" => "b.starts_at",
        "endsAt" => "b.ends_at",
        "bookedAt" => "b.booked_at",
        _ => return err(StatusCode::BAD_REQUEST, "Invalid sortField"),
    };
    let dir = if p.sort_order == "asc" { "ASC" } else { "DESC" };

    let res: Result<Response, sea_orm::DbErr> = (async {
        let terms: Vec<String> = p
            .queries
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let mut params: Vec<sea_orm::Value> = vec![];
        let mut next = 1i32;
        let mut scope_str = String::new();
        if user.role == "enduser" {
            if user.project_ids.is_empty() {
                return Ok(empty_page(&p));
            }
            scope_str.push_str(&format!(" AND {}", scope_sql(&user.project_ids, "r")));
        }
        if let Some(pid) = p.project_filter {
            scope_str.push_str(&format!(" AND r.project_id = ${next}"));
            params.push(pid.into());
            next += 1;
        }
        let mut where_sql = String::new();
        if !terms.is_empty() {
            let conj = if p.filter_type == "all" { " AND " } else { " OR " };
            let mut parts = vec![];
            for t in terms {
                let e = t.replace('%', "\\%").replace('_', "\\_");
                parts.push(format!(
                    "(b.ip_address::text ILIKE ${next} OR b.locale ILIKE ${next} OR b.data::text ILIKE ${next} OR r.name ILIKE ${next} OR proj.name ILIKE ${next})"
                ));
                params.push(format!("%{e}%").into());
                next += 1;
            }
            where_sql = format!(" AND ({})", parts.join(conj));
        }
        let order = format!("ORDER BY {col} {dir}, b.id DESC");
        let base = params.len() as i32;
        let data_params: Vec<sea_orm::Value> = params
            .iter()
            .cloned()
            .chain(vec![p.size.into(), (p.page * p.size).into()])
            .collect();
        let limit_p = base + 1;
        let offset_p = base + 2;
        let data = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
                            b.ip_address, b.user_agent, b.referer, b.data, b.locale,
                            r.name AS reservation_name, r.project_id, proj.name AS project_name
                     FROM reservation_bookings b
                     JOIN reservations r ON r.id = b.reservation_id
                     JOIN projects proj ON proj.id = r.project_id
                     WHERE 1=1{scope_str}{where_sql} {order}
                     LIMIT ${limit_p} OFFSET ${offset_p}"
                ),
                data_params,
            ))
            .await?;
        let count_row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT COUNT(*)::bigint AS total FROM reservation_bookings b
                     JOIN reservations r ON r.id = b.reservation_id
                     JOIN projects proj ON proj.id = r.project_id
                     WHERE 1=1{scope_str}{where_sql}"
                ),
                params,
            ))
            .await?;
        let total: i64 = count_row
            .and_then(|r| r.try_get("", "total").ok())
            .unwrap_or(0);
        let content: Vec<serde_json::Value> = data.iter().map(booking_row).collect();
        Ok((StatusCode::OK, Json(page_envelope(content, total, &p))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[submissions/bookings] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/submissions/bookings/calendar?from=&to=&projectId=
// ---------------------------------------------------------------------------

async fn bookings_calendar(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let from_raw = q.get("from").cloned().unwrap_or_default();
    let to_raw = q.get("to").cloned().unwrap_or_default();
    if from_raw.is_empty() || to_raw.is_empty() {
        return err(StatusCode::BAD_REQUEST, "from and to are required");
    }
    let parse_dt = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
            .or_else(|| {
                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
                    .ok()
                    .map(|n| {
                        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                            n,
                            chrono::Utc,
                        )
                    })
            })
    };
    let (Some(from), Some(to)) = (parse_dt(&from_raw), parse_dt(&to_raw)) else {
        return err(StatusCode::BAD_REQUEST, "Invalid date range");
    };
    let project_filter: Option<i64> = q
        .get("projectId")
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0);

    let res: Result<Response, sea_orm::DbErr> = (async {
        let mut scope_str = String::new();
        let mut scope_params: Vec<sea_orm::Value> = vec![];
        let mut next = 3i32;
        if user.role == "enduser" {
            if user.project_ids.is_empty() {
                return Ok((StatusCode::OK, Json(json!({ "bookings": [], "reservations": [] })))
                    .into_response());
            }
            scope_str.push_str(&format!(" AND {}", scope_sql(&user.project_ids, "r")));
        }
        if let Some(pid) = project_filter {
            scope_str.push_str(&format!(" AND r.project_id = ${next}"));
            scope_params.push(pid.into());
            next += 1;
        }
        let bookings = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
                            b.ip_address, b.user_agent, b.referer, b.data, b.locale,
                            r.name AS reservation_name, r.project_id, r.granularity,
                            r.slot_duration_minutes, proj.name AS project_name
                     FROM reservation_bookings b
                     JOIN reservations r ON r.id = b.reservation_id
                     JOIN projects proj ON proj.id = r.project_id
                     WHERE b.starts_at >= $1 AND b.starts_at < $2{scope_str}
                     ORDER BY b.starts_at ASC LIMIT 5000"
                ),
                vec![
                    from.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                    to.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                ]
                .into_iter()
                .chain(scope_params.clone())
                .collect::<Vec<sea_orm::Value>>(),
            ))
            .await?;
        let bookings_json: Vec<serde_json::Value> = bookings
            .iter()
            .map(|row| {
                let mut v = booking_row(row);
                v["granularity"] = row
                    .try_get::<Option<String>>("", "granularity")
                    .ok()
                    .flatten()
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
                v["slotDurationMinutes"] = row
                    .try_get::<Option<i32>>("", "slot_duration_minutes")
                    .ok()
                    .flatten()
                    .map(|n| json!(n))
                    .unwrap_or(serde_json::Value::Null);
                v
            })
            .collect();

        // Accessible active reservations for the dropdown.
        let mut rscope = String::new();
        let mut rparams: Vec<sea_orm::Value> = vec![];
        let mut rn = 1i32;
        if user.role == "enduser" {
            if user.project_ids.is_empty() {
                return Ok((
                    StatusCode::OK,
                    Json(json!({ "bookings": bookings_json, "reservations": [] })),
                )
                    .into_response());
            }
            rscope.push_str(&format!(" AND {}", scope_sql(&user.project_ids, "r")));
        }
        if let Some(pid) = project_filter {
            rscope.push_str(&format!(" AND r.project_id = ${rn}"));
            rparams.push(pid.into());
            rn += 1;
        }
        let _ = (rn, next);
        let resv = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT r.id, r.name, r.project_id, r.granularity,
                            r.slot_duration_minutes, r.status, proj.name AS project_name
                     FROM reservations r
                     JOIN projects proj ON proj.id = r.project_id
                     WHERE r.status = 'active'{rscope}
                     ORDER BY proj.name, r.name"
                ),
                rparams,
            ))
            .await?;
        let reservations: Vec<serde_json::Value> = resv
            .iter()
            .map(|row| {
                json!({
                    "id": row.try_get::<i64>("", "id").unwrap_or(0),
                    "name": row.try_get::<Option<String>>("", "name").ok().flatten().unwrap_or_default(),
                    "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
                    "projectName": row.try_get::<Option<String>>("", "project_name").ok().flatten().unwrap_or_default(),
                    "granularity": row.try_get::<Option<String>>("", "granularity").ok().flatten(),
                    "slotDurationMinutes": row.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten(),
                    "status": row.try_get::<Option<String>>("", "status").ok().flatten().unwrap_or_default(),
                })
            })
            .collect();
        Ok((
            StatusCode::OK,
            Json(json!({ "bookings": bookings_json, "reservations": reservations })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[submissions/bookings/calendar] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/submissions/bookings — manual booking (portal)
// ---------------------------------------------------------------------------

fn parse_strict_iso(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if s.is_empty() {
        return None;
    }
    // Strict-ish UTC shape: YYYY-MM-DDTHH:mm[:ss[.mmm]](Z|±HH:mm)
    let mut core = s;
    let has_tz = core.ends_with('Z')
        || (core.len() > 6
            && (core.as_bytes()[core.len() - 3] == b':')
            && (core.as_bytes()[core.len() - 6] == b'+'
                || core.as_bytes()[core.len() - 6] == b'-'));
    if !has_tz {
        return None;
    }
    if core.ends_with('Z') {
        core = &core[..core.len() - 1];
    } else {
        core = &core[..core.len() - 6];
    }
    let date_ok = core.len() >= 16
        && core.as_bytes().get(4) == Some(&b'-')
        && core.as_bytes().get(7) == Some(&b'-')
        && core.as_bytes().get(10) == Some(&b'T')
        && core.as_bytes().get(13) == Some(&b':');
    if !date_ok {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
}

async fn booking_create(
    State(ctx): State<AppContext>,
    _user: CurrentUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let reservation_id = body
        .get("reservationId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    if reservation_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid reservationId");
    }
    let starts_raw = body
        .get("startsAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ends_raw = body
        .get("endsAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (Some(starts), Some(ends)) =
        (parse_strict_iso(starts_raw), parse_strict_iso(ends_raw))
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "startsAt and endsAt must be ISO 8601 UTC",
        );
    };
    if ends <= starts {
        return err(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }

    let res: Result<Response, sea_orm::DbErr> = (async {
        let rv = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, status FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(rr) = rv else {
            return Ok(err(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        let status: Option<String> = rr.try_get("", "status").ok().flatten();
        if status.as_deref() != Some("active") {
            return Ok(err(StatusCode::BAD_REQUEST, "Reservation is not active"));
        }
        // Resolve service: explicit active service or default first-active.
        let requested: Option<i64> = body
            .get("serviceId")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
            .filter(|n| *n > 0);
        let service_id: Option<i64> = if let Some(sid) = requested {
            let chk = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2 AND status = 'active'",
                    vec![sid.into(), reservation_id.into()],
                ))
                .await?;
            if chk.is_none() {
                return Ok(err(StatusCode::BAD_REQUEST, "Invalid or inactive service"));
            }
            Some(sid)
        } else {
            let def = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM reservation_services
                     WHERE reservation_id = $1 AND status = 'active'
                     ORDER BY sort_order, id LIMIT 1",
                    vec![reservation_id.into()],
                ))
                .await?;
            match def.and_then(|r| r.try_get::<i64>("", "id").ok()) {
                Some(id) => Some(id),
                None => {
                    return Ok(err(
                        StatusCode::BAD_REQUEST,
                        "No active service found for this reservation",
                    ))
                }
            }
        };
        let service_id = service_id.unwrap_or(0);
        // Overlap guard (the DB EXCLUDE constraint is the backstop).
        let overlap = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM reservation_bookings
                 WHERE reservation_id = $1 AND starts_at < $2::timestamptz AND ends_at > $3::timestamptz LIMIT 1",
                vec![
                    reservation_id.into(),
                    ends.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                    starts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                ],
            ))
            .await?;
        if overlap.is_some() {
            return Ok(err(StatusCode::CONFLICT, "Slot already booked"));
        }
        let data_val: Option<serde_json::Value> = body.get("data").cloned().filter(|v| {
            v.is_object() && v.as_object().map(|o| !o.is_empty()).unwrap_or(false)
        });
        let ins = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_bookings
                   (reservation_id, service_id, starts_at, ends_at, ip_address,
                    user_agent, referer, locale, data)
                 VALUES ($1, $2, $3::timestamptz, $4::timestamptz, NULL, 'admin-panel', NULL, NULL, $5::jsonb)
                 RETURNING id, starts_at, ends_at, booked_at",
                vec![
                    reservation_id.into(),
                    service_id.into(),
                    starts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                    ends.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into(),
                    data_val.into(),
                ],
            ))
            .await;
        let row = match ins {
            Ok(Some(r)) => r,
            Ok(None) => {
                return Ok(err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                ))
            }
            Err(e) => {
                let msg = format!("{e:?}");
                if msg.contains("23P01")
                    || msg.contains("exclusion")
                    || msg.contains("overlap")
                {
                    return Ok(err(StatusCode::CONFLICT, "Slot already booked"));
                }
                tracing::error!("[submissions/bookings/create] {e:?}");
                return Ok(err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                ));
            }
        };
        let id: i64 = row.try_get("", "id")?;
        let fmt = |c: &str| {
            row.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", c)
                .ok()
                .flatten()
                .map(|d| iso(&d))
                .unwrap_or_default()
        };
        Ok((
            StatusCode::CREATED,
            Json(json!({
                "id": id,
                "reservationId": reservation_id,
                "startsAt": fmt("starts_at"),
                "endsAt": fmt("ends_at"),
                "bookedAt": fmt("booked_at"),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[submissions/bookings/create] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/submissions")
        .add("/forms", get(forms_list))
        .add("/bookings", get(bookings_list))
        .add("/bookings/calendar", get(bookings_calendar))
        .add("/bookings", post(booking_create))
}
