//! Routes:
//!   GET /api/settings                 — all system settings (admin only)
//!   PUT /api/settings                 — upsert settings map (admin only)
//!   GET /api/settings/vapid-public-key — VAPID public key (any auth user)

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::{json, Value};

use crate::middleware::auth::{require_admin, CurrentUser, MaybeUser};

async fn list(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT key, value AS val FROM system_settings",
            vec![],
        ))
        .await
    {
        Ok(rows) => {
            let mut settings = serde_json::Map::new();
            for r in rows {
                let key: String = match r.try_get("", "key") {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                let val: Value = r
                    .try_get::<Option<Value>>("", "val")
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null);
                settings.insert(key, val);
            }
            (StatusCode::OK, Json(json!({ "settings": settings }))).into_response()
        }
        Err(e) => {
            tracing::error!("[settings/get] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Failed to fetch settings" })),
            )
                .into_response()
        }
    }
}

async fn update(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Json(b): Json<Value>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let map = match b.get("settings").and_then(|s| s.as_object()) {
        Some(m) => m.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "Missing settings object" })),
            )
                .into_response();
        }
    };
    // Upsert each entry. Values bind as text cast to jsonb so any JSON
    // scalar/object round-trips without needing a Value->DbValue impl.
    let res: Result<()> = (async {
        for (k, v) in &map {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO system_settings (key, value, updated_at)
                     VALUES ($1, $2::jsonb, NOW())
                     ON CONFLICT (key) DO UPDATE
                       SET value = EXCLUDED.value, updated_at = NOW()",
                    vec![k.clone().into(), v.to_string().into()],
                ))
                .await?;
        }
        Ok(())
    })
    .await;
    match res {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => {
            tracing::error!("[settings/update] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Failed to update settings" })),
            )
                .into_response()
        }
    }
}

async fn vapid_public_key(user: CurrentUser) -> Response {
    let _ = user;
    let public_key = std::env::var("VAPID_PUBLIC_KEY").unwrap_or_default();
    (StatusCode::OK, Json(json!({ "publicKey": public_key }))).into_response()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/settings")
        .add("/", get(list))
        .add("/", put(update))
        .add("/vapid-public-key", get(vapid_public_key))
}
