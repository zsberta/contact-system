const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/signin",
  "/api/auth/refresh",
  "/api/csrf",
  "/api/csrf/refresh",
]);

export function csrfProtection(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  // req.path is relative to the mount point (stripped), so reconstruct full path
  // via req.originalUrl's pathname. For top-level /api mount, this equals
  // /api + req.path; for child routers (req.baseUrl) it's baseUrl + req.path.
  const fullPath = (req.baseUrl || "") + req.path;
  if (PUBLIC_AUTH_PATHS.has(fullPath)) return next();

  const cookieToken = req.cookies?.["XSRF-TOKEN"];
  const headerToken = req.headers["x-xsrf-token"];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ errorMessage: "Invalid CSRF token" });
  }
  next();
}
