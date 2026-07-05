import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { jwtAuth } from "./middleware/jwtAuth.js";
import { csrfProtection } from "./middleware/csrf.js";
import { router as authRouter } from "./routes/auth.js";
import { router as csrfRouter } from "./routes/csrf.js";
import { router as dashboardRouter } from "./routes/dashboard.js";
import { router as projectsRouter } from "./routes/projects.js";
import { router as paymentsRouter } from "./routes/payments.js";
import { router as paymentAttachmentsRouter } from "./routes/payment-attachments.js";
import { router as projectPaymentGeneratorRouter } from "./routes/project-payment-generator.js";
import { router as usersRouter } from "./routes/users.js";
import { router as formsRouter } from "./routes/forms.js";
import { router as formEmbedRouter } from "./routes/form-embed.js";
import { router as reservationsRouter } from "./routes/reservations.js";
import { router as reservationEmbedRouter } from "./routes/reservation-embed.js";
import { pool } from "./db/pool.js";
import { assertSafeStartup } from "./lib/startup-guard.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.disable("x-powered-by");

// Fail-fast on insecure startup config (weak passwords, wrong SameSite, etc.)
assertSafeStartup();

// Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: "100kb" }));
// Trust X-Forwarded-* headers from a single upstream proxy (Caddy/nginx).
// Required for express-rate-limit to count per-client (not per-load-balancer).
app.set("trust proxy", 1);

app.use(cookieParser());
app.use(jwtAuth);

// Origin/Referer check on state-changing requests — defense in depth on top of CSRF.
// Rejects cross-origin POST/PUT/DELETE/PATCH by comparing Origin (or Referer) to Host.
const STATE_CHANGING = new Set(["POST", "PUT", "DELETE", "PATCH"]);
app.use("/api", (req, res, next) => {
  if (!STATE_CHANGING.has(req.method)) return next();
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  // No Origin/Referer = non-browser client (curl, server-to-server). Allow but log.
  if (!origin) return next();
  const expected = `${req.protocol}://${req.headers.host}`;
  if (origin !== expected) {
    return res.status(403).json({ errorMessage: "Cross-origin rejected" });
  }
  next();
});

// Global rate limit (per-IP) — catch-all for any /api/* not covered by a tighter limiter below.
// Set generously (10000/min) so E2E + load tests don't hit walls. Tune via API_GLOBAL_LIMIT env var.
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.API_GLOBAL_LIMIT || "10000", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { errorMessage: "Too many requests" },
  }),
);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up", uptime: process.uptime() });
  } catch (e) {
    // Don't leak the pg error message — it can include connection-string fragments.
    console.error("[health] db check failed:", e.code, e.message);
    res.status(500).json({ status: "error", db: "down" });
  }
});

app.use("/api", csrfProtection);
app.use("/api/auth", authRouter);
app.use("/api/csrf", csrfRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/users", usersRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/payments", paymentAttachmentsRouter);
app.use("/api/projects", projectPaymentGeneratorRouter);
app.use("/api/forms", formsRouter);
// Reservations sibling module — same scoping/capability/allowlist/security
// patterns as Forms. See routes/reservations.js and routes/reservation-embed.js.
app.use("/api/reservations", reservationsRouter);

// --- Embeddable form infrastructure ---------------------------------------
// Forms have NO iframe and NO loader script (ADR 0009). The public POST
// endpoint handles a direct submission from any host page; no CSP bypass
// is required because the visitor never loads our origin inside theirs.

// Public submission endpoint (no auth, no CSRF). The /api/public/* prefix
// is CSRF-exempt per middleware/csrf.js; the secret_token is the
// capability. Rate-limited with two chained express-rate-limit instances
// (burst + sustained) inside the router.
app.use("/api/public/forms", formEmbedRouter);
app.use("/api/public/reservations", reservationEmbedRouter);

const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.use((err, req, res, _next) => {
  // Don't log the full err object — pg errors can include parameter values.
  console.error("[server]", err.code, err.message);
  res.status(err.status || 500).json({ errorMessage: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (NODE_ENV=${process.env.NODE_ENV || "development"})`);
});
