import express from "express";
import { pool } from "../db/pool.js";

// Internal endpoint for the host-cron rebuild wrapper to write back the
// outcome of a landing build. Mounted under /api/internal/* so it's
// excluded from the cross-origin check in server.js (state-changing
// /api/* requests are gated by Origin match; the host script doesn't
// have an Origin header).
//
// Auth: a shared secret sent in the X-Internal-Secret header. The
// secret is generated once and stored in the host's
// /etc/landing-rebuild.env file (read by the cron wrapper) and in the
// CRM container's .env (read here). 32 bytes hex = 64 chars.
//
// Why a custom header instead of cookie/JWT:
//   - The cron script doesn't have cookies. JWT would require minting a
//     service-account token per environment.
//   - A shared-secret header is the standard for service-to-service
//     auth on the same host (loopback call from a cron script).
//   - The endpoint is mounted under /api/internal which is excluded
//     from the public CORS contract — only callers that know the
//     secret can hit it.
//
// Trust boundary:
//   The endpoint trusts whatever payload it receives. The host script
//   controls what it writes; we don't re-validate the build command
//   because the path/env came from the projects.landing_* columns the
//   operator already configured through the CRM UI.

const DEFAULT_INTERNAL_SECRET = process.env.LANDING_INTERNAL_SECRET || "";

function checkInternalSecret(req, res, next) {
  const provided = req.headers["x-internal-secret"];
  if (
    !DEFAULT_INTERNAL_SECRET ||
    typeof provided !== "string" ||
    provided.length !== DEFAULT_INTERNAL_SECRET.length ||
    !timingSafeEqual(provided, DEFAULT_INTERNAL_SECRET)
  ) {
    return res.status(401).json({ errorMessage: "Unauthorized" });
  }
  return next();
}

// Constant-time comparison to avoid timing oracles on the secret.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export const router = express.Router();
router.use(checkInternalSecret);

// ---- POST /api/internal/landing-build-status ----
// Body: {
//   domain: "zsoltberta.hu",                // required, for project lookup
//   status: "success" | "failed",            // required
//   log: "...",                              // optional, last ~2 KB of stderr
//   durationMs: 12345                        // optional, observed build time
// }
router.post("/landing-build-status", async (req, res) => {
  const { domain, status, log, durationMs } = req.body || {};

  if (typeof domain !== "string" || domain.length === 0 || domain.length > 255) {
    return res.status(400).json({ errorMessage: "Invalid domain" });
  }
  if (status !== "success" && status !== "failed") {
    return res.status(400).json({ errorMessage: "status must be 'success' or 'failed'" });
  }
  if (log !== undefined && (typeof log !== "string" || log.length > 8000)) {
    return res.status(400).json({ errorMessage: "log must be a string up to 8000 chars" });
  }
  if (durationMs !== undefined && (typeof durationMs !== "number" || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000)) {
    return res.status(400).json({ errorMessage: "durationMs must be a non-negative number" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE projects
       SET landing_last_build_at = now(),
           landing_last_build_status = $1,
           landing_last_build_log = $2
       WHERE domain_address = $3
          OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $3
       RETURNING id`,
      [status, log ? log.slice(-2000) : null, domain.toLowerCase()],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Project not found for domain" });
    }
    return res.status(204).end();
  } catch (err) {
    console.error("[internal/landing-build-status]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});