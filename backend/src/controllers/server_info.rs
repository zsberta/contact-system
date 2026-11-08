//! Port of old_backend/routes/server-info.js + lib/server-info.js.
//!
//! Admin-only server monitoring API (read-only):
//!   GET /api/server-info              — full snapshot (self + email + tables + docker)
//!   GET /api/server-info/containers/{id} — full inspect of one container
//!
//! Docker data comes from the read-only socket-proxy at DOCKER_PROXY_URL
//! via reqwest GETs only. This port never shells out to docker (or df):
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

const DOCKER_TIMEOUT_SECS: u64 = 5;

fn proxy_base() -> Option<String> {
    let raw = std::env::var("DOCKER_PROXY_URL").unwrap_or_default();
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
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

async fn docker_get(base: &str, path: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DOCKER_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{base}{path}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("docker {path} → HTTP {}", res.status()));
    }
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

fn size_or_null(v: &serde_json::Value) -> serde_json::Value {
    match v.as_i64() {
        Some(n) => json!(n),
        None => match v.as_u64() {
            Some(n) if n <= i64::MAX as u64 => json!(n as i64),
            _ => json!(null),
        },
    }
}

fn map_containers(list: &serde_json::Value) -> Vec<serde_json::Value> {
    match list.as_array() {
        None => vec![],
        Some(items) => items
            .iter()
            .map(|c| {
                let id = c.get("Id").and_then(|v| v.as_str()).unwrap_or("");
                let created = c.get("Created").and_then(|v| v.as_i64()).map(|ts| {
                    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
                        .map(|t| t.to_rfc3339())
                        .unwrap_or_default()
                });
                json!({
                    "id": id.get(..12).unwrap_or(id),
                    "names": c.get("Names").and_then(|v| v.as_array()).map(|ns| {
                        ns.iter().map(|n| n.as_str().unwrap_or("").trim_start_matches('/').to_string()).collect::<Vec<_>>()
                    }).unwrap_or_default(),
                    "image": c.get("Image").and_then(|v| v.as_str()).unwrap_or(""),
                    "state": c.get("State").and_then(|v| v.as_str()).unwrap_or("unknown"),
                    "status": c.get("Status").and_then(|v| v.as_str()).unwrap_or(""),
                    "createdAt": created,
                    "sizeRwBytes": c.get("SizeRw").map(size_or_null).unwrap_or(json!(null)),
                    "sizeRootFsBytes": c.get("SizeRootFs").map(size_or_null).unwrap_or(json!(null)),
                })
            })
            .collect(),
    }
}

fn num_or_null(v: Option<&serde_json::Value>) -> serde_json::Value {
    match v {
        Some(x) if x.is_number() => x.clone(),
        _ => json!(null),
    }
}

fn map_engine_info(info: &serde_json::Value) -> serde_json::Value {
    json!({
        "serverVersion": info.get("ServerVersion").cloned().unwrap_or(json!(null)),
        "operatingSystem": info.get("OperatingSystem").cloned().unwrap_or(json!(null)),
        "architecture": info.get("Architecture").cloned().unwrap_or(json!(null)),
        "kernelVersion": info.get("KernelVersion").cloned().unwrap_or(json!(null)),
        "osType": info.get("OSType").cloned().unwrap_or(json!(null)),
        "ncpu": num_or_null(info.get("NCPU")),
        "memTotalBytes": num_or_null(info.get("MemTotal")),
        "containersTotal": num_or_null(info.get("Containers")),
        "containersRunning": num_or_null(info.get("ContainersRunning")),
        "containersPaused": num_or_null(info.get("ContainersPaused")),
        "containersStopped": num_or_null(info.get("ContainersStopped")),
        "imagesTotal": num_or_null(info.get("Images")),
    })
}

fn sum_size(items: Option<&Vec<serde_json::Value>>, pick: impl Fn(&serde_json::Value) -> Option<i64>) -> serde_json::Value {
    let mut total: i64 = 0;
    let mut count = 0i64;
    if let Some(arr) = items {
        for it in arr {
            count += 1;
            if let Some(v) = pick(it) {
                total = total.saturating_add(v);
            }
        }
    }
    json!({ "count": count, "totalBytes": total })
}

fn as_i64(v: Option<&serde_json::Value>) -> Option<i64> {
    v.and_then(|x| x.as_i64().or_else(|| x.as_u64().and_then(|n| i64::try_from(n).ok())))
}

fn map_disk_usage(df: &serde_json::Value) -> serde_json::Value {
    let arr = |k: &str| df.get(k).and_then(|v| v.as_array());
    let mut reclaimable: i64 = 0;
    if let Some(images) = arr("Images") {
        for i in images {
            if as_i64(i.get("Containers")) == Some(0) {
                if let Some(s) = as_i64(i.get("Size")) {
                    reclaimable = reclaimable.saturating_add(s);
                }
            }
        }
    }
    json!({
        "images": sum_size(arr("Images"), |i| as_i64(i.get("Size"))),
        "containers": sum_size(arr("Containers"), |c| as_i64(c.get("SizeRw"))),
        "volumes": sum_size(arr("Volumes"), |v| as_i64(v.get("UsageData").and_then(|u| u.get("Size")))),
        "buildCache": sum_size(arr("BuildCache"), |b| as_i64(b.get("Size"))),
        "reclaimableBytes": reclaimable,
    })
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
    let _ = q.get("refresh"); // accepted for compat; this port polls live on every request.

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

    // Docker host (read-only proxy). Nulls when unconfigured, like the old snapshot.
    let (docker_configured, docker_snapshot) = match proxy_base() {
        None => (
            false,
            json!({ "configured": false, "lastPollAt": null, "lastError": null,
                    "containers": null, "engine": null, "diskUsage": null }),
        ),
        Some(base) => {
            let (list, info, df) = tokio::join!(
                docker_get(&base, "/containers/json?all=1&size=1"),
                docker_get(&base, "/info"),
                docker_get(&base, "/system/df"),
            );
            match (list, info, df) {
                (Ok(l), Ok(i), Ok(d)) => (
                    true,
                    json!({
                        "configured": true,
                        "lastPollAt": chrono::Utc::now().to_rfc3339(),
                        "lastError": null,
                        "containers": map_containers(&l),
                        "engine": map_engine_info(&i),
                        "diskUsage": map_disk_usage(&d),
                    }),
                ),
                (l, i, d) => {
                    let err = l.err().or(i.err()).or(d.err()).unwrap_or_default();
                    tracing::error!("[server-info] docker poll failed: {err}");
                    (
                        true,
                        json!({ "configured": true, "lastPollAt": null, "lastError": err,
                                "containers": null, "engine": null, "diskUsage": null }),
                    )
                }
            }
        }
    };
    let _ = docker_configured;

    (
        StatusCode::OK,
        Json(json!({
            "collectedAt": chrono::Utc::now().to_rfc3339(),
            "app": {
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "env": std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
                "db": if db_ok { json!({ "ok": true, "latencyMs": latency_ms }) }
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
    let base = match proxy_base() {
        Some(b) => b,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "errorMessage": "Docker host monitoring is not configured" })),
            )
                .into_response();
        }
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
        .timeout(std::time::Duration::from_secs(DOCKER_TIMEOUT_SECS))
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
