// lib/server-info.js
//
// Admin-only server monitoring data collector. Powers GET /api/server-info
// (routes/server-info.js) and the ServerInfoPage frontend.
//
// Three data sources, all read-only:
//
//   1. Self (always available, no host access): Node process + OS numbers
//      via stdlib `os`/`process`, DB pool stats + latency, uploads dir
//      size via fs walk (no shell-out, so it works on macOS dev and the
//      Linux VPS alike), live email-queue counters via getQueueStats(),
//      and DB-backed email/row-count aggregates from activity_logs.
//   2. Docker host (only when DOCKER_PROXY_URL is set — the read-only
//      socket-proxy sidecar in docker-compose*.yml): container list,
//      engine info, and disk usage via the Engine HTTP API. The proxy
//      runs with POST=0, so only GET endpoints are reachable; we
//      deliberately NEVER call /containers/:id/json (leaks env vars).
//
// Collection model mirrors lib/reservation-reminders.js: an in-process
// setInterval tick started from server.js keeps a cached snapshot; the
// API serves the snapshot (instant page loads) and a ?refresh=1 query
// forces a re-poll subject to a 10s min interval so the page's Refresh
// button can't hammer the daemon.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { getQueueStats } from "./email-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POLL_MS = parseInt(process.env.SERVER_INFO_POLL_MS || "60000", 10) || 60000;
const REFRESH_MIN_MS = 10_000;
const DOCKER_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Docker host polling (via read-only proxy)
// ---------------------------------------------------------------------------

function proxyBase() {
  const raw = (process.env.DOCKER_PROXY_URL || "").trim().replace(/\/+$/, "");
  return raw.length > 0 ? raw : null;
}

async function dockerGet(base, apiPath) {
  const res = await fetch(`${base}${apiPath}`, {
    signal: AbortSocketTimeout(),
  });
  if (!res.ok) throw new Error(`docker ${apiPath} → HTTP ${res.status}`);
  return res.json();
}

function AbortSocketTimeout() {
  // AbortSignal.timeout is stdlib (Node 18+) — no dep, no timer leak.
  return AbortSignal.timeout(DOCKER_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Single-container inspect (on-demand, never cached). Env values whose key
// looks secret-bearing are redacted to "***" — keys stay visible so the
// modal can show "what is configured" without leaking the value. Full
// 64-char IDs are accepted so a compromised admin session can't use this
// endpoint to probe anything but a real container id.
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|DATABASE|DATABASE_URL|DSN/i;
// Embedded credentials in URLs (postgres://user:pass@host/…) — the key
// (e.g. DATABASE_URL) doesn't always match SECRET_KEY_RE, so scrub the
// userinfo segment in ANY env value, not just secret-keyed ones.
const URL_CREDS_RE = /^(.*:\/\/[^/\s]*?):[^/\s@]*@/;
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/i;

function redactInspect(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const env = raw?.Config?.Env;
  if (!Array.isArray(env)) return raw;
  const redactedEnv = env.map((entry) => {
    if (typeof entry !== "string") return entry;
    const eq = entry.indexOf("=");
    if (eq === -1) return entry;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (SECRET_KEY_RE.test(key)) return `${key}=***`;
    const scrubbed = value.replace(URL_CREDS_RE, "$1:***@");
    if (scrubbed !== value) return `${key}=${scrubbed}`;
    return entry;
  });
  return {
    ...raw,
    Config: { ...raw.Config, Env: redactedEnv },
  };
}

export async function inspectContainer(id) {
  const base = proxyBase();
  if (!base) {
    const err = new Error("Docker host monitoring is not configured");
    err.status = 503;
    throw err;
  }
  if (typeof id !== "string" || !CONTAINER_ID_RE.test(id)) {
    const err = new Error("Invalid container id");
    err.status = 400;
    throw err;
  }
  const res = await fetch(`${base}/containers/${encodeURIComponent(id)}/json?size=1`, {
    signal: AbortSocketTimeout(),
  });
  if (res.status === 404) {
    const err = new Error("Container not found");
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`docker inspect → HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  return redactInspect(await res.json());
}
function mapContainers(list) {
  if (!Array.isArray(list)) return [];
  // SizeRw = writable layer only (unique per container). SizeRootFs =
  // writable + read-only image layers (shared between containers).
  // Shared ≈ SizeRootFs − SizeRw. All three may be null when the daemon
  // omits sizes (no size=1, or the proxy strips them).
  const sizeOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return list.map((c) => ({
    id: String(c?.Id || "").slice(0, 12),
    names: Array.isArray(c?.Names) ? c.Names.map((n) => String(n).replace(/^\//, "")) : [],
    image: typeof c?.Image === "string" ? c.Image : "",
    state: typeof c?.State === "string" ? c.State : "unknown",
    status: typeof c?.Status === "string" ? c.Status : "",
    createdAt:
      typeof c?.Created === "number" ? new Date(c.Created * 1000).toISOString() : null,
    sizeRwBytes: sizeOrNull(c?.SizeRw),
    sizeRootFsBytes: sizeOrNull(c?.SizeRootFs),
  }));
}

function sumSize(items, pick) {
  let total = 0;
  let count = 0;
  if (Array.isArray(items)) {
    for (const it of items) {
      count += 1;
      const v = pick(it);
      if (Number.isFinite(v)) total += v;
    }
  }
  return { count, totalBytes: total };
}

function mapDiskUsage(df) {
  if (!df || typeof df !== "object") return null;
  const images = sumSize(df.Images, (i) => Number(i?.Size));
  const containers = sumSize(df.Containers, (c) => Number(c?.SizeRw));
  const volumes = sumSize(df.Volumes, (v) => Number(v?.UsageData?.Size));
  const buildCache = sumSize(df.BuildCache, (b) => Number(b?.Size));
  // Engine API v1.5x has no per-image Reclaimable field — approximate as
  // the size of images with zero running containers (unused ⇒ removable).
  let reclaimableBytes = 0;
  if (Array.isArray(df.Images)) {
    for (const i of df.Images) {
      if (Number(i?.Containers) === 0 && Number.isFinite(Number(i?.Size))) {
        reclaimableBytes += Number(i.Size);
      }
    }
  }
  return { images, containers, volumes, buildCache, reclaimableBytes };
}

function mapEngineInfo(info) {
  if (!info || typeof info !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    serverVersion: info.ServerVersion || null,
    operatingSystem: info.OperatingSystem || null,
    architecture: info.Architecture || null,
    kernelVersion: info.KernelVersion || null,
    osType: info.OSType || null,
    ncpu: num(info.NCPU),
    memTotalBytes: num(info.MemTotal),
    containersTotal: num(info.Containers),
    containersRunning: num(info.ContainersRunning),
    containersPaused: num(info.ContainersPaused),
    containersStopped: num(info.ContainersStopped),
    imagesTotal: num(info.Images),
  };
}

const dockerSnapshot = {
  configured: proxyBase() !== null,
  lastPollAt: null,
  lastError: null,
  containers: null,
  engine: null,
  diskUsage: null,
};
let dockerPollInFlight = null;

async function pollDocker() {
  const base = proxyBase();
  dockerSnapshot.configured = base !== null;
  if (!base) return dockerSnapshot;
  // Single-flight: concurrent page loads share one poll.
  if (dockerPollInFlight) return dockerPollInFlight;
  dockerPollInFlight = (async () => {
    try {
      const [list, info, df] = await Promise.all([
        // size=1 adds SizeRw/SizeRootFs per container (writable vs total).
        dockerGet(base, "/containers/json?all=1&size=1"),
        dockerGet(base, "/info"),
        dockerGet(base, "/system/df"),
      ]);
      dockerSnapshot.containers = mapContainers(list);
      dockerSnapshot.engine = mapEngineInfo(info);
      dockerSnapshot.diskUsage = mapDiskUsage(df);
      dockerSnapshot.lastPollAt = new Date().toISOString();
      dockerSnapshot.lastError = null;
    } catch (err) {
      // Keep the previous good snapshot; surface the error instead of 500ing.
      dockerSnapshot.lastError = String(err?.message || err);
    } finally {
      dockerPollInFlight = null;
    }
    return dockerSnapshot;
  })();
  return dockerPollInFlight;
}

// ---------------------------------------------------------------------------
// Self metrics
// ---------------------------------------------------------------------------

let eventLoopLagMs = null;
let lagTimer = null;

function sampleEventLoopLag() {
  const start = Date.now();
  setTimeout(() => {
    // setTimeout(0) fires next macrotask; the overshoot approximates how
    // long the loop was blocked. Clamp tiny jitter to 0 for readability.
    const lag = Date.now() - start;
    eventLoopLagMs = lag <= 1 ? 0 : lag;
  }, 0).unref?.();
}

async function uploadsUsage() {
  const dir = process.env.UPLOADS_DIR || path.join(__dirname, "..", "uploads");
  let totalBytes = 0;
  let fileCount = 0;
  let truncated = false;
  const MAX_FILES = 50_000;
  async function walk(p) {
    const entries = await fs.readdir(p, { withFileTypes: true });
    for (const e of entries) {
      if (fileCount >= MAX_FILES) {
        truncated = true;
        return;
      }
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        fileCount += 1;
        try {
          const st = await fs.stat(full);
          totalBytes += st.size;
        } catch {
          // File vanished mid-walk — ignore, best-effort.
        }
      }
      if (truncated) return;
    }
  }
  try {
    await walk(dir);
    return { dir, totalBytes, fileCount, truncated, error: null };
  } catch (err) {
    return { dir, totalBytes: 0, fileCount: 0, truncated: false, error: String(err?.message || err) };
  }
}
async function diskUsage() {
  // Host disk via `df -kP` (POSIX, byte-stable on macOS + Linux).
  // Two mounts: `/` (overlayfs — the Docker data-root filesystem on the
  // VPS, i.e. where images/containers/volumes actually live) and the
  // uploads volume (may be a different filesystem). execFile, no shell,
  // fixed argv — no injection surface. Never rejects: errors land in
  // the per-mount `error` field so one bad mount can't sink the page.
  const { execFile } = await import("node:child_process");
  const runDf = (target) =>
    new Promise((resolve) => {
      execFile("df", ["-kP", target], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ target, totalBytes: 0, usedBytes: 0, availableBytes: 0, usePct: null, error: String(err?.message || err) });
          return;
        }
        try {
          const lines = String(stdout).trim().split("\n");
          const last = lines[lines.length - 1] || "";
          // POSIX -P: fs, 1024-blocks, used, available, capacity%, mount.
          // Mount point is last field (may contain spaces); numbers first.
          const m = last.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/);
          if (!m) throw new Error(`unparseable df line: ${last.slice(0, 120)}`);
          const [, totalK, usedK, availK, pct] = m;
          resolve({
            target,
            totalBytes: Number(totalK) * 1024,
            usedBytes: Number(usedK) * 1024,
            availableBytes: Number(availK) * 1024,
            usePct: Number(pct),
            error: null,
          });
        } catch (parseErr) {
          resolve({ target, totalBytes: 0, usedBytes: 0, availableBytes: 0, usePct: null, error: String(parseErr?.message || parseErr) });
        }
      });
    });
  const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, "..", "uploads");
  const [root, uploadsMount] = await Promise.all([runDf("/"), runDf(uploadsDir)]);
  return { root, uploadsMount };
}

async function dbLatencyMs() {
  const t0 = Date.now();
  await pool.query("SELECT 1");
  return Date.now() - t0;
}

async function count(table, where = "") {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`);
  return rows[0]?.n ?? 0;
}

async function collectDb() {
  const [
    users,
    projects,
    forms,
    formSubmissions,
    reservations,
    bookings,
    upcomingBookings,
    customers,
    activityLogs,
    errors24h,
  ] = await Promise.all([
    count("users"),
    count("projects"),
    count("forms"),
    count("form_submissions"),
    count("reservations"),
    count("reservation_bookings"),
    count("reservation_bookings", "WHERE starts_at > NOW()"),
    count("reservation_customers"),
    count("activity_logs"),
    count("activity_logs", "WHERE action_type = 'ERROR' AND created_at > NOW() - INTERVAL '24 hours'"),
  ]);
  return {
    users,
    projects,
    forms,
    formSubmissions,
    reservations,
    bookings,
    upcomingBookings,
    customers,
    activityLogs,
    errors24h,
  };
}

async function collectEmail() {
  const queue = getQueueStats();
  const emailSending = process.env.EMAIL_SENDING !== "false";
  const smtpHost = process.env.SMTP_HOST || "";
  const transport = !emailSending ? "disabled" : smtpHost.length > 0 ? "smtp" : "json-dev";
  const [{ rows: totals }, { rows: byKind }, { rows: recentFailures }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS sent24h,
              COUNT(*) FILTER (WHERE ok = false)::int AS failed24h
         FROM activity_logs
        WHERE action = 'email.send'
          AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
    pool.query(
      `SELECT COALESCE(metadata->>'kind', 'unknown') AS kind,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ok = true)::int AS delivered,
              COUNT(*) FILTER (WHERE ok = false)::int AS failed
         FROM activity_logs
        WHERE action = 'email.send'
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY total DESC`,
    ),
    pool.query(
      `SELECT created_at, action, entity_label,
              metadata->>'to' AS recipient,
              metadata->>'subject' AS subject,
              COALESCE(metadata->>'error', metadata->'error'->>'message', metadata->'error'->>'code') AS error
         FROM activity_logs
        WHERE action = 'email.send' AND ok = false
        ORDER BY id DESC
        LIMIT 10`,
    ),
  ]);
  return {
    transport,
    sendingEnabled: emailSending,
    smtpConfigured: smtpHost.length > 0,
    queue: {
      pending: queue.pending,
      inFlight: queue.inFlight,
      tokensAvailable: queue.tokensAvailable,
      burstCapacity: queue.burstCapacity,
      refillIntervalMs: queue.refillIntervalMs,
      maxAttempts: queue.maxAttempts,
    },
    sent24h: totals[0]?.sent24h ?? 0,
    failed24h: totals[0]?.failed24h ?? 0,
    byKind7d: byKind.map((r) => ({
      kind: r.kind,
      total: r.total,
      delivered: r.delivered,
      failed: r.failed,
    })),
    recentFailures: recentFailures.map((r) => ({
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      action: r.action,
      entityLabel: r.entity_label,
      recipient: r.recipient,
      subject: r.subject,
      error: r.error,
    })),
  };
}

export async function collectServerInfo() {
  const mem = process.memoryUsage();
  const [latency, tables, email, uploads, disk] = await Promise.all([
    dbLatencyMs().catch((err) => ({ error: String(err?.message || err) })),
    collectDb().catch((err) => ({ error: String(err?.message || err) })),
    collectEmail().catch((err) => ({ error: String(err?.message || err) })),
    uploadsUsage(),
    diskUsage(),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    app: {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptimeSec: Math.floor(process.uptime()),
      loadAvg: os.loadavg(),
      cpuCount: os.cpus()?.length ?? null,
      memTotalBytes: os.totalmem(),
      memFreeBytes: os.freemem(),
      processMemory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      eventLoopLagMs,
      env: process.env.NODE_ENV || "development",
      db:
        typeof latency === "object" && latency !== null && "error" in latency
          ? { ok: false, error: latency.error, pool: poolStats() }
          : { ok: true, latencyMs: latency, pool: poolStats() },
      uploads,
      disk,
    },
    email,
    tables,
    docker: {
      configured: dockerSnapshot.configured,
      lastPollAt: dockerSnapshot.lastPollAt,
      lastError: dockerSnapshot.lastError,
      engine: dockerSnapshot.engine,
      containers: dockerSnapshot.containers,
      diskUsage: dockerSnapshot.diskUsage,
    },
  };
}

function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: 10,
  };
}

export async function refreshDockerSnapshot() {
  const sincePoll = dockerSnapshot.lastPollAt
    ? Date.now() - new Date(dockerSnapshot.lastPollAt).getTime()
    : Infinity;
  // Page-load collection already polls when stale; the Refresh button
  // path honours a 10s floor so it can't hammer the daemon.
  if (sincePoll < REFRESH_MIN_MS && dockerSnapshot.containers) return dockerSnapshot;
  return pollDocker();
}

// ---------------------------------------------------------------------------
// Lifecycle — wired from server.js, same pattern as startReminders()
// ---------------------------------------------------------------------------

let pollTimer = null;

export function startServerInfo() {
  if (process.env.DISABLE_SERVER_INFO === "true") {
    console.log("[server-info] disabled by DISABLE_SERVER_INFO=true");
    return;
  }
  sampleEventLoopLag();
  lagTimer = setInterval(sampleEventLoopLag, 5000);
  // Initial docker poll (fire-and-forget) so the first page load has data.
  pollDocker().catch((err) => console.error("[server-info] initial poll failed:", err.message));
  pollTimer = setInterval(() => {
    pollDocker().catch((err) => console.error("[server-info] poll failed:", err.message));
  }, POLL_MS);
  const shutdown = () => {
    clearInterval(pollTimer);
    clearInterval(lagTimer);
    pollTimer = null;
    lagTimer = null;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`[server-info] started (docker poll every ${Math.round(POLL_MS / 1000)}s)`);
}
