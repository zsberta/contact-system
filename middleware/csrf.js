// Paths that are CSRF-exempt. They never have an authenticated session
// to issue a token against and are gated by a different capability
// (password, snippet token, public token, etc.).
const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/signin",
  "/api/auth/refresh",
  "/api/auth/set-password",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/csrf",
  "/api/csrf/refresh",
]);

// Public POST endpoints mounted under /api/public/* are also CSRF-exempt —
// they don't have an authenticated session to issue a token against and
// they're already gated by the snippetId capability + per-IP rate limiting.
// Prefix-match so all child paths (e.g. /api/public/widgets/:snippetId/submissions)
// bypass the check without each path needing to be listed individually.
//
// /api/internal/* is also CSRF-exempt: it's gated by a shared secret in
// the X-Internal-Secret header, used by the host-cron rebuild wrapper
// (no cookies, no browser session, no CSRF token to issue).
function isPublicCsrfExempt(fullPath) {
  if (PUBLIC_AUTH_PATHS.has(fullPath)) return true;
  if (fullPath.startsWith("/api/public/")) return true;
  if (fullPath.startsWith("/api/internal/")) return true;
  return false;
}

export function csrfProtection(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  // req.path is relative to the mount point (stripped), so reconstruct full path
  // via req.originalUrl's pathname. For top-level /api mount, this equals
  // /api + req.path; for child routers (req.baseUrl) it's baseUrl + req.path.
  const fullPath = (req.baseUrl || "") + req.path;
  if (isPublicCsrfExempt(fullPath)) return next();

  const cookieToken = req.cookies?.["XSRF-TOKEN"];
  const headerToken = req.headers["x-xsrf-token"];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ errorMessage: "Invalid CSRF token" });
  }
  next();
}
