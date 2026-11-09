//! Notifications (+push lib).
//!
//! All routes require auth (CurrentUser → 401 JSON when anonymous).
//!   GET  /api/notifications
//!   GET  /api/notifications/unread-count?since=
//!   POST /api/notifications/opened
//!   GET  /api/notifications/push-status?endpoint=
//!   POST /api/notifications/subscribe   { endpoint, keys: { p256dh, auth }, deviceName? }
//!   POST /api/notifications/unsubscribe { endpoint }
//!
//! Browser-push fan-out lives centrally in crate::push::create_notification
//! — no route here sends push directly.

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

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn notif_dto(row: &sea_orm::QueryResult) -> serde_json::Value {
    let created: chrono::DateTime<chrono::Utc> = row
        .try_get("", "created_at")
        .unwrap_or_else(|_| chrono::Utc::now());
    let meta: serde_json::Value = row
        .try_get::<Option<serde_json::Value>>("", "metadata")
        .ok()
        .flatten()
        .unwrap_or(json!({}));
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "userId": row.try_get::<i32>("", "user_id").unwrap_or(0),
        "type": row.try_get::<Option<String>>("", "type").ok().flatten().unwrap_or_else(|| "SYSTEM".to_string()),
        "title": row.try_get::<Option<String>>("", "title").ok().flatten().unwrap_or_default(),
        "message": row.try_get::<Option<String>>("", "message").ok().flatten().unwrap_or_default(),
        "entityType": row.try_get::<Option<String>>("", "entity_type").ok().flatten(),
        "entityId": row.try_get::<Option<i32>>("", "entity_id").ok().flatten(),
        "metadata": meta,
        "createdAt": created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

// ---------------------------------------------------------------------------
// GET /api/notifications — cursor pagination (?cursor=<ts>:<id>&limit=)
// ---------------------------------------------------------------------------

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let limit: i64 = q
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 50);
    let (cursor_ts, cursor_id): (Option<String>, Option<i64>) = q
        .get("cursor")
        .and_then(|c| {
            let decoded = urlencoding_decode(c)?;
            let idx = decoded.rfind(':')?;
            if idx == 0 {
                return None;
            }
            let ts = decoded[..idx].to_string();
            let id = decoded[idx + 1..].parse::<i64>().ok()?;
            Some((ts, id))
        })
        .map(|(a, b)| (Some(a), Some(b)))
        .unwrap_or((None, None));

    let res: Result<Response, sea_orm::DbErr> = (async {
        let (sql, params): (String, Vec<sea_orm::Value>) =
            match (cursor_ts, cursor_id) {
                (Some(ts), Some(cid)) => (
                    "SELECT id, user_id, type, title, message, entity_type, entity_id, metadata, created_at
                     FROM notifications WHERE user_id = $1
                       AND (created_at, id) < ($2::timestamptz, $3)
                     ORDER BY created_at DESC, id DESC LIMIT $4"
                        .to_string(),
                    vec![user.id.into(), ts.into(), cid.into(), (limit + 1).into()],
                ),
                _ => (
                    "SELECT id, user_id, type, title, message, entity_type, entity_id, metadata, created_at
                     FROM notifications WHERE user_id = $1
                     ORDER BY created_at DESC, id DESC LIMIT $2"
                        .to_string(),
                    vec![user.id.into(), (limit + 1).into()],
                ),
            };
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                sql,
                params,
            ))
            .await?;
        let has_more = rows.len() as i64 > limit;
        let page_rows = if has_more { &rows[..limit as usize] } else { &rows[..] };
        let dto: Vec<serde_json::Value> = page_rows.iter().map(notif_dto).collect();
        let next_cursor = if has_more {
            page_rows.last().map(|r| {
                let created: chrono::DateTime<chrono::Utc> = r
                    .try_get("", "created_at")
                    .unwrap_or_else(|_| chrono::Utc::now());
                let id: i64 = r.try_get("", "id").unwrap_or(0);
                format!(
                    "{}:{id}",
                    created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                )
            })
        } else {
            None
        };
        Ok((
            StatusCode::OK,
            Json(json!({ "notifications": dto, "nextCursor": next_cursor })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[notifications/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch notifications")
        }
    }
}

fn urlencoding_decode(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut bytes = s.as_bytes().iter().peekable();
    while let Some(&b) = bytes.next() {
        if b == b'%' {
            let h1 = *bytes.next()? as char;
            let h2 = *bytes.next()? as char;
            let byte = u8::from_str_radix(&format!("{h1}{h2}"), 16).ok()?;
            out.push(byte as char);
        } else if b == b'+' {
            out.push(' ');
        } else {
            out.push(b as char);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// GET /api/notifications/unread-count?since=
// ---------------------------------------------------------------------------

async fn unread_count(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let since = q.get("since").cloned().unwrap_or_default();
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = if since.is_empty() {
            ctx.db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1",
                    vec![user.id.into()],
                ))
                .await?
        } else {
            ctx.db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT COUNT(*)::int AS count FROM notifications
                     WHERE user_id = $1 AND created_at > $2::timestamptz",
                    vec![user.id.into(), since.into()],
                ))
                .await?
        };
        let count: i32 = row.and_then(|r| r.try_get("", "count").ok()).unwrap_or(0);
        Ok((StatusCode::OK, Json(json!({ "count": count }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[notifications/unread-count] {e:?}");
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch unread count",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/notifications/opened
// ---------------------------------------------------------------------------

async fn opened(State(_ctx): State<AppContext>, _user: CurrentUser) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "openedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/notifications/push-status?endpoint=
// ---------------------------------------------------------------------------

async fn push_status(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let endpoint = q.get("endpoint").cloned().unwrap_or_default();
    if endpoint.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Missing endpoint");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
                vec![user.id.into(), endpoint.into()],
            ))
            .await?;
        Ok((
            StatusCode::OK,
            Json(json!({ "subscribed": row.is_some() })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[notifications/push-status] {e:?}");
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to check subscription",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/notifications/subscribe
// ---------------------------------------------------------------------------

async fn subscribe(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let endpoint = body
        .get("endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let p256dh = body
        .get("keys")
        .and_then(|k| k.get("p256dh"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let auth = body
        .get("keys")
        .and_then(|k| k.get("auth"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let device_name = body
        .get("deviceName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Device")
        .to_string();
    if endpoint.is_empty() || p256dh.is_empty() || auth.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Missing endpoint or keys");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        // Portable upsert (SELECT-then-write): works whether endpoint is
        // UNIQUE alone or per (user_id, endpoint) — ON CONFLICT cannot
        // target both, so the explicit check covers either shape.
        let existing = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
                vec![user.id.into(), endpoint.clone().into()],
            ))
            .await?;
        match existing {
            Some(r) => {
                let id: i64 = r.try_get("", "id")?;
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "UPDATE push_subscriptions SET keys_p256dh = $2, keys_auth = $3,
                           device_name = $4, updated_at = NOW() WHERE id = $1",
                        vec![
                            id.into(),
                            p256dh.clone().into(),
                            auth.clone().into(),
                            device_name.clone().into(),
                        ],
                    ))
                    .await?;
            }
            None => {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, device_name)
                         VALUES ($1, $2, $3, $4, $5)",
                        vec![
                            user.id.into(),
                            endpoint.clone().into(),
                            p256dh.clone().into(),
                            auth.clone().into(),
                            device_name.clone().into(),
                        ],
                    ))
                    .await?;
            }
        }
        // Same browser subscription, other accounts: keep their keys in sync.
        let _ = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE push_subscriptions SET keys_p256dh = $2, keys_auth = $3, updated_at = NOW()
                 WHERE endpoint = $1 AND user_id <> $4",
                vec![
                    endpoint.into(),
                    p256dh.into(),
                    auth.into(),
                    user.id.into(),
                ],
            ))
            .await;
        Ok((
            StatusCode::CREATED,
            Json(json!({ "status": "subscribed" })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[notifications/subscribe] {e:?}");
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to save subscription",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/notifications/unsubscribe
// ---------------------------------------------------------------------------

async fn unsubscribe(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let endpoint = body
        .get("endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if endpoint.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Missing endpoint");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
                vec![endpoint.clone().into(), user.id.into()],
            ))
            .await?;
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COUNT(*)::int AS remaining FROM push_subscriptions WHERE endpoint = $1",
                vec![endpoint.into()],
            ))
            .await?;
        let remaining: i32 = row
            .and_then(|r| r.try_get("", "remaining").ok())
            .unwrap_or(0);
        Ok((
            StatusCode::OK,
            Json(json!({ "status": "unsubscribed", "remaining": remaining })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[notifications/unsubscribe] {e:?}");
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to remove subscription",
            )
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/notifications")
        .add("/", get(list))
        .add("/unread-count", get(unread_count))
        .add("/opened", post(opened))
        .add("/push-status", get(push_status))
        .add("/subscribe", post(subscribe))
        .add("/unsubscribe", post(unsubscribe))
}
