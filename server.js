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
import { router as analyticsRouter } from "./routes/analytics.js";
import { router as analyticsEmbedRouter } from "./routes/analytics-embed.js";
import { router as submissionsRouter } from "./routes/submissions.js";
import { router as blogRouter } from "./routes/blog.js";
import { router as blogPublicRouter } from "./routes/blog-public.js";
import { router as blogAttachmentsRouter } from "./routes/blog-attachments.js";
import { router as faqRouter } from "./routes/faq.js";
import { router as faqPublicRouter } from "./routes/faq-public.js";
import { router as serviceRouter } from "./routes/service.js";
import { router as servicePublicRouter } from "./routes/service-public.js";
import { router as internalRouter } from "./routes/internal.js";
import { pool } from "./db/pool.js";
import { assertSafeStartup } from "./lib/startup-guard.js";
import { stop as stopEmailQueue } from "./lib/email-queue.js";

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
        imgSrc: ["'self'", "data:", "blob:"],
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

// Helper — the /api/public/* endpoints are explicitly designed to be
// invoked from any origin (per ADR 0009: no iframe, no loader; the
// secret_token is the capability, the per-IP rate-limiters in the
// routers are the abuse defence). Mirror the prefix-match that
// middleware/csrf.js#isPublicCsrfExempt uses, so both layers stay
// in lock-step. Behaviour MUST be kept identical — if you add a new
// public surface, both helpers must cover it.
function isPublicPath(fullPath) {
  return fullPath.startsWith("/api/public/");
}
function extractApiPath(req) {
  // For the top-level /api mount, full path == /api + req.path. For
  // mounted sub-routers (req.baseUrl), it's baseUrl + req.path. We
  // intentionally do NOT use req.url (it carries the query string).
  return (req.baseUrl || "") + req.path;
}

app.use("/api", (req, res, next) => {
  if (!STATE_CHANGING.has(req.method)) return next();
  // /api/public/* is cross-origin by design — handled below by the
  // public-embed CORS handler.
  if (isPublicPath(extractApiPath(req))) return next();
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

// Analytics module — same sibling pattern as Forms / Reservations. Admin
// CRUD lives on /api/analytics (mounted below), the public script loader
// and event collection endpoint live on /api/public/analytics (mounted
// after the CORS handler below). See routes/analytics.js and
// routes/analytics-embed.js.
app.use("/api/analytics", analyticsRouter);

// Submissions overview — cross-project aggregation endpoints for the
// Submissions page (form submissions + reservation bookings + calendar).
app.use("/api/submissions", submissionsRouter);

// Blog admin CRUD — same auth/RBAC/scope contract as /api/forms. Mutating
// routes (POST/PUT/DELETE + publish/unpublish) are gated by requireAuth
// inside the router; endusers have read-only access scoped to their
// assigned projects, identical to forms.
app.use("/api/blog", blogRouter);

// Blog attachment admin endpoints (cover image upload). Mounted on
// the same admin surface as blogRouter — the inner routes are
// already gated by requireAuth + RBAC.
app.use("/api/blog", blogAttachmentsRouter);

// FAQ admin CRUD — same auth/RBAC/scope contract as blog.
app.use("/api/faq", faqRouter);

// Service admin CRUD — same auth/RBAC/scope contract as FAQ.
app.use("/api/service", serviceRouter);

// Internal surface for service-to-service callbacks. Mounted after the
// CSRF middleware but exempted from it via middleware/csrf.js#isPublicCsrfExempt.
// Auth is the X-Internal-Secret header (see routes/internal.js).
app.use("/api/internal", internalRouter);

// --- Embeddable form infrastructure ---------------------------------------
// Forms have NO iframe and NO loader script (ADR 0009). The public POST
// endpoint handles a direct submission from any host page; no CSP bypass
// is required because the visitor never loads our origin inside theirs.
//
// Per ADR 0009 the secret_token is the capability, and the per-IP
// burst+sustained rate-limiters in the routers are the abuse defence —
// so the CORS contract for /api/public/* simply reflects the request
// origin (or `*` in dev) and whitelists the methods/headers the embed
// actually needs. This is identical in shape to how Formspree / Getform
// / Netlify Forms handle cross-origin embeds.
const PUBLIC_EMBED_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};
function applyPublicCors(req, res) {
  const origin = req.headers.origin;
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    // Dev: reflect everything (incl. `null` or missing origin). The
    // user explicitly asked for this — see project session log. For
    // prod, this branch is intentionally NOT taken: production should
    // move to an explicit allowlist (see TODO_PROD_ORIGINS below).
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    // Some browsers (notably Chrome) treat cross-origin fetches as
    // credentialed by default when the BE is on `localhost` and the
    // page is on a different localhost port. The analytics endpoint
    // doesn't read cookies (it uses req.ip for rate limiting), so
    // advertising credentials=true here is safe and prevents the
    // preflight from being rejected. Only enabled in dev to match the
    // existing dev-only reflection policy.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (typeof origin === "string" && origin.length > 0) {
    // TODO_PROD_ORIGINS: replace this reflection with an explicit
    // allowlist sourced from env (e.g. PUBLIC_EMBED_ALLOWED_ORIGINS,
    // comma-separated). Until that is wired, prod reflection is left
    // in place as a safety net so the user's local dev / staging
    // workflows keep working. Document this in the ADR follow-up.
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  for (const [k, v] of Object.entries(PUBLIC_EMBED_CORS_HEADERS)) {
    res.setHeader(k, v);
  }
  // Helmet defaults CORP to same-origin, which blocks cross-origin image
  // loading on landing pages (different port in dev, different origin in
  // prod). Public routes are designed for cross-origin access, so override.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
app.use("/api/public/forms", (req, res, next) => {
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use("/api/public/reservations", (req, res, next) => {
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use("/api/public/analytics", (req, res, next) => {
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
// Blog public read API — same CORS contract as the other /api/public/*
// surfaces (reflect origin, GET-only, no credentials). The Host-header
// check inside the router is the actual auth.
app.use("/api/public/blog", (req, res, next) => {
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use("/api/public/faq", (req, res, next) => {
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Public submission endpoint (no auth, no CSRF). The /api/public/* prefix
// is CSRF-exempt per middleware/csrf.js; the secret_token is the
// capability. Rate-limited with two chained express-rate-limit instances
// (burst + sustained) inside the router.
app.use("/api/public/forms", formEmbedRouter);
app.use("/api/public/reservations", reservationEmbedRouter);
// Public analytics script loader + event collect. Same CSRF-exempt +
// per-IP rate-limit contract as the form / reservation embeds.
app.use("/api/public/analytics", analyticsEmbedRouter);
// Public blog read API. Host-header auth + per-IP rate limit; mounted
// under /api/public/* to inherit the CSRF-exempt + CORS-reflect
// contract from the middleware block above.
app.use("/api/public/blog", blogPublicRouter);
app.use("/api/public/faq", faqPublicRouter);
app.use("/api/public/service", servicePublicRouter);

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

const server = app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (NODE_ENV=${process.env.NODE_ENV || "development"})`);
});

// Graceful shutdown. docker stop sends SIGTERM and waits
// stop_grace_period (default 10s) before SIGKILL; SIGINT fires on
// ctrl-c in dev. We drain the email queue first so any notification
// in flight at deploy time gets a chance to land — losing the row
// in the DB is fine because it's already persisted, but losing the
// email means the operator doesn't know the submission happened.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, draining email queue + closing server`);
  try {
    await stopEmailQueue();
  } catch (err) {
    console.error("[server] email queue drain failed:", err.message);
  }
  // Stop accepting new connections. Existing in-flight requests get
  // a small grace window (default behaviour of server.close) to
  // finish before we exit.
  server.close((err) => {
    if (err) console.error("[server] close error:", err.message);
    // Exit cleanly regardless — docker will SIGKILL after the grace
    // period anyway, so a clean exit is better than a forced one.
    process.exit(err ? 1 : 0);
  });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
