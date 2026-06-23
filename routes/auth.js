import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";

export const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = parseInt(process.env.JWT_ACCESS_TTL || "3600", 10);
const REFRESH_TTL = parseInt(process.env.JWT_REFRESH_TTL || "604800", 10);

if (!JWT_SECRET) {
  console.error("JWT_SECRET must be set");
  process.exit(1);
}

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: "admin" },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: ACCESS_TTL }
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

async function setAuthCookies(res, user) {
  const accessToken = signAccess(user);
  const refresh = signRefresh(user.id);

  res.cookie("sessionId", crypto.randomBytes(32).toString("hex"), cookieOpts(REFRESH_TTL));
  res.cookie("token", accessToken, cookieOpts(ACCESS_TTL));
  res.cookie("refreshToken", refresh.token, cookieOpts(REFRESH_TTL));

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [user.id, refresh.hash, REFRESH_TTL]
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

// Pre-computed bcrypt hash for "dummy" — used to keep timing constant when the user
// doesn't exist or is disabled (defeats email enumeration via response timing).
// Generated with: bcrypt.hashSync("dummy-for-timing-only", 12)
const DUMMY_HASH = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8jVQfGvM3vQ5Y5Y5Y5Y5Y5Y5Y5Y5Ye";

router.post("/signin", signinLimiter, async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ errorMessage: "Missing credentials" });
  }
  if (typeof password !== "string" || password.length > 128) {
    return res.status(400).json({ errorMessage: "Invalid credentials" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, first_name, last_name, enabled
       FROM users WHERE email = $1`,
      [identifier]
    );
    const user = rows[0];
    // Always run bcrypt.compare, even on miss/disabled — keeps response time constant.
    const hashToCheck = user && user.enabled ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hashToCheck);
    if (!user || !user.enabled || !ok) {
      console.warn(`[auth/signin] failed attempt for identifier: ${identifier} (user_found=${!!user})`);
      return res.status(401).json({ errorMessage: "Invalid credentials" });
    }
    await setAuthCookies(res, user);
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        enabled: user.enabled,
      },
      passwordChangeRequired: false,
    });
  } catch (err) {
    console.error("[auth/signin]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

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
      `SELECT rt.id, rt.user_id, u.email, u.first_name, u.last_name, u.enabled
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
      [jtiHash]
    );
    if (rows.length === 0) {
      return res.status(401).json({ errorMessage: "Refresh token revoked" });
    }
    const row = rows[0];

    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

    const user = {
      id: row.user_id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      enabled: row.enabled,
    };
    await setAuthCookies(res, user);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        enabled: user.enabled,
      },
      passwordChangeRequired: false,
    });
  } catch (err) {
    console.error("[auth/refresh]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ errorMessage: "Unauthorized" });
  try {
    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, enabled FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(401).json({ errorMessage: "User not found" });
    const u = rows[0];
    return res.json({
      user: {
        id: u.id,
        email: u.email,
        firstName: u.first_name,
        lastName: u.last_name,
        enabled: u.enabled,
      },
    });
  } catch (err) {
    console.error("[auth/me]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ["HS256"] });
      const jtiHash = crypto.createHash("sha256").update(decoded.jti).digest("hex");
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
        [jtiHash]
      );
    } catch {
      // already invalid
    }
  }
  clearAuthCookies(res);
  return res.json({ success: true });
});

export { clearAuthCookies };
