//! CORS layer for the public embed surface.
//!
//! All `/api/public/*` endpoints are meant to be called cross-origin
//! (contact-form snippet, analytics loader, AI-assistant widget and any
//! future direct-fetch reservation integration) from customer sites such
//! as `https://zsoltberta.hu`, while the API itself lives on
//! `https://nexus.zsoltberta.hu`.
//!
//! Without this layer every cross-origin `fetch`/XHR fails in the
//! browser:
//!   - "simple" requests (e.g. `text/plain` beacons) are blocked because
//!     the response has no `Access-Control-Allow-Origin` header;
//!   - preflighted requests (`application/json` POST/PATCH/DELETE) send
//!     `OPTIONS` first, which has no route and answers `405` — again
//!     with no `Access-Control-Allow-Origin` — so the browser reports
//!     `CORS Missing Allow Origin` / `Status code: 405` and never sends
//!     the real request. Submissions, bookings, analytics events and AI
//!     chat are all silently lost.
//!
//! This middleware (installed outermost in `after_routes`, so it runs
//! first):
//!   - short-circuits `OPTIONS /api/public/*` with `204` + the
//!     preflight headers (before rate-limiting, so preflights never
//!     consume quota);
//!   - stamps `Access-Control-Allow-Origin` (+ `Vary: Origin`) on every
//!     other `/api/public/*` response, including errors (404/429/...),
//!     so the browser surfaces the real status instead of a CORS error.
//!
//! Security: the per-resource `allowed_origins` allowlist enforced inside
//! each controller is untouched — a disallowed origin still gets an
//! indistinguishable `404` body. This layer only makes that answer
//! *readable* cross-origin; it grants no data.

use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

const ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS_DEFAULT: &str =
    "Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN, X-Reservation-Parent-Origin";
const MAX_AGE: &str = "86400";

fn allow_origin_value(origin: &str) -> HeaderValue {
    if origin.is_empty() {
        return HeaderValue::from_static("*");
    }
    HeaderValue::from_str(origin).unwrap_or_else(|_| HeaderValue::from_static("*"))
}

fn vary_value(existing: Option<&HeaderValue>) -> HeaderValue {
    match existing.and_then(|v| v.to_str().ok()) {
        Some(cur) if cur.to_ascii_lowercase().contains("origin") => {
            // Already varies on Origin — keep as-is.
            HeaderValue::from_str(cur).unwrap_or_else(|_| HeaderValue::from_static("Origin"))
        }
        Some(cur) if cur.is_empty() => HeaderValue::from_static("Origin"),
        Some(cur) => {
            let merged = format!("{cur}, Origin");
            HeaderValue::from_str(&merged).unwrap_or_else(|_| HeaderValue::from_static("Origin"))
        }
        None => HeaderValue::from_static("Origin"),
    }
}

pub async fn cors_public(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/public/") {
        return next.run(req).await;
    }

    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Preflight: answer directly, never reaching rate-limit / handlers.
    if req.method() == axum::http::Method::OPTIONS {
        let requested_headers = req
            .headers()
            .get("access-control-request-headers")
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ALLOW_HEADERS_DEFAULT.to_string());
        let mut res = (StatusCode::NO_CONTENT, "").into_response();
        let headers = res.headers_mut();
        headers.insert("access-control-allow-origin", allow_origin_value(&origin));
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static(ALLOW_METHODS),
        );
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_str(&requested_headers)
                .unwrap_or_else(|_| HeaderValue::from_static(ALLOW_HEADERS_DEFAULT)),
        );
        headers.insert("access-control-max-age", HeaderValue::from_static(MAX_AGE));
        headers.insert("vary", HeaderValue::from_static("Origin"));
        headers.insert("content-length", HeaderValue::from_static("0"));
        return res;
    }

    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert("access-control-allow-origin", allow_origin_value(&origin));
    let vary = vary_value(headers.get("vary"));
    headers.insert("vary", vary);
    res
}
