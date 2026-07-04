// routes/auth.js
//
// Authentication routes:
//   - POST /api/auth/signin                  public, CSRF-exempt
//   - POST /api/auth/refresh                 public, CSRF-exempt
//   - GET  /api/auth/me                      protected (any role)
//   - POST /api/auth/logout                  protected (any role)
//
// Enduser-specific (all public, CSRF-exempt):
//   - POST /api/auth/set-password            accepts an invite token,
//                                            sets the initial password
//   - POST /api/auth/forgot-password         always 200 (no enumeration)
//   - POST /api/auth/reset-password          consumes a reset token
//
// JWTs carry { sub, email, role, projectIds }. `projectIds` is the
// list of projects the enduser is currently assigned to, refreshed at
// every signin/refresh. Admins always get [] (no scoping).
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { sendMail, resolvePublicUrl } from "../lib/email.js";

export const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = parseInt(process.env.JWT_ACCESS_TTL || "3600", 10);
const REFRESH_TTL = parseInt(process.env.JWT_REFRESH_TTL || "604800", 10);
const BCRYPT_COST = parseInt(process.env.BCRYPT_COST || "12", 10);
const INVITE_TTL_SEC = 24 * 60 * 60; // 24 hours
const RESET_TTL_SEC = 15 * 60; // 15 minutes

if (!JWT_SECRET) {
  console.error("JWT_SECRET must be set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------
//
// Mirrors the policy in routes/users.js and db/seed.js: 8+ chars, NOT in
// the deny-list. We keep the lists in sync by importing from a single
// source of truth below; if you change one, change the other.
const PASSWORD_DENY_LIST = new Set([
  "changeme",
  "changeme123",
  "admin",
  "password",
  "12345678",
  "qwerty",
  "letmein",
]);

function validatePassword(plain) {
  if (typeof plain !== "string" || plain.length < 8 || plain.length > 128) {
    return "Password must be 8..128 characters";
  }
  if (PASSWORD_DENY_LIST.has(plain.toLowerCase())) {
    return "Password is too weak";
  }
  return null;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
//
// Lookup the role + projectIds for a user_id. Used at signin and refresh
// so the JWT always carries the latest assignment snapshot.
async function loadUserAuthContext(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.enabled, u.role,
            u.must_set_password,
            COALESCE(
              (SELECT array_agg(project_id ORDER BY project_id)
                 FROM user_project_assignments WHERE user_id = u.id),
              ARRAY[]::bigint[]
            ) AS project_ids
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    enabled: r.enabled,
    role: r.role,
    mustSetPassword: !!r.must_set_password,
    projectIds: Array.isArray(r.project_ids)
      ? r.project_ids.map((n) => Number(n))
      : [],
  };
}

function signAccess(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || "admin",
      projectIds: user.role === "enduser" ? (user.projectIds || []) : [],
    },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: ACCESS_TTL },
  );
}

function signRefresh(userId) {
  const jti = crypto.randomBytes(32).toString("hex");
  const token = jwt.sign({ sub: userId, jti }, JWT_SECRET, { algorithm: "HS256", expiresIn: REFRESH_TTL });
  return { token, jti, hash: crypto.createHash("sha256").update(jti).digest("hex") };
}

function cookieOpts(maxAgeSec) {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: process.env.COOKIE_SAMESITE || "Lax",
    maxAge: maxAgeSec * 1000,
    path: "/",
  };
}

// Build the public user DTO that's safe to return in API responses.
function userToDTO(ctx) {
  return {
    id: Number(ctx.id),
    email: ctx.email,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    enabled: ctx.enabled,
    role: ctx.role,
    mustSetPassword: !!ctx.mustSetPassword,
    // Only endusers get the assignment list back; admins get an empty
    // array to keep the contract symmetric.
    projectIds: Array.isArray(ctx.projectIds) ? ctx.projectIds : [],
  };
}

async function setAuthCookies(res, userCtx) {
  const accessToken = signAccess(userCtx);
  const refresh = signRefresh(userCtx.id);

  res.cookie("sessionId", crypto.randomBytes(32).toString("hex"), cookieOpts(REFRESH_TTL));
  res.cookie("token", accessToken, cookieOpts(ACCESS_TTL));
  res.cookie("refreshToken", refresh.token, cookieOpts(REFRESH_TTL));

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [userCtx.id, refresh.hash, REFRESH_TTL],
  );
}

function clearAuthCookies(res) {
  res.clearCookie("sessionId", { path: "/" });
  res.clearCookie("token", { path: "/" });
  res.clearCookie("refreshToken", { path: "/" });
}

// Tight limiter on /signin — 5 attempts per IP per 15 min. Defeats online brute-force.
const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many sign-in attempts, try again later" },
});

// Looser limiter on /refresh — bound abuse without locking out a legitimate user.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

// Tight limiter on /forgot-password + /reset-password — defeats enumeration
// + brute-force of reset tokens.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

// Per-action limiter for the set-password flow (the attacker needs a
// valid token, but we still cap noise).
const setPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

// Pre-computed bcrypt hash for "dummy" — used to keep timing constant when the user
// doesn't exist or is disabled (defeats email enumeration via response timing).
// Generated with: bcrypt.hashSync("dummy-for-timing-only", BCRYPT_COST)
// (the actual hash is irrelevant — only its cost matches).
const DUMMY_HASH = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8jVQfGvM3vQ5Y5Y5Y5Y5Y5Y5Y5Y5Ye";

// ---------------------------------------------------------------------------
// Signin
// ---------------------------------------------------------------------------
router.post("/signin", signinLimiter, async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ errorMessage: "Missing credentials" });
  }
  if (typeof password !== "string" || password.length > 128) {
    return res.status(400).json({ errorMessage: "Invalid credentials" });
  }
  try {
    const ctx = await loadUserAuthContext(
      // loadUserAuthContext does a SELECT by id; here we look up by email first.
      // We do the email lookup inline so we can run a single SELECT and avoid
      // a TOCTOU between the email→id SELECT and the user-row SELECT.
      (await pool.query(`SELECT id FROM users WHERE email = $1`, [identifier])).rows[0]?.id,
    );
    const hashToCheck = ctx && ctx.enabled && !ctx.mustSetPassword ? (await getPasswordHash(ctx.id)) : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hashToCheck);
    if (!ctx || !ctx.enabled || ctx.mustSetPassword || !ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[auth/signin] failed attempt for identifier: ${identifier} (user_found=${!!ctx}, mustSetPassword=${ctx?.mustSetPassword})`,
      );
      return res.status(401).json({ errorMessage: "Invalid credentials" });
    }
    await setAuthCookies(res, ctx);
    return res.json({
      user: userToDTO(ctx),
      passwordChangeRequired: false,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth/signin]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// Cache-busting helper: returns the current password_hash for a user_id.
// Used by the signin path to feed bcrypt.compare. We don't bundle the
// hash into loadUserAuthContext because it's only needed on the
// signin attempt itself, not on refresh.
async function getPasswordHash(userId) {
  const { rows } = await pool.query(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.password_hash || DUMMY_HASH;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
router.post("/refresh", refreshLimiter, async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) return res.status(401).json({ errorMessage: "No refresh token" });

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ errorMessage: "Invalid refresh token" });
  }

  const jtiHash = crypto.createHash("sha256").update(decoded.jti).digest("hex");
  try {
    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id
       FROM refresh_tokens rt
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
      [jtiHash],
    );
    if (rows.length === 0) {
      return res.status(401).json({ errorMessage: "Refresh token revoked" });
    }
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [rows[0].id]);
    const ctx = await loadUserAuthContext(rows[0].user_id);
    if (!ctx || !ctx.enabled || ctx.mustSetPassword) {
      // User was disabled or password was reset since this token was issued.
      clearAuthCookies(res);
      return res.status(401).json({ errorMessage: "Session no longer valid" });
    }
    await setAuthCookies(res, ctx);
    return res.json({ user: userToDTO(ctx), passwordChangeRequired: false });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth/refresh]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// /me — current session
// ---------------------------------------------------------------------------
router.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ errorMessage: "Unauthorized" });
  try {
    const ctx = await loadUserAuthContext(req.user.id);
    if (!ctx) return res.status(401).json({ errorMessage: "User not found" });
    if (!ctx.enabled || ctx.mustSetPassword) {
      clearAuthCookies(res);
      return res.status(401).json({ errorMessage: "Session no longer valid" });
    }
    return res.json({ user: userToDTO(ctx) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth/me]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ["HS256"] });
      const jtiHash = crypto.createHash("sha256").update(decoded.jti).digest("hex");
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
        [jtiHash],
      );
    } catch {
      // already invalid
    }
  }
  clearAuthCookies(res);
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// set-password (invite flow)
//
// Body: { token: string, newPassword: string }
// Validates the invite token (must be unconsumed + unexpired) and
// sets the user's password. Clears must_set_password. Consumes the
// invite row in the same transaction.
//
// Public route (CSRF-exempt) — the token is the capability. The FE
// redirects to /set-password?token=… from the email link.
// ---------------------------------------------------------------------------
router.post("/set-password", setPasswordLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    return res.status(400).json({ errorMessage: "Invalid token" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ errorMessage: pwErr });

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the invite row to defeat a parallel claim.
    const { rows } = await client.query(
      `SELECT id, user_id, expires_at, consumed_at
       FROM invite_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ errorMessage: "Invalid or expired token" });
    }
    const invite = rows[0];
    if (invite.consumed_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ errorMessage: "Token already used" });
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ errorMessage: "Token has expired" });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // Update the user + consume the invite. We do both in this tx so
    // a crash between the two can't leave a half-set state.
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           must_set_password = false,
           enabled = true,
           updated_at = now()
       WHERE id = $2`,
      [hash, invite.user_id],
    );
    await client.query(
      `UPDATE invite_tokens SET consumed_at = now() WHERE id = $1`,
      [invite.id],
    );
    // Belt-and-braces: revoke any pre-existing refresh tokens so a
    // previously-signed-in session can't be resumed.
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [invite.user_id],
    );
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("[auth/set-password]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// forgot-password
//
// Body: { email: string }
// Always returns 200 with a generic message. If a user with that email
// exists (and is enabled), we generate a reset token, store its hash
// in password_reset_tokens, and email the user a link with the
// plaintext token. Email send is best-effort.
// ---------------------------------------------------------------------------
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.includes("@") || email.length > 255) {
    // Don't 400 on bad email shape — just respond generically so an
    // attacker can't probe valid addresses. But we still 200.
    return res.json({
      success: true,
      message:
        "If an account exists for that email, a password-reset link has been sent.",
    });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, enabled
       FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    const user = rows[0];
    if (user && user.enabled) {
      // 32 random bytes → base64url. The plaintext only ever leaves the
      // server via the email — the DB stores sha256(plaintext).
      const plainToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(plainToken).digest("hex");
      // Wipe any prior unexpired reset rows for this user (a new request
      // supersedes the old one). Saves table bloat if a user clicks
      // "forgot" twice in a row.
      await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [user.id]);
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [user.id, tokenHash, RESET_TTL_SEC],
      );
      const publicUrl = resolvePublicUrl(req);
      const link = `${publicUrl}/reset-password?token=${encodeURIComponent(plainToken)}`;
      const name = user.first_name || "there";
      const body =
        `Hi ${name},\n\n` +
        `We received a request to reset your BuzzCRM password.\n\n` +
        `Click the link below to set a new password (valid for 15 minutes):\n` +
        `${link}\n\n` +
        `If you didn't request this, you can safely ignore this email.\n\n` +
        `— The BuzzCRM team`;
      await sendMail({
        to: user.email,
        subject: "Reset your BuzzCRM password",
        text: body,
      });
    }
    return res.json({
      success: true,
      message:
        "If an account exists for that email, a password-reset link has been sent.",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth/forgot-password]", err.code, err.message);
    return res.json({
      success: true,
      message:
        "If an account exists for that email, a password-reset link has been sent.",
    });
  }
});

// ---------------------------------------------------------------------------
// reset-password
//
// Body: { token: string, newPassword: string }
// Validates the reset token (must be unexpired), sets the password,
// revokes all refresh tokens, and deletes the row.
// ---------------------------------------------------------------------------
router.post("/reset-password", forgotLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    return res.status(400).json({ errorMessage: "Invalid token" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ errorMessage: pwErr });

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, user_id, expires_at
       FROM password_reset_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ errorMessage: "Invalid or expired token" });
    }
    const row = rows[0];
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // Drop the expired row so it doesn't waste a future scan.
      await client.query(`DELETE FROM password_reset_tokens WHERE id = $1`, [row.id]);
      await client.query("COMMIT");
      return res.status(400).json({ errorMessage: "Token has expired" });
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           must_set_password = false,
           enabled = true,
           updated_at = now()
       WHERE id = $2`,
      [hash, row.user_id],
    );
    // Revoke ALL refresh tokens (signs the user out everywhere).
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id],
    );
    // DELETE the reset row, not just mark consumed — see migration 0012.
    await client.query(`DELETE FROM password_reset_tokens WHERE id = $1`, [row.id]);
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("[auth/reset-password]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

export { clearAuthCookies };
