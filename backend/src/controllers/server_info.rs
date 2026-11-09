//! Admin-only server monitoring API (read-only):
//!   GET /api/server-info              — full snapshot (self + email + tables + docker)
//!   GET /api/server-info/containers/{id} — full inspect of one container
//!
//! Docker data comes from the read-only socket-proxy at DOCKER_PROXY_URL
//! via reqwest GETs only. This service never shells out to docker (or df):
//! host disk figures are omitted (null) by design.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;
use std::collections::HashMap;
use std::time::Instant;

use crate::middleware::auth::{require_admin, MaybeUser};
use crate::workers::server_info as server_info_worker;

// ---------------------------------------------------------------------------
// Host facts (Linux /proc, graceful nulls elsewhere). The container is
// Debian; local macOS dev gets nulls the same way missing /proc would.
// ---------------------------------------------------------------------------

static STARTED_AT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn uptime_sec() -> u64 {
    STARTED_AT.get_or_init(Instant::now).elapsed().as_secs()
}

fn rustc_version() -> String {
    option_env!("RUSTC_VERSION").unwrap_or("unknown").to_string()
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn proc_file(name: &str) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{name}")).ok()
}

fn load_avg() -> Vec<f64> {
    proc_file("loadavg")
        .and_then(|s| {
            let v: Vec<f64> = s.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
            if v.len() == 3 { Some(v) } else { None }
        })
        .unwrap_or_else(|| vec![0.0, 0.0, 0.0])
}

fn cpu_count() -> Option<u32> {
    std::thread::available_parallelism().ok().map(|n| n.get() as u32)
}

fn meminfo_kb(key: &str) -> Option<u64> {
    proc_file("meminfo")?.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        if it.next()? == format!("{key}:") {
            it.next()?.parse::<u64>().ok()
        } else {
            None
        }
    })
}

fn mem_total_bytes() -> Option<u64> {
    meminfo_kb("MemTotal").map(|kb| kb * 1024)
}

fn mem_free_bytes() -> Option<u64> {
    // MemAvailable is the honest "free for new work" figure.
    meminfo_kb("MemAvailable")
        .or_else(|| meminfo_kb("MemFree"))
        .map(|kb| kb * 1024)
}

fn process_memory() -> serde_json::Value {
    // rss from /proc/self/statm (pages * page size); heap detail doesn't
    // exist for Rust — report rss and mirror it so shape matches.
    let rss: u64 = std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map(|pages| pages * 4096)
        .unwrap_or(0);
    serde_json::json!({ "rss": rss, "heapUsed": rss, "heapTotal": rss, "external": 0 })
}

fn is_secret_key(key: &str) -> bool {
    let upper = key.to_uppercase();
    ["PASS", "SECRET", "TOKEN", "KEY", "PRIVATE", "CREDENTIAL", "DATABASE", "DATABASE_URL", "DSN"]
        .iter()
        .any(|s| upper.contains(s))
}

/// Scrub embedded credentials in URLs (postgres://user:pass@host/…) in ANY
/// env value, not just secret-keyed ones.
fn scrub_url_creds(value: &str) -> String {
    // Look for "://...:...@" — replace the userinfo password segment.
    if let Some(scheme_end) = value.find("://") {
        let rest = &value[scheme_end + 3..];
        if let Some(at) = rest.find('@') {
            let userinfo = &rest[..at];
            if let Some(colon) = userinfo.find(':') {
                let user = &userinfo[..colon];
                return format!("{}://{}:***@{}", &value[..scheme_end], user, &rest[at + 1..]);
            }
        }
    }
    value.to_string()
}

fn redact_inspect(mut raw: serde_json::Value) -> serde_json::Value {
    let env = raw
        .get("Config")
        .and_then(|c| c.get("Env"))
        .and_then(|e| e.as_array())
        .cloned();
    if let Some(entries) = env {
        let redacted: Vec<serde_json::Value> = entries
            .into_iter()
            .map(|entry| match entry.as_str() {
                None => entry,
                Some(s) => match s.find('=') {
                    None => entry,
                    Some(eq) => {
                        let (key, value) = s.split_at(eq);
                        let value = &value[1..];
                        if is_secret_key(key) {
                            json!(format!("{key}=***"))
                        } else {
                            let scrubbed = scrub_url_creds(value);
                            if scrubbed != value {
                                json!(format!("{key}={scrubbed}"))
                            } else {
                                entry
                            }
                        }
                    }
                },
            })
            .collect();
        if let Some(cfg) = raw.get_mut("Config") {
            if let Some(obj) = cfg.as_object_mut() {
                obj.insert("Env".to_string(), json!(redacted));
            }
        }
    }
    raw
}

fn uploads_usage() -> serde_json::Value {
    let dir = std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string());
    const MAX_FILES: usize = 50_000;
    let mut total_bytes: u64 = 0;
    let mut file_count: usize = 0;
    let mut truncated = false;
    let mut stack = vec![dir.clone()];
    let mut error: Option<String> = None;
    while let Some(p) = stack.pop() {
        if file_count >= MAX_FILES {
            truncated = true;
            break;
        }
        match std::fs::read_dir(&p) {
            Ok(entries) => {
                for e in entries.flatten() {
                    if file_count >= MAX_FILES {
                        truncated = true;
                        break;
                    }
                    let path = e.path();
                    if path.is_dir() {
                        stack.push(path.to_string_lossy().to_string());
                    } else if path.is_file() {
                        file_count += 1;
                        if let Ok(md) = std::fs::metadata(&path) {
                            total_bytes += md.len();
                        }
                    }
                }
            }
            Err(e) => {
                error = Some(e.to_string());
                break;
            }
        }
    }
    // read_dir on a missing dir surfaces here; surface it in `error`, keep zeros.
    json!({ "dir": dir, "totalBytes": total_bytes, "fileCount": file_count, "truncated": truncated, "error": error })
}

async fn table_count(ctx: &AppContext, table: &str, extra_where: &str) -> i64 {
    let sql = format!("SELECT COUNT(*)::int AS n FROM {table} {extra_where}");
    ctx.db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &sql,
            vec![],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<i32>("", "n").ok())
        .unwrap_or(0) as i64
}

async fn snapshot(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    // DB latency + pool-less health flag.
    let t0 = Instant::now();
    let db_ok = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT 1 AS one",
            vec![],
        ))
        .await
        .is_ok();
    let latency_ms = t0.elapsed().as_millis() as i64;

    let (users, projects, forms, form_submissions, reservations, bookings, upcoming_bookings, customers, activity_logs, errors24h) = tokio::join!(
        table_count(&ctx, "users", ""),
        table_count(&ctx, "projects", ""),
        table_count(&ctx, "forms", ""),
        table_count(&ctx, "form_submissions", ""),
        table_count(&ctx, "reservations", ""),
        table_count(&ctx, "reservation_bookings", ""),
        table_count(&ctx, "reservation_bookings", "WHERE starts_at > NOW()"),
        table_count(&ctx, "reservation_customers", ""),
        table_count(&ctx, "activity_logs", ""),
        table_count(&ctx, "activity_logs", "WHERE action_type = 'ERROR' AND created_at > NOW() - INTERVAL '24 hours'"),
    );

    // Email aggregates (best-effort; queue counters come from the mailer stub).
    let email_sending = std::env::var("EMAIL_SENDING").map(|v| v != "false").unwrap_or(true);
    let smtp_host = std::env::var("SMTP_HOST").unwrap_or_default();
    let transport = if !email_sending { "disabled" } else if smtp_host.is_empty() { "json-dev" } else { "smtp" };
    let (sent24h, failed24h) = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT COUNT(*)::int AS sent24h,
                    COUNT(*) FILTER (WHERE ok = false)::int AS failed24h
             FROM activity_logs
             WHERE action = 'email.send' AND created_at > NOW() - INTERVAL '24 hours'",
            vec![],
        ))
        .await
        .ok()
        .flatten()
    {
        Some(r) => (
            r.try_get::<i32>("", "sent24h").unwrap_or(0),
            r.try_get::<i32>("", "failed24h").unwrap_or(0),
        ),
        None => (0, 0),
    };
    let by_kind_7d: Vec<serde_json::Value> = ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT COALESCE(metadata->>'kind', 'unknown') AS kind,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE ok = true)::int AS delivered,
                    COUNT(*) FILTER (WHERE ok = false)::int AS failed
             FROM activity_logs
             WHERE action = 'email.send' AND created_at > NOW() - INTERVAL '7 days'
             GROUP BY 1 ORDER BY total DESC",
            vec![],
        ))
        .await
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    json!({
                        "kind": r.try_get::<Option<String>>("", "kind").ok().flatten().unwrap_or_else(|| "unknown".to_string()),
                        "total": r.try_get::<i32>("", "total").unwrap_or(0),
                        "delivered": r.try_get::<i32>("", "delivered").unwrap_or(0),
                        "failed": r.try_get::<i32>("", "failed").unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let recent_failures: Vec<serde_json::Value> = ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT created_at, action, entity_label,
                    metadata->>'to' AS recipient,
                    metadata->>'subject' AS subject,
                    COALESCE(metadata->>'error', metadata->'error'->>'message', metadata->'error'->>'code') AS error
             FROM activity_logs
             WHERE action = 'email.send' AND ok = false
             ORDER BY id DESC LIMIT 10",
            vec![],
        ))
        .await
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let created: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "created_at").ok();
                    json!({
                        "createdAt": created.map(|t| t.to_rfc3339()),
                        "action": r.try_get::<Option<String>>("", "action").ok().flatten(),
                        "entityLabel": r.try_get::<Option<String>>("", "entity_label").ok().flatten(),
                        "recipient": r.try_get::<Option<String>>("", "recipient").ok().flatten(),
                        "subject": r.try_get::<Option<String>>("", "subject").ok().flatten(),
                        "error": r.try_get::<Option<String>>("", "error").ok().flatten(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Docker host (read-only proxy). Served from the cached snapshot in
    // workers::server_info docker caching (SERVER_INFO_POLL_MS cadence,
    // ?refresh=1 forces a re-poll subject to a 10s floor, last-good
    // snapshot kept on error). Same response shapes as live polling.
    let force_refresh = q.get("refresh").map(|v| v == "1").unwrap_or(false);
    let docker_snapshot = if force_refresh {
        server_info_worker::refresh_docker_snapshot().await
    } else {
        server_info_worker::docker_snapshot().await
    };

    (
        StatusCode::OK,
        Json(json!({
            "collectedAt": chrono::Utc::now().to_rfc3339(),
            "app": {
                "nodeVersion": format!("rust-{} (loco)", rustc_version()),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": hostname(),
                "uptimeSec": uptime_sec(),
                "loadAvg": load_avg(),
                "cpuCount": cpu_count(),
                "memTotalBytes": mem_total_bytes(),
                "memFreeBytes": mem_free_bytes(),
                "processMemory": process_memory(),
                "eventLoopLagMs": crate::workers::server_info::event_loop_lag_ms(),
                "env": std::env::var("LOCO_ENV").ok().filter(|v| !v.is_empty()).or_else(|| std::env::var("NODE_ENV").ok()).unwrap_or_else(|| "development".to_string()),
                "db": if db_ok { json!({ "ok": true, "latencyMs": latency_ms, "pool": { "total": 10, "idle": 10, "waiting": 0, "max": 10 } }) }
                      else { json!({ "ok": false, "error": "DB unreachable" }) },
                "uploads": uploads_usage(),
                "disk": null,
            },
            "email": {
                "transport": transport,
                "sendingEnabled": email_sending,
                "smtpConfigured": !smtp_host.is_empty(),
                "queue": { "pending": 0, "inFlight": 0 },
                "sent24h": sent24h,
                "failed24h": failed24h,
                "byKind7d": by_kind_7d,
                "recentFailures": recent_failures,
            },
            "tables": {
                "users": users,
                "projects": projects,
                "forms": forms,
                "formSubmissions": form_submissions,
                "reservations": reservations,
                "bookings": bookings,
                "upcomingBookings": upcoming_bookings,
                "customers": customers,
                "activityLogs": activity_logs,
                "errors24h": errors24h,
            },
            "docker": docker_snapshot,
        })),
    )
        .into_response()
}

async fn inspect(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let proxy_raw = std::env::var("DOCKER_PROXY_URL").unwrap_or_default();
    let proxy_trimmed = proxy_raw.trim().trim_end_matches('/').to_string();
    let base = if proxy_trimmed.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "errorMessage": "Docker host monitoring is not configured" })),
        )
            .into_response();
    } else {
        proxy_trimmed
    };
    let valid = id.len() >= 12 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "errorMessage": "Invalid container id" })),
        )
            .into_response();
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    match client
        .get(format!("{base}/containers/{id}/json?size=1"))
        .send()
        .await
    {
        Err(e) => {
            tracing::error!("[server-info/inspect] {e:?}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "errorMessage": "Failed to inspect container" })),
            )
                .into_response()
        }
        Ok(res) => {
            let status = res.status().as_u16();
            if status == 404 {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "errorMessage": "Container not found" })),
                )
                    .into_response();
            }
            if status == 400 {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "errorMessage": "Invalid container id" })),
                )
                    .into_response();
            }
            if !res.status().is_success() {
                tracing::error!("[server-info/inspect] upstream HTTP {status}");
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "errorMessage": "Failed to inspect container" })),
                )
                    .into_response();
            }
            match res.json::<serde_json::Value>().await {
                Ok(v) => (StatusCode::OK, Json(redact_inspect(v))).into_response(),
                Err(e) => {
                    tracing::error!("[server-info/inspect] decode {e:?}");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "errorMessage": "Failed to inspect container" })),
                    )
                        .into_response()
                }
            }
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/server-info")
        .add("/", get(snapshot))
        .add("/containers/{id}", get(inspect))
}
