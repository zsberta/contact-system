//! Service-to-service endpoint for the host-cron landing rebuild wrapper:
//!   POST /api/internal/landing-build-status
//!
//! Auth is a shared secret in the X-Internal-Secret header, compared in
//! constant time against INTERNAL_SECRET (falling back to the legacy
//! LANDING_INTERNAL_SECRET name). No cookies/JWT — the cron script has none.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::{json, Value};

fn internal_secret() -> String {
    std::env::var("INTERNAL_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("LANDING_INTERNAL_SECRET")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default()
}

fn timing_safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut mismatch = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        mismatch |= x ^ y;
    }
    mismatch == 0
}

fn check_secret(headers: &HeaderMap) -> bool {
    let expected = internal_secret();
    if expected.is_empty() {
        return false;
    }
    match headers
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
    {
        Some(provided) => timing_safe_equal(provided, &expected),
        None => false,
    }
}

async fn landing_build_status(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Json(b): Json<Value>,
) -> Response {
    if !check_secret(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "errorMessage": "Unauthorized" })),
        )
            .into_response();
    }

    let domain = b.get("domain").and_then(|v| v.as_str()).unwrap_or("");
    if domain.is_empty() || domain.len() > 255 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "errorMessage": "Invalid domain" })),
        )
            .into_response();
    }
    let status = b.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "success" && status != "failed" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "errorMessage": "status must be 'success' or 'failed'" })),
        )
            .into_response();
    }
    if let Some(log) = b.get("log") {
        if !(log.is_string() && log.as_str().map(|s| s.len()).unwrap_or(usize::MAX) <= 8000) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "log must be a string up to 8000 chars" })),
            )
                .into_response();
        }
    }
    if let Some(d) = b.get("durationMs") {
        if !(d.is_number() && d.as_f64().map(|n| n >= 0.0 && n <= 86_400_000.0).unwrap_or(false)) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "durationMs must be a non-negative number" })),
            )
                .into_response();
        }
    }
    let log: Option<String> = b
        .get("log")
        .and_then(|v| v.as_str())
        .map(|s| s[s.len().saturating_sub(2000)..].to_string());

    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE projects
              SET landing_last_build_at = now(),
                  landing_last_build_status = $1,
                  landing_last_build_log = $2
              WHERE domain_address = $3
                 OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $3
              RETURNING id",
            vec![status.to_string().into(), log.into(), domain.to_lowercase().into()],
        ))
        .await
    {
        Ok(rows) => {
            if rows.is_empty() {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "errorMessage": "Project not found for domain" })),
                )
                    .into_response();
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::error!("[internal/landing-build-status] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response()
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/internal")
        .add("/landing-build-status", post(landing_build_status))
}
