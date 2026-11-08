//! Per-IP fixed-window rate limiting.
//!
//! 1:1 port of the `express-rate-limit` wiring in the old backend:
//!   - `old_backend/server.js` — global `/api` catch-all
//!     (`API_GLOBAL_LIMIT`, default 10000/min, "Too many requests")
//!   - `old_backend/routes/auth.js` — signin / refresh / forgot+reset /
//!     set-password limiters with their exact windows, caps and messages
//!   - `old_backend/routes/{form,reservation,analytics,ai-assistant}-embed.js`
//!     — burst + sustained chains on the mutating public endpoints
//!   - `old_backend/routes/{blog,faq,service}-public.js` — 30/min +
//!     600/hour on the public read surface
//!
//! Fixed-window counters keyed per surface + client IP, exactly like the
//! old `keyGenerator: (req) => \`<surface>:${req.ip}\`` scheme. IP
//! resolution mirrors `trust proxy = 1`: first valid `X-Forwarded-For`
//! entry wins, then `X-Real-Ip`, then the socket peer address.
//!
//! Installed as a single global `from_fn` layer in `after_routes` that
//! dispatches by method + path, so the old per-router mounting order is
//! preserved (global first, then the specific limiter — the first
//! tripped limiter decides the 429 body).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

struct Bucket {
    count: u64,
    start: Instant,
}

#[derive(Clone)]
struct Limiter {
    max: u64,
    window: Duration,
    message: &'static str,
    buckets: Arc<Mutex<HashMap<String, Bucket>>>,
}

impl Limiter {
    fn new(env: &str, default_max: u64, window: Duration, message: &'static str) -> Self {
        let max = std::env::var(env)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default_max);
        Self::fixed(max, window, message)
    }

    fn fixed(max: u64, window: Duration, message: &'static str) -> Self {
        Self {
            max,
            window,
            message,
            buckets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Fixed-window check. Returns `true` when the request may proceed.
    fn allow(&self, key: &str) -> bool {
        let mut map = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 200_000 {
            let now = Instant::now();
            let window = self.window;
            map.retain(|_, b| now.duration_since(b.start) < window * 2);
        }
        let now = Instant::now();
        let bucket = map
            .entry(key.to_string())
            .or_insert(Bucket { count: 0, start: now });
        if now.duration_since(bucket.start) >= self.window {
            bucket.count = 0;
            bucket.start = now;
        }
        if bucket.count >= self.max {
            return false;
        }
        bucket.count += 1;
        true
    }
}

const MIN: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86400);
const MIN15: Duration = Duration::from_secs(900);

fn global() -> &'static Limiter {
    static L: LazyLock<Limiter> =
        LazyLock::new(|| Limiter::new("API_GLOBAL_LIMIT", 10_000, MIN, "Too many requests"));
    &L
}
fn signin() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "SIGNIN_LIMIT",
            5000,
            MIN15,
            "Too many sign-in attempts, try again later",
        )
    });
    &L
}
fn refresh() -> &'static Limiter {
    static L: LazyLock<Limiter> =
        LazyLock::new(|| Limiter::new("REFRESH_LIMIT", 10_000, MIN, "Too many requests"));
    &L
}
fn forgot() -> &'static Limiter {
    static L: LazyLock<Limiter> =
        LazyLock::new(|| Limiter::new("FORGOT_LIMIT", 5000, MIN15, "Too many requests"));
    &L
}
fn set_password() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new("SET_PASSWORD_LIMIT", 5000, MIN15, "Too many requests")
    });
    &L
}
fn ai_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_AI_ASSISTANT_BURST_LIMIT",
            30,
            MIN,
            "Too many requests, please try again later",
        )
    });
    &L
}
fn ai_sustained() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_AI_ASSISTANT_SUSTAINED_LIMIT",
            500,
            DAY,
            "Too many requests, please try again later",
        )
    });
    &L
}
fn analytics_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_ANALYTICS_COLLECT_BURST_LIMIT",
            10_000,
            MIN,
            "Too many requests, please try again later",
        )
    });
    &L
}
fn analytics_sustained() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_ANALYTICS_COLLECT_SUSTAINED_LIMIT",
            100_000,
            DAY,
            "Too many requests, please try again later",
        )
    });
    &L
}
fn form_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_FORM_SUBMISSION_BURST_LIMIT",
            10_000,
            MIN,
            "Too many submissions, please try again later",
        )
    });
    &L
}
fn form_sustained() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_FORM_SUBMISSION_SUSTAINED_LIMIT",
            100_000,
            DAY,
            "Too many submissions, please try again later",
        )
    });
    &L
}
fn reservation_booking_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_RESERVATION_BOOKING_BURST_LIMIT",
            10_000,
            MIN,
            "Too many bookings, please try again later",
        )
    });
    &L
}
fn reservation_avail_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_RESERVATION_AVAILABILITY_BURST_LIMIT",
            20_000,
            MIN,
            "Too many availability checks, please try again later",
        )
    });
    &L
}
fn reservation_sustained() -> &'static Limiter {
    static L: LazyLock<Limiter> = LazyLock::new(|| {
        Limiter::new(
            "PUBLIC_RESERVATION_SUSTAINED_LIMIT",
            100_000,
            DAY,
            "Too many requests, please try again later",
        )
    });
    &L
}
fn cms_burst() -> &'static Limiter {
    static L: LazyLock<Limiter> =
        LazyLock::new(|| Limiter::fixed(30, MIN, "Too many requests"));
    &L
}
fn cms_sustained() -> &'static Limiter {
    static L: LazyLock<Limiter> =
        LazyLock::new(|| Limiter::fixed(600, HOUR, "Too many requests"));
    &L
}

/// Resolve the client IP the way the old `trust proxy = 1` setup did:
/// first valid `X-Forwarded-For` entry, else `X-Real-Ip`, else the socket
/// peer address.
fn client_ip(req: &Request<Body>) -> String {
    if let Some(xff) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        for part in xff.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if part.parse::<std::net::IpAddr>().is_ok() {
                return format!("ip:{part}");
            }
        }
    }
    if let Some(real) = req
        .headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        if real.parse::<std::net::IpAddr>().is_ok() {
            return format!("ip:{real}");
        }
    }
    if let Some(peer) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
    {
        return format!("ip:{}", peer.0.ip());
    }
    "ip:unknown".to_string()
}

fn too_many(message: &'static str) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "errorMessage": message })),
    )
        .into_response()
}

/// Global layer entry point. Mirrors the old mounting order: the global
/// `/api` limiter runs first, then the surface-specific limiter(s).
pub async fn limit_all(req: Request<Body>, next: Next) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") {
        return next.run(req).await;
    }
    let ip = client_ip(&req);

    // Global catch-all first (old server.js mounted it before the routers).
    if !global().allow(&ip) {
        return too_many(global().message);
    }

    // Surface-specific limiters, in old route order (burst before sustained).
    let specific: &[&Limiter] = match (method.as_str(), path.as_str()) {
        ("POST", "/api/auth/signin") => &[signin()],
        ("POST", "/api/auth/refresh") => &[refresh()],
        ("POST", "/api/auth/forgot-password") | ("POST", "/api/auth/reset-password") => &[forgot()],
        ("POST", "/api/auth/set-password") => &[set_password()],
        ("POST", p) if p.starts_with("/api/public/ai-assistant/") && p.ends_with("/chat") => {
            &[ai_burst(), ai_sustained()]
        }
        ("POST", p) if p.starts_with("/api/public/analytics/") && p.ends_with("/collect") => {
            &[analytics_burst(), analytics_sustained()]
        }
        ("POST", p) if p.starts_with("/api/public/forms/") && p.ends_with("/submissions") => {
            &[form_burst(), form_sustained()]
        }
        (_, p) if p.starts_with("/api/public/reservations/") => {
            if (method == "GET" && p.contains("/availability"))
                || (method == "POST" && p.ends_with("/customer-profiles/resolve"))
            {
                &[reservation_avail_burst(), reservation_sustained()]
            } else if (method == "POST" && p.ends_with("/bookings"))
                || method == "DELETE"
                || method == "PATCH"
            {
                &[reservation_booking_burst(), reservation_sustained()]
            } else {
                &[reservation_sustained()]
            }
        }
        (_, p)
            if p.starts_with("/api/public/blog/")
                || p.starts_with("/api/public/faq/")
                || p.starts_with("/api/public/service/") =>
        {
            &[cms_burst(), cms_sustained()]
        }
        _ => &[],
    };
    for limiter in specific {
        if !limiter.allow(&ip) {
            return too_many(limiter.message);
        }
    }
    next.run(req).await
}
