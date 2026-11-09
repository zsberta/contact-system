//! CSRF layer.
//!
//! Double-submit check on state-changing methods: `XSRF-TOKEN` cookie must
//! equal the `x-xsrf-token` header. Exempt: safe methods, public auth paths,
//! `/api/public/*`, `/api/internal/*`.

use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

const PUBLIC_AUTH_PATHS: &[&str] = &[
    "/api/auth/signin",
    "/api/auth/refresh",
    "/api/auth/set-password",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/csrf",
    "/api/csrf/refresh",
];

fn is_exempt(path: &str) -> bool {
    if PUBLIC_AUTH_PATHS.contains(&path) {
        return true;
    }
    if path.starts_with("/api/public/") || path.starts_with("/api/internal/") {
        return true;
    }
    false
}

fn cookie_token(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some(v) = pair.strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
    }
    None
}

pub async fn csrf_protection(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    if is_exempt(&path) {
        return next.run(req).await;
    }
    let cookie = cookie_token(req.headers(), "XSRF-TOKEN");
    let header = req
        .headers()
        .get("x-xsrf-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    match (cookie, header) {
        (Some(c), Some(h)) if c == h => next.run(req).await,
        _ => (
            StatusCode::FORBIDDEN,
            Json(json!({ "errorMessage": "Invalid CSRF token" })),
        )
            .into_response(),
    }
}

/// Origin/Referer check for state-changing non-public API calls.
/// Extra defense-in-depth for state-changing API calls.
pub async fn origin_check(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    if path.starts_with("/api/public/") {
        return next.run(req).await;
    }
    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            req.headers()
                .get("referer")
                .and_then(|v| v.to_str().ok())
                .and_then(|r| r.split('/').take(3).collect::<Vec<_>>().get(..3).map(|p| p.join("/")))
        });
    if let Some(o) = origin {
        if let Some(host) = req.headers().get("host").and_then(|v| v.to_str().ok()) {
            // req is not necessarily absolute; compare against host header.
            let scheme = "http";
            let expected_http = format!("{scheme}://{host}");
            let expected_https = format!("https://{host}");
            if o != expected_http && o != expected_https {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "errorMessage": "Cross-origin rejected" })),
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}
