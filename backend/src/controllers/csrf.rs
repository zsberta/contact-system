//! CSRF token endpoint: 1:1 port of old_backend/routes/csrf.js.
//! GET /api/csrf, POST /api/csrf/refresh — both issue a fresh token.

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use serde_json::json;

fn issue() -> impl IntoResponse {
    const H: &[u8] = b"0123456789abcdef";
    let mut bytes = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(64);
    for b in bytes {
        token.push(H[(b >> 4) as usize] as char);
        token.push(H[(b & 0xf) as usize] as char);
    }
    let secure = std::env::var("COOKIE_SECURE").map(|v| v == "true").unwrap_or(false);
    let samesite = std::env::var("COOKIE_SAMESITE").unwrap_or_else(|_| "Lax".to_string());
    let mut cookie = format!("XSRF-TOKEN={token}; Path=/; Max-Age=3600; SameSite={samesite}");
    if secure {
        cookie.push_str("; Secure");
    }
    // NOTE: XSRF-TOKEN is intentionally readable from JS (no HttpOnly).
    let exp = chrono::Utc::now().timestamp() + 3600;
    let mut resp = (
        axum::http::StatusCode::OK,
        Json(json!({
            "parameterName": "_csrf",
            "headerName": "X-XSRF-TOKEN",
            "token": token,
            "expirationTime": exp,
        })),
    )
        .into_response();
    resp.headers_mut()
        .append(axum::http::header::SET_COOKIE, cookie.parse().unwrap());
    resp
}

async fn get_token() -> impl IntoResponse {
    issue()
}

async fn refresh_token() -> impl IntoResponse {
    issue()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/csrf")
        .add("/", get(get_token))
        .add("/refresh", post(refresh_token))
}
