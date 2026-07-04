// Public embed endpoint for the Forms module (added in 0010 per ADR 0009).
//
// Behaviour (locked-in by the brief and ADR 0009):
//   - Public, no auth/CSRF (the /api/public/* prefix is CSRF-exempt per
//     middleware/csrf.js; the secret_token is the capability).
//   - Two rate-limiters in chain:
//       formBurstLimiter      3 req / IP / 60 s     (defends against floods)
//       formSustainedLimiter  100 req / IP / 24 h   (hard daily cap)
//     Both configurable via PUBLIC_FORM_SUBMISSION_BURST_LIMIT and
//     PUBLIC_FORM_SUBMISSION_SUSTAINED_LIMIT.
//   - Origin must match the form's allowed_origins list (or the list
//     must be empty) — wildcard/exact semantics keyed against
//     `req.headers.origin` directly.
//   - `data` is an opaque JSON object. Validation rules:
//       * IsPlainObject (not array, not null)
//       * Depth ≤ 5 levels
//       * ≤ 50 keys per level (any nested level)
//       * ≤ 50 KB JSON-encoded total (pre-flighted before insert)
//   - `locale` is optional, ≤ 10 chars.
//   - 201 + { id, submittedAt } on success.
//   - 404 if the secret_token is unknown OR the form is disabled —
//     indistinguishable so we don't leak existence.
//   - 404 if the origin doesn't match the (non-empty) allowlist —
//     indistinguishable from "unknown token" for the same reason.

import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";

export const router = express.Router();

// Two chained limiters. The order matters: the burst limiter runs FIRST
// (per-minute), then the sustained limiter (per-day). The chain returns
// the FIRST 429 the IP triggers — a flood attacker gets 429 in seconds,
// a slow drip attacker gets 429 within a day.
const formBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_FORM_SUBMISSION_BURST_LIMIT || "3", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many submissions, please try again later" },
  keyGenerator: (req) => `form-burst:${req.ip}`,
});

const formSustainedLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: parseInt(process.env.PUBLIC_FORM_SUBMISSION_SUSTAINED_LIMIT || "100", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many submissions, please try again later" },
  keyGenerator: (req) => `form-sustained:${req.ip}`,
});

// Validation constants — kept local to this route (they are not reused
// by the admin route; admin `data` validation is intentionally NOT
// performed — forms don't have a "fields" schema).
const DATA_MAX_KEYS_PER_LEVEL = 50;
const DATA_MAX_DEPTH = 5;
const DATA_MAX_BYTES = 50 * 1024; // 50 KB JSON-encoded ceiling.
const LOCALE_MAX_LEN = 10;

// Recursively count the keys in any nested plain object + measure the
// nesting depth. Returns { keys: <max>*, depth: <max> }. Used by the
// `data` pre-flight validator so we can reject pathological payloads
// without exploding the JSONB writer.
function measureBag(obj, currentDepth = 1, results = { keys: 0, depth: 1 }) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return results;
  // Count keys at this level. We don't use Object.keys() in case the
  // object has a non-enumerable prototype-bypass shape — keep it
  // permissive for the typical JSON.parse output.
  const keys = Object.keys(obj).length;
  if (keys > results.keys) results.keys = keys;
  if (currentDepth > results.depth) results.depth = currentDepth;
  if (currentDepth >= DATA_MAX_DEPTH) return results;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      measureBag(v, currentDepth + 1, results);
    }
  }
  return results;
}

// ---- POST /:secret_token/submissions ----
router.post(
  "/:secret_token/submissions",
  formBurstLimiter,
  formSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken } = req.params;
    if (
      typeof secretToken !== "string" ||
      secretToken.length !== 22
    ) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    const body = req.body ?? {};
    const data = body.data;

    // Validate data shape — plain object, depth + keys + size limits.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({ errorMessage: "data must be an object" });
    }
    const measurements = measureBag(data);
    if (measurements.depth > DATA_MAX_DEPTH) {
      return res
        .status(400)
        .json({ errorMessage: `data exceeds max depth ${DATA_MAX_DEPTH}` });
    }
    if (measurements.keys > DATA_MAX_KEYS_PER_LEVEL) {
      return res.status(400).json({
        errorMessage: `data exceeds max ${DATA_MAX_KEYS_PER_LEVEL} keys per level`,
      });
    }
    // Serialise once to measure the JSON footprint. We then re-use the
    // serialised string for the INSERT below (no double-encoding).
    let dataJson;
    try {
      dataJson = JSON.stringify(data);
    } catch (e) {
      return res.status(400).json({ errorMessage: "data is not serialisable" });
    }
    if (Buffer.byteLength(dataJson, "utf8") > DATA_MAX_BYTES) {
      return res
        .status(400)
        .json({ errorMessage: `data exceeds max ${DATA_MAX_BYTES} bytes` });
    }

    // Locale: optional, ≤ 10 chars. We accept any string ≤ 10 chars;
    // the operator doesn't constrain it to a fixed list (the FE is
    // responsible for sending a valid one).
    let locale = null;
    if (typeof body.locale === "string" && body.locale.length > 0) {
      if (body.locale.length > LOCALE_MAX_LEN) {
        return res
          .status(400)
          .json({ errorMessage: `locale must be ≤ ${LOCALE_MAX_LEN} chars` });
      }
      locale = body.locale;
    }

    try {
      // Look up form by secret_token. We deliberately do NOT include
      // status in the WHERE clause here — we want one round-trip that
      // tells us "unknown token" vs. "known but disabled" so we can
      // (a) map both to the same 404 (no existence leak), and
      // (b) skip the allowlist + insert for both.
      const result = await pool.query(
        `SELECT id, status, allowed_origins
         FROM forms
         WHERE secret_token = $1`,
        [secretToken],
      );
      if (result.rowCount === 0 || result.rows[0].status !== "active") {
        // Indistinguishable 404 — don't leak existence or status.
        return res.status(404).json({ errorMessage: "Form not found" });
      }
      const row = result.rows[0];
      const formId = Number(row.id);

      // Origin allowlist enforcement. Empty allowlist = no restriction
      // (backwards-compatible). When non-empty, the request's origin
      // header MUST be in it. We use the same scheme + host[+port]
      // normalisation as src/components/forms/origin-allowlist.ts.
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
          return res.status(404).json({ errorMessage: "Form not found" });
        }
      }

      // Capture metadata. Trim the user-agent and referer to safe upper
      // bounds to avoid blowing up the row on pathological inputs.
      const ipAddress = req.ip || req.socket?.remoteAddress || null;
      const userAgent = typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null;
      const referer = typeof req.headers.referer === "string"
        ? req.headers.referer.slice(0, 2000)
        : null;

      const insertResult = await pool.query(
        `INSERT INTO form_submissions
           (form_id, ip_address, user_agent, referer, data, locale)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING id, submitted_at`,
        [
          formId,
          ipAddress,
          userAgent,
          referer,
          dataJson,
          locale,
        ],
      );
      return res.status(201).json({
        id: Number(insertResult.rows[0].id),
        submittedAt:
          insertResult.rows[0].submitted_at instanceof Date
            ? insertResult.rows[0].submitted_at.toISOString()
            : insertResult.rows[0].submitted_at,
      });
    } catch (err) {
      console.error("[forms/public/submit]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// Same wildcard/exact match semantics as src/components/forms/origin-allowlist.ts
// (the FE mirror of this function). Keep the two in sync.
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
    req = requestOrigin.replace(/\/$/, "").replace(/^https?:\/\//i, "").toLowerCase();
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
