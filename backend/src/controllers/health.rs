//! GET /api/health — mirrors old_backend/server.js health probe.
//! `{ status: "ok", db: "up" }` or 500 `{ status: "error", db: "down" }`
//! (never leaks the pg error text).

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

async fn health(State(ctx): State<AppContext>) -> impl IntoResponse {
    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match ctx
        .db
        .query_one_raw(Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT 1".to_string(),
        ))
        .await
    {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(json!({ "status": "ok", "db": "up", "uptime": uptime })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("[health] db check failed: {}", e);
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "db": "down" })),
            )
                .into_response()
        }
    }
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api").add("/health", get(health))
}
