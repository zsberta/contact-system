import { pool } from "../db/pool.js";

// ---------------------------------------------------------------------------
// activity-log — admin audit trail choke point.
//
// Every backend write + outbound send + admin read funnels through
// logActivity(), which fire-and-forget INSERTs into activity_logs. It NEVER
// throws and is NEVER awaited in the request path, so logging can never
// break or slow down a user-facing request.
//
// Redaction: passwords, hashes, tokens, secrets, and auth headers are NEVER
// stored. Request bodies are only stored as redacted changed-field diffs.
// ---------------------------------------------------------------------------

const REDACT_SUBSTRINGS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "session",
  "passcode",
  "otp",
];

function isRedactedKey(key) {
  const lower = String(key).toLowerCase();
  return REDACT_SUBSTRINGS.some((s) => lower.includes(s));
}

function truncateValue(value, maxLen) {
  if (value === undefined) return null;
  let out;
  try {
    out = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    out = String(value);
  }
  if (out !== null && out !== undefined && out.length > maxLen) {
    return `${out.slice(0, maxLen)}…[truncated]`;
  }
  return out;
}

function valuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * diffObjects — changed-fields diff of two row-shaped objects.
 * Returns { field: { from, to } } for changed keys only. Missing key vs
 * null/undefined counts as changed. Redacted keys become '[redacted]'.
 */
export function diffObjects(before, after, opts = {}) {
  const { maxKeys = 50, maxValueLen = 2000 } = opts;
  const diff = {};
  const b = before && typeof before === "object" ? before : {};
  const a = after && typeof after === "object" ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    if (Object.keys(diff).length >= maxKeys) break;
    if (valuesEqual(b[key], a[key])) continue;
    if (isRedactedKey(key)) {
      diff[key] = { from: "[redacted]", to: "[redacted]" };
      continue;
    }
    diff[key] = {
      from: truncateValue(b[key] ?? null, maxValueLen),
      to: truncateValue(a[key] ?? null, maxValueLen),
    };
  }
  return diff;
}

/**
 * actorFromReq — resolve the audit actor from an Express request.
 * Admins/endusers come from the JWT cookie (req.user); anonymous traffic
 * (public embed, pre-login auth) is 'public'. req.ip is proxy-aware
 * (server.js sets trust proxy).
 */
export function actorFromReq(req) {
  const user = req?.user;
  if (user && (user.role === "admin" || user.role === "enduser")) {
    return {
      actor_type: user.role,
      actor_user_id: Number(user.id) || null,
      actor_email: user.email || null,
      actor_role: user.role,
      actor_ip: req.ip || null,
    };
  }
  return {
    actor_type: "public",
    actor_user_id: null,
    actor_email: user?.email || null,
    actor_role: user?.role || null,
    actor_ip: req?.ip || null,
  };
}

/** Normalized route template, e.g. "POST /api/reservations/:id/bookings". */
export function routeTemplate(req) {
  if (!req) return "SEND -";
  const method = req.method || "-";
  const routePath =
    (req.baseUrl || "") + (req.route && req.route.path ? req.route.path : req.path || "");
  return `${method} ${routePath}`;
}

/**
 * logActivity — fire-and-forget audit INSERT. NEVER throws, NEVER awaited.
 *
 * @param {object} p
 * @param {object} [p.req] Express request (actor + path + url derivation)
 * @param {string} p.action e.g. 'booking.create_manual'
 * @param {string} p.actionType CREATE|READ|UPDATE|DELETE|SEND
 * @param {string} [p.entityType] e.g. 'booking'
 * @param {number} [p.entityId]
 * @param {string} [p.entityLabel] human label (email, title, '#id')
 * @param {number} [p.projectId]
 * @param {number} [p.statusCode]
 * @param {boolean} [p.ok=true]
 * @param {object} [p.metadata] JSONB sidecar (diffs, counts, email to/subject…)
 * @param {object} [p.actorOverride] e.g. { actor_type:'public', actor_email } or { actor_type:'system' }/{ actor_type:'service' }
 */
export function logActivity(p = {}) {
  const {
    req = null,
    action,
    actionType,
    entityType = null,
    entityId = null,
    entityLabel = null,
    projectId = null,
    statusCode = null,
    ok = true,
    metadata = {},
    actorOverride = null,
  } = p;
  if (!action || !actionType) {
    console.error("[activity-log] refusing to log without action/actionType");
    return;
  }
  const base = req ? actorFromReq(req) : { actor_type: "system", actor_user_id: null, actor_email: null, actor_role: null, actor_ip: null };
  const actor = actorOverride ? { ...base, ...actorOverride } : base;
  const meta = { ...(metadata || {}) };
  if (req?.originalUrl && !meta.url) meta.url = req.originalUrl;
  // "Where": proxy-aware IP is stored as actor_ip; capture user-agent too.
  const ua = req?.headers?.["user-agent"];
  if (typeof ua === "string" && ua.length > 0 && !meta.userAgent) meta.userAgent = ua.slice(0, 500);
  const eid = entityId === null || entityId === undefined ? null : Number(entityId);
  const pid = projectId === null || projectId === undefined ? null : Number(projectId);
  pool
    .query(
      `INSERT INTO activity_logs
         (actor_type, actor_user_id, actor_email, actor_role, actor_ip,
          method, path, action, action_type,
          entity_type, entity_id, entity_label, project_id,
          status_code, ok, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        actor.actor_type,
        actor.actor_user_id,
        actor.actor_email,
        actor.actor_role,
        actor.actor_ip,
        req?.method || "SEND",
        routeTemplate(req),
        action,
        actionType,
        entityType,
        Number.isFinite(eid) ? eid : null,
        entityLabel,
        Number.isFinite(pid) ? pid : null,
        statusCode,
        ok !== false,
        JSON.stringify(meta),
      ],
    )
    .catch((err) => console.error("[activity-log] insert failed:", err.code, err.message));
}
// ---------------------------------------------------------------------------
// logError — error rows for the admin log page (actionType ERROR, ok false).
//
// What it stores (per plan: message + customer view, no stack traces):
//   metadata.error = { code, message }      — sanitized backend failure
//   metadata.customer = { status, message } — exactly what the customer saw
//   metadata.tag                        — the console.error [tag] equivalent
//   metadata.op                         — failing operation label
//
// Redaction: same REDACT_SUBSTRINGS rule as diffs — error messages that
// echo secrets (tokens, passwords, connection strings) are scrubbed.
// NEVER stores err.stack, request bodies, or query params wholesale.
// ---------------------------------------------------------------------------

const SECRET_VALUE_RE =
  /(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|session|otp|passcode)\s*[:=]\s*['"]?[^'"\s,}]+['"]?/gi;

function scrubErrorText(text) {
  if (typeof text !== "string" || text.length === 0) return text || "";
  return text.replace(SECRET_VALUE_RE, "$1=[redacted]").slice(0, 2000);
}

export function logError({
  req = null,
  err = null,
  tag = null,
  op = null,
  action = null,
  entityType = null,
  entityId = null,
  entityLabel = null,
  projectId = null,
  statusCode = 500,
  customerMessage = "Internal server error",
  actorOverride = null,
} = {}) {
  const code = err?.code ? String(err.code) : null;
  const message = scrubErrorText(err?.message || String(err || "Unknown error"));
  const cleanCustomer = scrubErrorText(customerMessage);
  const cleanTag = typeof tag === "string" && tag.length > 0 ? tag.slice(0, 200) : null;
  const cleanOp = typeof op === "string" && op.length > 0 ? op.slice(0, 200) : null;
  // Derive a namespaced action from the console tag when the caller does
  // not pass an explicit action: "[blog/create]" -> "blog.create:error".
  let errorAction = action;
  if (!errorAction && cleanTag) {
    const m = /^\[([^\]/]+?)(?:\/([^\]]+))?\]$/.exec(cleanTag.trim());
    if (m) {
      const ns = m[1].trim().replace(/[^a-z0-9_-]+/gi, ".");
      const suffix = (m[2] || "error").trim().replace(/[^a-z0-9_-]+/gi, ".");
      errorAction = `${ns}.${suffix}:error`;
    } else {
      errorAction = `${cleanTag.replace(/[^a-z0-9_.-]+/gi, ".").slice(0, 120)}:error`;
    }
  }
  if (!errorAction) errorAction = "unknown:error";
  logActivity({
    req,
    action: errorAction,
    actionType: "ERROR",
    entityType,
    entityId,
    entityLabel,
    projectId,
    statusCode,
    ok: false,
    metadata: {
      error: { code, message },
      customer: { status: statusCode, message: cleanCustomer },
      ...(cleanTag ? { tag: cleanTag } : {}),
      ...(cleanOp ? { op: cleanOp } : {}),
    },
    actorOverride,
  });
}

// ---------------------------------------------------------------------------
// activityErrorLogger — automatic capture of 4xx + 5xx API responses.
//
// Mounted on /api BEFORE the routers (with the read logger) so the res.json
// patch + finish listener wrap every request; req.route/baseUrl are read
// lazily at res.finish when the route is resolved. On finish with
// statusCode >= 400 it writes one ERROR row carrying exactly what the
// customer saw (status + response errorMessage). Skips: /api/logs itself
// (no feedback loop), /api/health, /api/csrf, /api/public/* (visitor
// noise; public booking failures are logged explicitly at their handlers
// with customer email linkage).
// ---------------------------------------------------------------------------

const ERROR_SKIP = [
  /^\/api\/logs/,
  /^\/api\/health/,
  /^\/api\/csrf/,
  /^\/api\/public\//,
  /^\/api\/internal\//,
  /\/attachments\/.*\/download/,
];

function deriveErrorContext(apiPath, originalUrl) {
  const segments = (apiPath || "").split("/").filter(Boolean);
  // segments[0] === 'api', segments[1] === resource
  const resource = segments[1] || "unknown";
  const last = segments[segments.length - 1];
  const entityId = /^\d+$/.test(last || "") ? Number(last) : null;
  const entityType = segments.length > 2 && entityId !== null ? segments[1] : segments[1] || null;
  let projectId = null;
  const pidIdx = segments.indexOf("projects");
  if (pidIdx !== -1 && /^\d+$/.test(segments[pidIdx + 1] || "")) {
    projectId = Number(segments[pidIdx + 1]);
  } else {
    // ?projectId= query param fallback (e.g. POST /api/blog?projectId=1)
    try {
      const q = new URL(originalUrl || "", "http://x").searchParams.get("projectId");
      if (q && /^\d+$/.test(q)) projectId = Number(q);
    } catch { /* ignore */ }
  }
  return { action: `${resource}.error`, entityType, entityId, projectId };
}

export function activityErrorLogger(req, res, next) {
  // Capture the customer-facing body: most error responses are
  // { errorMessage }, some are plain text (embed scripts).
  let customerMessage = null;
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  res.json = (body) => {
    if (body && typeof body.errorMessage === "string") customerMessage = body.errorMessage;
    return origJson(body);
  };
  res.send = (body) => {
    if (typeof body === "string" && customerMessage === null) customerMessage = body.slice(0, 500);
    return origSend(body);
  };
  res.on("finish", () => {
    // Suppressed when the global error handler already logged this failure
    // directly (uncaught throws) — no double row for the same response.
    if (req._auditLogged) return;
    if (res.statusCode < 400) return;
    const apiPath = (req.baseUrl || "") + (req.route && req.route.path ? req.route.path : req.path || "");
    const originalUrl = req.originalUrl || "";
    if (ERROR_SKIP.some((re) => re.test(apiPath)) || ERROR_SKIP.some((re) => re.test(originalUrl))) {
      return;
    }
    const ctx = deriveErrorContext(apiPath, originalUrl);
    logError({
      req,
      err: req._auditError || null,
      tag: req._auditTag || null,
      op: req._auditOp || null,
      action: ctx.action,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      projectId: req._auditProjectId ?? ctx.projectId,
      statusCode: res.statusCode,
      customerMessage: customerMessage || res.statusMessage || "Error",
      actorOverride: req._auditActor || null,
    });
  });
  next();
}


// ---------------------------------------------------------------------------
// Admin-read middleware — logs admin GET views (READ). Mounted on /api AFTER
// csrfProtection. Skips noisy/polling surfaces and /api/logs itself (no
// feedback loop). Only logs successful (<400) reads.
// ---------------------------------------------------------------------------

const READ_SKIP = [
  /^\/api\/health/,
  /^\/api\/csrf/,
  /^\/api\/auth\/me/,
  /^\/api\/logs/,
  /^\/api\/public\//,
  /^\/api\/internal\//,
  /^\/api\/notifications/,
  /snippet/,
  /script\.js/,
  /\/config/,
  /availability/,
  /catalog/,
  /\/attachments\/.*\/download/,
  /\/submissions\/bookings\/calendar/,
  /\/bookings\/calendar/,
];

function readActionForPath(apiPath) {
  // /api/<resource>[/...] -> '<resource>.view'
  const m = /^\/api\/([^/?]+)/.exec(apiPath || "");
  const resource = (m && m[1]) || "unknown";
  return `${resource}.view`;
}

export function activityReadLogger(req, res, next) {
  if (req.method !== "GET") return next();
  if (req.user?.role !== "admin") return next();
  const apiPath = (req.baseUrl || "") + (req.path || "");
  if (READ_SKIP.some((re) => re.test(apiPath)) || READ_SKIP.some((re) => re.test(req.originalUrl || ""))) {
    return next();
  }
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    const action = readActionForPath(apiPath);
    // Entity resolution: numeric trailing segment => detail view of resource.
    const segments = apiPath.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    const entityId = /^\d+$/.test(last || "") ? Number(last) : null;
    const entityType = segments.length > 1 && entityId !== null ? segments[1] : segments[1] || null;
    let projectId = null;
    const pidIdx = segments.indexOf("projects");
    if (pidIdx !== -1 && /^\d+$/.test(segments[pidIdx + 1] || "")) {
      projectId = Number(segments[pidIdx + 1]);
    }
    logActivity({
      req,
      action,
      actionType: "READ",
      entityType,
      entityId,
      projectId,
      statusCode: res.statusCode,
      ok: true,
      metadata: {},
    });
  });
  next();
}

// ---------------------------------------------------------------------------
// Retention prune — nightly DELETE of rows older than N months.
// Months from ACTIVITY_LOG_RETENTION_MONTHS (default 12).
// ---------------------------------------------------------------------------

const PRUNE_BATCH = 5000;
let pruneTimer = null;

export function retentionMonths() {
  const n = parseInt(process.env.ACTIVITY_LOG_RETENTION_MONTHS || "12", 10);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

export async function pruneActivityLogs(months = retentionMonths()) {
  let total = 0;
  for (;;) {
    const { rows } = await pool.query(
      `DELETE FROM activity_logs WHERE id IN (
         SELECT id FROM activity_logs
         WHERE created_at < NOW() - make_interval(months => $1)
         LIMIT ${PRUNE_BATCH}
       ) RETURNING id`,
      [months],
    );
    total += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  return total;
}

export function startActivityLogPrune() {
  if (pruneTimer) return;
  const run = async () => {
    try {
      const deleted = await pruneActivityLogs();
      if (deleted > 0) console.log(`[activity-log/prune] deleted ${deleted} rows older than ${retentionMonths()} months`);
    } catch (err) {
      console.error("[activity-log/prune] failed:", err.code, err.message);
    }
  };
  // First run shortly after boot (lets the pool warm up), then daily.
  setTimeout(run, 60_000);
  pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
}
