// routes/analytics-embed.js
//
// =============================================================================
// Public embed endpoints for the Analytics module (sibling to
// routes/form-embed.js, routes/reservation-embed.js).
//
// Mounted by server.js at /api/public/analytics, so the absolute paths
// are /api/public/analytics/:secret_token/script.js and
// /api/public/analytics/:secret_token/collect.
//
// =============================================================================
// SECURITY MODEL
// =============================================================================
// - Public, no auth/CSRF (the /api/public/* prefix is CSRF-exempt per
//   middleware/csrf.js; the secret_token is the capability).
// - Two rate-limiters in chain:
//     analyticsBurstLimiter       10000 req / IP / 60 s   (default; tuneable)
//     analyticsSustainedLimiter   100000 req / IP / 24 h  (default; tuneable)
//   Both configurable via env vars (see .env.example).
// - Origin MUST match the config's allowed_origins list (or the list must
//   be empty). Same wildcard / exact-match semantics as forms.
// - 404 if the secret_token is unknown OR the config is disabled OR the
//   origin doesn't match — indistinguishable so we don't leak existence.
// - Event payload validation: event_type whitelisted to 'pageview' | 'event';
//   path is a relative URL-path (no scheme, no host); screen width/height
//   are bounded ints; raw is a bounded bag (depth <= 3, <= 30 keys/level,
//   <= 10 KB JSON-encoded). Everything else is coerced to safe upper bounds
//   before insert.
// - sendBeacon / fetch are the only client transports — there is no
//   CORS preflight for the actual /collect POST because sendBeacon uses
//   text/plain by default and the script loader uses Content-Type
//   'application/json' with no credentials. The /api/public/* CORS layer
//   in server.js reflects the origin in dev (per the existing
//   PUBLIC_EMBED_CORS contract).
// =============================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";

export const router = express.Router();

// Per-route body parser for text/plain. The global express.json() in
// server.js only parses application/json, but the analytics loader's
// fetch-fallback path deliberately sends the body as `text/plain` so
// the request is a CORS-"simple" request (no preflight needed). The
// body is still a JSON string — we JSON.parse it here and stash the
// result on req.body, matching the contract the global json() parser
// provides. This parser is intentionally narrow: it ONLY runs for this
// router, so it can't affect any other endpoint's body handling.
router.use(express.text({
  type: "text/plain",
  limit: "10kb",
}));
router.use((req, res, next) => {
  // Only the /collect POST has a body. If a text/plain request comes
  // in, parse it as JSON. Other requests (no body) pass through with
  // req.body === undefined.
  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ errorMessage: "Invalid JSON body" });
    }
  } else {
    // text/plain with empty body: leave req.body as an empty object so
    // downstream validators don't choke on `undefined`.
    req.body = req.body || {};
  }
  next();
});

// Two chained limiters. The order matters: the burst limiter runs FIRST
// (per-minute), then the sustained limiter (per-day). Generous defaults
// so E2E + load tests don't hit walls; tune via env vars.
const analyticsBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_ANALYTICS_COLLECT_BURST_LIMIT || "10000", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests, please try again later" },
  keyGenerator: (req) => `analytics-burst:${req.ip}`,
});

const analyticsSustainedLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: parseInt(process.env.PUBLIC_ANALYTICS_COLLECT_SUSTAINED_LIMIT || "100000", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests, please try again later" },
  keyGenerator: (req) => `analytics-sustained:${req.ip}`,
});

// Validation constants — kept local to this route.
const EVENT_TYPES = new Set(["pageview", "event"]);
const PATH_MAX_LEN = 2000;
const REFERRER_MAX_LEN = 2000;
const LOCALE_MAX_LEN = 10;
const SESSION_ID_MAX_LEN = 64;
const VISITOR_ID_MAX_LEN = 64;
const USER_AGENT_MAX_LEN = 500;
const SCREEN_MAX = 32768; // hard cap; larger than any real display.
const RAW_MAX_KEYS_PER_LEVEL = 30;
const RAW_MAX_DEPTH = 3;
const RAW_MAX_BYTES = 10 * 1024; // 10 KB JSON-encoded ceiling

// Recursively count the keys in any nested plain object + measure the
// nesting depth. Mirrors the helper in routes/form-embed.js but with
// tighter limits (analytics is high-volume; cheaper to validate).
function measureBag(obj, currentDepth = 1, results = { keys: 0, depth: 1 }) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return results;
  const keys = Object.keys(obj).length;
  if (keys > results.keys) results.keys = keys;
  if (currentDepth > results.depth) results.depth = currentDepth;
  if (currentDepth > RAW_MAX_DEPTH) {
    results.depth = RAW_MAX_DEPTH + 1;
    return results;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      measureBag(v, currentDepth + 1, results);
    }
  }
  return results;
}

// Trim a string to a safe upper bound. Returns null for non-strings /
// empty-after-trim so the DB column stays NULL rather than ''.
function trimOrNull(v, max) {
  if (typeof v !== "string") return null;
  if (v.length === 0) return null;
  return v.length > max ? v.slice(0, max) : v;
}

// Coerce a number-ish value into a bounded int, or null.
function intOrNull(v, max) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.trunc(v);
    if (n < 0) return null;
    return n > max ? max : n;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n > max ? max : n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /:secret_token/script.js
// Serves the static analytics loader script. We don't read from disk at
// request time — the script is small (~2 KB) and embedding it here keeps
// the deploy artefact self-contained (no static-asset mounting ceremony).
// Cache headers: 5-min public cache to balance CDN-style delivery with
// the ability to push a fix quickly. The secret_token is baked into the
// served body so the cache is per-token (no leakage).
//
// GDPR / ePrivacy note: the loader is CONSENT-GATED by design. It does
// NOT auto-run on <script> load — it installs nothing, writes nothing
// to localStorage / sessionStorage, and POSTs nothing until the host
// page explicitly calls window.analytics.activate() after obtaining the
// user's consent (ePrivacy Directive 2002/58/EC Art. 5(3), Hungarian
// Info tv. 5.§(1), CJEU Planet49 C-673/17 — localStorage is in scope).
// ---------------------------------------------------------------------------
router.get("/:secret_token/script.js", async (req, res) => {
  // Always advertise CORP=cross-origin up-front, BEFORE any 404 short-circuit.
  // Helmet's default is CORP=same-origin, which makes modern browsers refuse
  // to load this script cross-origin — exactly the case we need to support
  // (a landing page on https://zsoltberta.hu loading the script from the BE).
  // Setting it before the 404 ensures even a "token not found" response
  // doesn't trip ERR_BLOCKED_BY_RESPONSE.NotSameOrigin in the operator's
  // browser when they paste a stale snippet (deleted/recreated config).
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const { secret_token: secretToken } = req.params;
  if (typeof secretToken !== "string" || secretToken.length !== 22) {
    return res.status(404).type("text/plain").send("// analytics: not found");
  }
  // We DO need to know whether the config exists and is active before
  // serving the loader — otherwise an attacker can probe tokens by
  // checking if a JS file is returned. But we don't gate on origin here
  // because the loader is referenced from <script src=...> which does
  // not send an Origin header in the same way fetch does. Instead, the
  // /collect endpoint below enforces the origin.
  try {
    const result = await pool.query(
      `SELECT id, status, allowed_origins FROM analytics_configs WHERE secret_token = $1`,
      [secretToken],
    );
    if (result.rowCount === 0 || result.rows[0].status !== "active") {
      return res.status(404).type("text/plain").send("// analytics: not found");
    }
    // The script URL is the absolute URL the browser used to fetch this
    // loader. We resolve the collect path against it so the /collect
    // POST always goes to the BE that served the script — not the host
    // page. This is critical: if the loader used a bare "/collect" path,
    // browsers would resolve it against the landing page's origin and
    // hit 404 on any cross-origin embed (e.g. landing on
    // https://zsoltberta.hu → POST https://zsoltberta.hu/collect).
    //
    // We swap only the trailing "script.js" segment for "collect" — we
    // deliberately do NOT inject the full /api/.../collect path here,
    // because that would double up with the script's existing prefix
    // (the script URL already contains /api/public/analytics/<token>/,
    // so all we need to change is the final "script.js" → "collect").
    //
    // Loader contract:
    //   - On <script> load: only installs window.analytics.{activate,
    //     deactivate, event}. Nothing else. No localStorage write, no
    //     sessionStorage write, no POST, no SPA hooks.
    //   - window.analytics.activate(): generates visitorId (writes
    //     localStorage.analytics.visitorId), generates sessionId (writes
    //     sessionStorage.analytics.sessionId), installs SPA route-change
    //     hooks, fires the initial pageview. Idempotent.
    //   - window.analytics.deactivate(): uninstalls SPA hooks, clears
    //     the stored IDs. Idempotent.
    //   - window.analytics.event(name, props): sends a custom event.
    //     No-op unless activated.
    const script = `/*! analytics-loader v1.0 — token=${secretToken} */
(function(){
  if (window.__analyticsLoaderInstalled) return;
  window.__analyticsLoaderInstalled = true;
  var TOKEN = ${JSON.stringify(secretToken)};
  // Resolve the collect URL against the script's own URL, not the host
  // page's URL. document.currentScript.src is the absolute URL the
  // browser used to fetch THIS loader.
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "";
  var COLLECT_URL;
  try {
    var u = new URL(SCRIPT_SRC);
    // The script URL ends in /script.js; the collect endpoint is the
    // same path with the final segment swapped from "script.js" to
    // "collect". This keeps the BE host, port, and prefix intact.
    //
    // We use endsWith + slice instead of a regex literal because the
    // natural regex /\/script\.js$/ collides with SES Lockdown and
    // other hardened JS runtimes (MetaMask, certain CSP environments):
    // the trailing $/ in the literal is mis-parsed as "regex followed
    // by end-anchor and closing slash that looks like flags" and the
    // loader fails to parse with "Invalid regular expression flags".
    // A direct string check sidesteps the ambiguity.
    var p = u.pathname;
    if (p.length > 10 && p.slice(-10) === "/script.js") {
      u.pathname = p.slice(0, -10) + "/collect";
    }
    u.search = "";
    u.hash = "";
    COLLECT_URL = u.toString();
  } catch (e) {
    // Fallback: best-effort relative URL. Will 404 on cross-origin
    // embeds but at least degrades gracefully.
    COLLECT_URL = ${JSON.stringify("/api/public/analytics/" + secretToken + "/collect")};
  }
  var VISITOR_KEY = "analytics.visitorId";
  var SESSION_KEY = "analytics.sessionId";
  var ACTIVATED = false;
  function uuid(){
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    // Fallback: 16 random bytes -> 32 hex chars (no padding required by BE).
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(b);
    } else {
      for (var i=0;i<16;i++) b[i] = Math.floor(Math.random()*256);
    }
    var s = "";
    for (var j=0;j<16;j++) s += (b[j]+256).toString(16).slice(1);
    return s;
  }
  function getOrCreate(key, make){
    try {
      var v = window.localStorage.getItem(key);
      if (!v) {
        v = make();
        try { window.localStorage.setItem(key, v); } catch(e) {}
      }
      return v;
    } catch(e) {
      // localStorage may be blocked (private mode, third-party context).
      // Fall back to a per-page id so we still get pageview counts, just
      // no session continuity.
      return make();
    }
  }
  function getSessionId(){
    try {
      var v = window.sessionStorage.getItem(SESSION_KEY);
      if (!v) {
        v = uuid();
        try { window.sessionStorage.setItem(SESSION_KEY, v); } catch(e) {}
      }
      return v;
    } catch(e) { return uuid(); }
  }
  function send(type, extra){
    try {
      var payload = {
        type: type,
        path: window.location.pathname + window.location.search,
        referrer: document.referrer || null,
        screenWidth: window.screen && window.screen.width || null,
        screenHeight: window.screen && window.screen.height || null,
        locale: (navigator.language || "").slice(0, 10) || null,
        sessionId: getSessionId(),
        visitorId: getOrCreate(VISITOR_KEY, uuid),
        ts: Date.now()
      };
      if (extra && typeof extra === "object") {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
        }
      }
      var body = JSON.stringify(payload);
      // Prefer sendBeacon (survives unload, no CORS preflight, no
      // credentials). Fall back to fetch keepalive. The fallback uses
      // Content-Type: text/plain (a CORS-"simple" value) so the browser
      // does NOT trigger a preflight OPTIONS request. We send the JSON
      // body as a string; the BE's text/plain parser JSON.parses it.
      // The sendBeacon path uses application/json because sendBeacon
      // doesn't have a preflight at all (it's a no-cors request type).
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(COLLECT_URL, blob)) return;
      }
      if (window.fetch) {
        try { fetch(COLLECT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: body, keepalive: true, credentials: "omit" }); } catch(e) {}
      }
    } catch(e) { /* swallow — analytics must never break the host page */ }
  }
  function emitPageview(){
    send("pageview", { name: document.title || null });
  }
  // SPA route-change hooks. Captured at install time so deactivate()
  // can restore the originals cleanly.
  var _origPush = history.pushState;
  var _origReplace = history.replaceState;
  function installSpaHooks(){
    history.pushState = function(){
      var rv = _origPush.apply(this, arguments);
      window.dispatchEvent(new Event("analytics:locationchange"));
      return rv;
    };
    history.replaceState = function(){
      var rv = _origReplace.apply(this, arguments);
      window.dispatchEvent(new Event("analytics:locationchange"));
      return rv;
    };
    window.addEventListener("popstate", function(){
      window.dispatchEvent(new Event("analytics:locationchange"));
    });
    window.addEventListener("analytics:locationchange", function(){
      if (!ACTIVATED) return;
      // Slight delay so the new path is reflected in window.location.
      setTimeout(emitPageview, 0);
    });
  }
  function uninstallSpaHooks(){
    // Restore the original history methods so SPA route changes no
    // longer dispatch analytics:locationchange. The popstate +
    // analytics:locationchange listeners stay attached (cheap, and the
    // ACTIVATED guard in the handler makes them inert). This is the
    // minimum-cost teardown that still behaves correctly on re-activate.
    if (typeof _origPush === "function") history.pushState = _origPush;
    if (typeof _origReplace === "function") history.replaceState = _origReplace;
  }
  function clearStoredIds(){
    // Clear the persisted IDs so a later activate() starts a fresh
    // session — important for consent withdrawal: the user must not be
    // tracked across the rejection boundary with the same persistent id.
    try { window.localStorage.removeItem(VISITOR_KEY); } catch(e) {}
    try { window.sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
  }
  function activate(){
    if (ACTIVATED) return;
    ACTIVATED = true;
    installSpaHooks();
    // Initial pageview. Defer to next tick so history.pushState patches
    // installed above don't fire a pageview for the same URL we just
    // loaded. document.readyState === "complete" means we're past
    // window.load already, so emit immediately on next tick.
    if (document.readyState === "complete") {
      setTimeout(emitPageview, 0);
    } else {
      window.addEventListener("load", function once(){
        window.removeEventListener("load", once);
        emitPageview();
      });
    }
  }
  function deactivate(){
    if (!ACTIVATED) return;
    ACTIVATED = false;
    uninstallSpaHooks();
    clearStoredIds();
  }
  // Public API. The loader installs ONLY these three functions on
  // window.analytics and does nothing else until activate() is called.
  window.analytics = {
    activate: activate,
    deactivate: deactivate,
    event: function(name, props){
      if (!ACTIVATED) return;
      if (typeof name !== "string" || name.length === 0) return;
      var safeName = name.slice(0, 64);
      var safeProps = (props && typeof props === "object" && !Array.isArray(props)) ? props : {};
      send("event", { name: safeName, props: safeProps });
    }
  };
})();
`;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    // CORP=cross-origin is already set at the top of the route (before
    // any 404 short-circuit) so we don't need to set it again here.
    return res.status(200).send(script);
  } catch (err) {
    console.error("[analytics/public/script]", err.code, err.message);
    return res.status(500).type("text/plain").send("// analytics: error");
  }
});

// ---------------------------------------------------------------------------
// POST /:secret_token/collect
// Event ingestion endpoint. Validates origin, payload, and inserts.
// ---------------------------------------------------------------------------
router.post(
  "/:secret_token/collect",
  analyticsBurstLimiter,
  analyticsSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    const body = req.body ?? {};

    // Validate event_type up-front so we can short-circuit malformed payloads
    // before the DB lookup.
    if (typeof body.type !== "string" || !EVENT_TYPES.has(body.type)) {
      return res.status(400).json({ errorMessage: "type must be 'pageview' or 'event'" });
    }
    const eventType = body.type;

    // Validate path: a relative URL-path with no scheme/host. Reject anything
    // that looks like an absolute URL or contains whitespace/control chars.
    let path = null;
    if (typeof body.path === "string" && body.path.length > 0) {
      const p = body.path;
      if (p.length > PATH_MAX_LEN) {
        return res.status(400).json({ errorMessage: `path must be <= ${PATH_MAX_LEN} chars` });
      }
      // Cheap injection guard: no scheme, no host, no whitespace, no CRLF.
      if (/[\s\r\n]/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^\/\//.test(p)) {
        return res.status(400).json({ errorMessage: "path must be a relative URL path" });
      }
      path = p;
    }

    // Optional name + props for custom 'event' payloads.
    let eventName = null;
    let eventProps = null;
    if (eventType === "event") {
      if (typeof body.name === "string" && body.name.length > 0) {
        eventName = body.name.slice(0, 64);
      }
      if (
        body.props &&
        typeof body.props === "object" &&
        !Array.isArray(body.props)
      ) {
        const m = measureBag(body.props);
        if (m.depth > RAW_MAX_DEPTH) {
          return res.status(400).json({ errorMessage: `props exceeds max depth ${RAW_MAX_DEPTH}` });
        }
        if (m.keys > RAW_MAX_KEYS_PER_LEVEL) {
          return res.status(400).json({ errorMessage: `props exceeds max ${RAW_MAX_KEYS_PER_LEVEL} keys per level` });
        }
        try {
          eventProps = JSON.stringify(body.props);
          if (Buffer.byteLength(eventProps, "utf8") > RAW_MAX_BYTES) {
            return res.status(400).json({ errorMessage: `props exceeds max ${RAW_MAX_BYTES} bytes` });
          }
        } catch (e) {
          return res.status(400).json({ errorMessage: "props is not serialisable" });
        }
      }
    }

    // Truncate everything else to safe upper bounds.
    const referrer = trimOrNull(body.referrer, REFERRER_MAX_LEN);
    const locale = trimOrNull(body.locale, LOCALE_MAX_LEN);
    const sessionId = trimOrNull(body.sessionId, SESSION_ID_MAX_LEN);
    const visitorId = trimOrNull(body.visitorId, VISITOR_ID_MAX_LEN);
    const screenWidth = intOrNull(body.screenWidth, SCREEN_MAX);
    const screenHeight = intOrNull(body.screenHeight, SCREEN_MAX);

    // Optional occurred-at (epoch ms). Clamp to a sane window (now-7d .. now+1m)
    // to defeat pre/post-dated poisoning. Defaults to now().
    let occurredAt = null;
    if (typeof body.ts === "number" && Number.isFinite(body.ts)) {
      const now = Date.now();
      const min = now - 7 * 24 * 60 * 60 * 1000;
      const max = now + 60 * 1000;
      if (body.ts >= min && body.ts <= max) {
        occurredAt = new Date(body.ts).toISOString();
      }
    }

    // Compose the raw JSONB blob. The 'name' / 'props' fields are stored
    // both as dedicated columns (later) and inside raw for forward-compat.
    // For the MVP we keep them only in raw and rely on event_type to
    // disambiguate (pageview vs event).
    let raw = null;
    try {
      const rawObj = { name: eventName, props: eventProps ? JSON.parse(eventProps) : null };
      raw = JSON.stringify(rawObj);
      if (Buffer.byteLength(raw, "utf8") > RAW_MAX_BYTES) raw = null;
    } catch { raw = null; }

    try {
      // Look up config by secret_token. We deliberately do NOT include
      // status in the WHERE clause here — we want one round-trip that
      // tells us "unknown token" vs. "known but disabled" so we can
      // (a) map both to the same 404 (no existence leak), and
      // (b) skip the allowlist + insert for both.
      const result = await pool.query(
        `SELECT id, status, allowed_origins
         FROM analytics_configs
         WHERE secret_token = $1`,
        [secretToken],
      );
      if (result.rowCount === 0 || result.rows[0].status !== "active") {
        return res.status(404).json({ errorMessage: "Not found" });
      }
      const row = result.rows[0];
      const configId = Number(row.id);

      // Origin allowlist enforcement. Same wildcard/exact semantics as forms.
      let allowedOrigins = [];
      if (Array.isArray(row.allowed_origins)) {
        allowedOrigins = row.allowed_origins.filter((d) => typeof d === "string");
      } else if (typeof row.allowed_origins === "string" && row.allowed_origins.length > 0) {
        try { allowedOrigins = JSON.parse(row.allowed_origins); }
        catch { allowedOrigins = []; }
      }
      allowedOrigins = Array.isArray(allowedOrigins)
        ? allowedOrigins.filter((d) => typeof d === "string")
        : [];
      if (allowedOrigins.length > 0) {
        const requestOrigin = req.headers.origin;
        if (
          typeof requestOrigin !== "string" ||
          requestOrigin.length === 0 ||
          !isOriginAllowed(requestOrigin, allowedOrigins)
        ) {
          // Indistinguishable 404 — don't leak the allowlist contents.
          return res.status(404).json({ errorMessage: "Not found" });
        }
      }

      // Capture metadata. Trim the user-agent to a safe upper bound.
      const ipAddress = req.ip || req.socket?.remoteAddress || null;
      const userAgent = typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, USER_AGENT_MAX_LEN)
        : null;

      await pool.query(
        `INSERT INTO analytics_events
           (config_id, event_type, occurred_at, session_id, visitor_id,
            path, referrer, screen_width, screen_height, locale,
            user_agent, ip_address, raw)
         VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4, $5,
                 $6, $7, $8, $9, $10,
                 $11, $12, $13::jsonb)`,
        [
          configId,
          eventType,
          occurredAt,
          sessionId,
          visitorId,
          path,
          referrer,
          screenWidth,
          screenHeight,
          locale,
          userAgent,
          ipAddress,
          raw,
        ],
      );
      return res.status(204).send();
    } catch (err) {
      console.error("[analytics/public/collect]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Origin-allowlist matcher — same algorithm as routes/form-embed.js (the
// FE mirror lives at src/components/forms/origin-allowlist.ts; we don't
// ship a TS mirror for analytics because the FE doesn't render allowlists
// for it yet). If a TS mirror is added later, keep these in sync.
// ---------------------------------------------------------------------------
function isOriginAllowed(requestOrigin, allowedOrigins) {
  if (typeof requestOrigin !== "string" || requestOrigin.length === 0) {
    return false;
  }
  const hasScheme = /^https?:\/\//i.test(requestOrigin);
  const urlish = hasScheme ? requestOrigin : `http://${requestOrigin}`;
  let req;
  try {
    const u = new URL(urlish);
    req = u.host.toLowerCase();
  } catch {
    req = requestOrigin
      .replace(/\/$/, "")
      .replace(/^https?:\/\//i, "")
      .toLowerCase();
  }
  for (let i = 0; i < allowedOrigins.length; i++) {
    const entry = allowedOrigins[i];
    if (typeof entry !== "string") return false;
    const e = entry.replace(/\/$/, "").toLowerCase();
    const entryHasScheme = /^https?:\/\//i.test(e);
    const eUrlish = entryHasScheme ? e : `http://${e}`;
    let entryHost;
    try {
      const eu = new URL(eUrlish);
      entryHost = eu.host.toLowerCase();
    } catch {
      entryHost = e.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
    if (entryHost === req) return true;
    if (e.indexOf("*.") !== -1) {
      const starIdx = e.indexOf("*.");
      const suffix = e.slice(starIdx + 2);
      const suffixHost = suffix.replace(/^https?:\/\//i, "").split(":")[0];
      const reqHost = req.split(":")[0];
      if (reqHost === suffixHost) continue; // apex — wildcard does NOT match
      if (reqHost.length > suffixHost.length && reqHost.endsWith("." + suffixHost)) {
        return true;
      }
    }
  }
  return false;
}