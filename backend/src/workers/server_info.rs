//! Collection model: an in-process tick keeps a cached
//! docker snapshot; the API serves the snapshot (instant page loads) and a
//! `?refresh=1` query forces a re-poll subject to a 10s min interval so the
//! Refresh button can't hammer the daemon.
//!
//! Response shapes are byte-identical to what the controller built when it
//! live-polled: `docker_snapshot()` / `refresh_docker_snapshot()` return the
//! exact `{ configured, lastPollAt, lastError, containers, engine,
//! diskUsage }` object. On poll failure the previous good snapshot is kept
//! and only `lastError` is updated.
//!
//! The per-request self metrics (DB latency, table counts, email
//! aggregates, uploads walk) stay live in the controller — only the docker
//! host section is cached, since that is the slow/remote part.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use tokio::sync::Mutex;

const DOCKER_TIMEOUT_SECS: u64 = 5;
const REFRESH_MIN_SECS: u64 = 10;
const LAG_SAMPLE_SECS: u64 = 5;
const UNSET_LAG: u64 = u64::MAX;

/// Background docker-poll cadence (mirrors SERVER_INFO_POLL_MS, default 60000).
pub fn poll_ms() -> u64 {
    std::env::var("SERVER_INFO_POLL_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(60_000)
}

fn proxy_base() -> Option<String> {
    let raw = std::env::var("DOCKER_PROXY_URL").unwrap_or_default();
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[derive(Default)]
struct DockerCache {
    containers: Option<Vec<serde_json::Value>>,
    engine: Option<serde_json::Value>,
    disk_usage: Option<serde_json::Value>,
    last_poll_at: Option<std::time::Instant>,
    last_poll_at_str: Option<String>,
    last_error: Option<String>,
}

static CACHE: OnceLock<Mutex<DockerCache>> = OnceLock::new();

fn cache() -> &'static Mutex<DockerCache> {
    CACHE.get_or_init(|| Mutex::new(DockerCache::default()))
}

fn render(guard: &DockerCache, configured: bool) -> serde_json::Value {
    serde_json::json!({
        "configured": configured,
        "lastPollAt": guard.last_poll_at_str,
        "lastError": guard.last_error,
        "containers": guard.containers.clone().map(serde_json::Value::Array).unwrap_or(serde_json::Value::Null),
        "engine": guard.engine.clone().unwrap_or(serde_json::Value::Null),
        "diskUsage": guard.disk_usage.clone().unwrap_or(serde_json::Value::Null),
    })
}

fn unconfigured_snapshot() -> serde_json::Value {
    serde_json::json!({
        "configured": false,
        "lastPollAt": null,
        "lastError": null,
        "containers": null,
        "engine": null,
        "diskUsage": null,
    })
}

/// Serve the cached docker snapshot, polling now when stale (older than
/// SERVER_INFO_POLL_MS). Concurrent callers serialize on the cache lock and
/// share the fresh result — concurrent callers coalesce onto one poll via
/// the cache lock (single-flight `dockerPollInFlight` guard).
pub async fn docker_snapshot() -> serde_json::Value {
    let base = match proxy_base() {
        Some(b) => b,
        None => return unconfigured_snapshot(),
    };
    let mut guard = cache().lock().await;
    let stale = guard
        .last_poll_at
        .map(|t| t.elapsed().as_millis() as u64 >= poll_ms())
        .unwrap_or(true);
    if stale {
        poll_now(&base, &mut guard).await;
    }
    render(&guard, true)
}

/// Port of `refreshDockerSnapshot`: force a docker re-poll unless one
/// happened less than 10s ago (and a snapshot exists).
pub async fn refresh_docker_snapshot() -> serde_json::Value {
    let base = match proxy_base() {
        Some(b) => b,
        None => return unconfigured_snapshot(),
    };
    let mut guard = cache().lock().await;
    let recent = guard
        .last_poll_at
        .map(|t| t.elapsed().as_secs() < REFRESH_MIN_SECS)
        .unwrap_or(false);
    // Page-load collection already polls when stale; the Refresh button
    // path honours a 10s floor so it can't hammer the daemon.
    if !(recent && guard.containers.is_some()) {
        poll_now(&base, &mut guard).await;
    }
    render(&guard, true)
}

async fn poll_now(base: &str, guard: &mut DockerCache) {
    let (list, info, df) = tokio::join!(
        docker_get(base, "/containers/json?all=1&size=1"),
        docker_get(base, "/info"),
        docker_get(base, "/system/df"),
    );
    match (list, info, df) {
        (Ok(l), Ok(i), Ok(d)) => {
            guard.containers = Some(map_containers(&l));
            guard.engine = Some(map_engine_info(&i));
            guard.disk_usage = Some(map_disk_usage(&d));
            guard.last_poll_at = Some(std::time::Instant::now());
            guard.last_poll_at_str = Some(chrono::Utc::now().to_rfc3339());
            guard.last_error = None;
        }
        (l, i, d) => {
            // Keep the previous good snapshot; surface the error instead of
            // failing.
            let err = l.err().or(i.err()).or(d.err()).unwrap_or_default();
            tracing::error!("[server-info] docker poll failed: {err}");
            guard.last_error = Some(err);
        }
    }
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
        Some(n) => serde_json::json!(n),
        None => match v.as_u64() {
            Some(n) if n <= i64::MAX as u64 => serde_json::json!(n as i64),
            _ => serde_json::json!(null),
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
                serde_json::json!({
                    "id": id.get(..12).unwrap_or(id),
                    "names": c.get("Names").and_then(|v| v.as_array()).map(|ns| {
                        ns.iter().map(|n| n.as_str().unwrap_or("").trim_start_matches('/').to_string()).collect::<Vec<_>>()
                    }).unwrap_or_default(),
                    "image": c.get("Image").and_then(|v| v.as_str()).unwrap_or(""),
                    "state": c.get("State").and_then(|v| v.as_str()).unwrap_or("unknown"),
                    "status": c.get("Status").and_then(|v| v.as_str()).unwrap_or(""),
                    "createdAt": created,
                    "sizeRwBytes": c.get("SizeRw").map(size_or_null).unwrap_or(serde_json::json!(null)),
                    "sizeRootFsBytes": c.get("SizeRootFs").map(size_or_null).unwrap_or(serde_json::json!(null)),
                })
            })
            .collect(),
    }
}

fn num_or_null(v: Option<&serde_json::Value>) -> serde_json::Value {
    match v {
        Some(x) if x.is_number() => x.clone(),
        _ => serde_json::json!(null),
    }
}

fn map_engine_info(info: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "serverVersion": info.get("ServerVersion").cloned().unwrap_or(serde_json::json!(null)),
        "operatingSystem": info.get("OperatingSystem").cloned().unwrap_or(serde_json::json!(null)),
        "architecture": info.get("Architecture").cloned().unwrap_or(serde_json::json!(null)),
        "kernelVersion": info.get("KernelVersion").cloned().unwrap_or(serde_json::json!(null)),
        "osType": info.get("OSType").cloned().unwrap_or(serde_json::json!(null)),
        "ncpu": num_or_null(info.get("NCPU")),
        "memTotalBytes": num_or_null(info.get("MemTotal")),
        "containersTotal": num_or_null(info.get("Containers")),
        "containersRunning": num_or_null(info.get("ContainersRunning")),
        "containersPaused": num_or_null(info.get("ContainersPaused")),
        "containersStopped": num_or_null(info.get("ContainersStopped")),
        "imagesTotal": num_or_null(info.get("Images")),
    })
}

fn sum_size(
    items: Option<&Vec<serde_json::Value>>,
    pick: impl Fn(&serde_json::Value) -> Option<i64>,
) -> serde_json::Value {
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
    serde_json::json!({ "count": count, "totalBytes": total })
}

fn as_i64(v: Option<&serde_json::Value>) -> Option<i64> {
    v.and_then(|x| {
        x.as_i64()
            .or_else(|| x.as_u64().and_then(|n| i64::try_from(n).ok()))
    })
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
    serde_json::json!({
        "images": sum_size(arr("Images"), |i| as_i64(i.get("Size"))),
        "containers": sum_size(arr("Containers"), |c| as_i64(c.get("SizeRw"))),
        "volumes": sum_size(arr("Volumes"), |v| as_i64(v.get("UsageData").and_then(|u| u.get("Size")))),
        "buildCache": sum_size(arr("BuildCache"), |b| as_i64(b.get("Size"))),
        "reclaimableBytes": reclaimable,
    })
}

// ---------------------------------------------------------------------------
// Event-loop-lag sampler (mirrors the 5s sampleEventLoopLag tick)
// ---------------------------------------------------------------------------

static LAG_MS: AtomicU64 = AtomicU64::new(UNSET_LAG);

/// Approximation of `eventLoopLagMs`: the overshoot of a yielded
/// task, sampled every 5s. Clamped to 0 below 2ms.
/// Currently informational only — no response field consumes it, so adding
/// the sampler cannot change any response shape.
pub fn event_loop_lag_ms() -> Option<u64> {
    match LAG_MS.load(Ordering::Relaxed) {
        UNSET_LAG => None,
        v => Some(v),
    }
}

async fn sample_event_loop_lag() {
    let start = std::time::Instant::now();
    tokio::task::yield_now().await;
    let lag = start.elapsed().as_millis().min((UNSET_LAG - 1) as u128) as u64;
    LAG_MS.store(if lag <= 1 { 0 } else { lag }, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// spawn — wired from boot (same pattern as startServerInfo)
// ---------------------------------------------------------------------------

/// Start background polling: the 5s lag sampler plus the docker poll every
/// SERVER_INFO_POLL_MS (initial poll fire-and-forget so the first page load
/// has data). No-op when DISABLE_SERVER_INFO=true.
pub fn spawn() {
    if std::env::var("DISABLE_SERVER_INFO").as_deref() == Ok("true") {
        tracing::info!("[server-info] disabled by DISABLE_SERVER_INFO=true");
        return;
    }
    tokio::spawn(async move {
        loop {
            sample_event_loop_lag().await;
            tokio::time::sleep(std::time::Duration::from_secs(LAG_SAMPLE_SECS)).await;
        }
    });
    let cadence = poll_ms();
    tokio::spawn(async move {
        // Initial docker poll (fire-and-forget) so the first page load has data.
        let _ = docker_snapshot().await;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(cadence)).await;
            let _ = docker_snapshot().await;
        }
    });
    tracing::info!(
        "[server-info] started (docker poll every {}s)",
        cadence / 1000
    );
}
