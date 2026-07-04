import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("JWT_SECRET must be set");
  process.exit(1);
}

// Pull the role + projectIds out of a verified access token. The token
// is signed by routes/auth.js at signin/refresh time, so the data here
// is operator-trusted (we never re-query the DB to validate). Note that
// this means revoking a project assignment takes up to JWT_ACCESS_TTL
// to take effect on an open session — which is acceptable for v1.
export function jwtAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role || "admin",
      // projectIds is an array of bigint-shaped numbers; enduser only.
      // Admins will have this as [] (or undefined) — getScopedProjectIds
      // returns null for admins regardless.
      projectIds: Array.isArray(decoded.projectIds)
        ? decoded.projectIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [],
    };
  } catch {
    req.user = null;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ errorMessage: "Unauthorized" });
  }
  next();
}

// New: require the authenticated user to be an admin. Endusers hitting
// an admin-only route get 403 (not 401) because they ARE authenticated,
// just not authorized. Mirrors the http semantics the rest of the BE
// uses (auth, not authz, errors).
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ errorMessage: "Unauthorized" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ errorMessage: "Admin access required" });
  }
  next();
}
