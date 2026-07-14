// routes/analytics.js
//
// =============================================================================
// Analytics module — admin CRUD (sibling to routes/forms.js).
// =============================================================================
//
// Each project has exactly ONE analytics_configs row (enforced by the
// UNIQUE FK on project_id). The row is created lazily on first access
// via GET /api/analytics/by-project/:projectId — the operator doesn't
// need to manually "create" a config before grabbing the snippet.
//
// What lives here (mirrors forms.js exactly):
//   - Admin CRUD on analytics_configs (paginated list, GET, PUT, DELETE)
//   - Lazy upsert GET /api/analytics/by-project/:projectId
//   - Snippet endpoint GET /api/analytics/:id/snippet (renders the JS
//     loader with APP_PUBLIC_URL baked in)
//   - Stats endpoint GET /api/analytics/:id/stats (basic aggregations)
//
// What lives in routes/analytics-embed.js (mounted at /api/public/analytics):
//   - Public script.js: GET /:secret_token/script.js
//   - Public collect:   POST /:secret_token/collect
//
// =============================================================================
// SECURITY MODEL
// =============================================================================
// - All routes here require auth (router.use(requireAuth)). Mutations are
//   rejected with 403 for endusers (read-only contract).
// - Enduser scoping: endusers can only see configs on projects they're
//   assigned to (same pattern as forms / reservations).
// - secret_token is 22-char base64url = 16 random bytes (128 bits entropy),
//   server-generated at create time, immutable thereafter.
// - allowed_origins: same semantics as forms.allowed_origins — wildcard
//   subdomain support, normalised to scheme-prefixed form by the validator.
// - 404 (not 403) is used to mask "unknown config" vs "config on a
//   project you can't see" so an enduser can't probe for config ids.

import express from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";

// Read-only for endusers. Mutations are rejected with 403.
const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduserMutation = (req, res) => {
  if (isEnduser(req)) {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  return null;
};

export const router = express.Router();
router.use(requireAuth);

const STATUS_VALUES = new Set(["active", "disabled"]);

// ---------------------------------------------------------------------------
// Origin-allowlist validator — MUST stay byte-for-byte identical to the one
// in routes/forms.js (same semantics, same regexes). The duplication is
// deliberate: each route validates independently at the boundary, and a
// shared helper would create a cross-cutting import that future schema
// changes might forget to update.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS_MAX = 100;
const HOSTNAME_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const SCHEME_HOSTNAME_RE = /^https?:\/\/(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const LOOPBACK_BARE = /^localhost(:[0-9]{1,5})?$/;
const LOOPBACK_IPV4 = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$/;
const LOOPBACK_IPV6 = /^\[::1?\](:[0-9]{1,5})?$/;
const LOOPBACK_SCHEME = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$/;

function validateAllowedOriginsEntry(entry, index, seen) {
  if (typeof entry !== "string") {
    return `allowedOrigins[${index}]: must be a string`;
  }
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > 253) {
    return `allowedOrigins[${index}]: must be 1..253 chars`;
  }
  const isBare = HOSTNAME_RE.test(trimmed);
  const isScheme = SCHEME_HOSTNAME_RE.test(trimmed);
  const isLoopbackBare = LOOPBACK_BARE.test(trimmed) ||
    LOOPBACK_IPV4.test(trimmed) || LOOPBACK_IPV6.test(trimmed);
  const isLoopbackScheme = LOOPBACK_SCHEME.test(trimmed);
  if (!isBare && !isScheme && !isLoopbackBare && !isLoopbackScheme) {
    return `allowedOrigins[${index}]: invalid origin (${entry})`;
  }
  let normalised;
  if (isScheme || isLoopbackScheme) {
    normalised = trimmed;
  } else {
    normalised = `https://${trimmed}`;
  }
  if (seen.has(normalised)) {
    return `allowedOrigins[${index}]: duplicate`;
  }
  seen.add(normalised);
  return { ok: true, value: normalised };
}

// Snake_case DB row -> camelCase API DTO. allowed_origins may come back as
// either a TEXT[] or a JSON string depending on the driver, so handle both.
function rowToConfigDTO(row) {
  if (!row) return null;
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
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name ?? null,
    name: row.name ?? "",
    secretToken: row.secret_token,
    allowedOrigins,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// Whitelist of sortable API fields -> DB columns. Anything else falls back to created_at.
const SORTABLE = {
  id: "id",
  name: "name",
  status: "status",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

// IMPORTANT: columns must be table-qualified because the GET / list
// SELECT joins projects p (which also exposes a `name` column); an
// unqualified `name` would trip PG `42702 ambiguous column`.
const SEARCH_COLUMNS = ["c.name"];

function makePlaceholderAllocator(startIndex = 1) {
  let n = startIndex;
  return {
    next: () => `$${n++}`,
    current: () => n - 1,
  };
}

function buildWhereClause(queries, filterType, allocator) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { clauses: [], params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const built = terms.map((term) => {
    const ph = allocator.next();
    const colSql = SEARCH_COLUMNS.map((c) => `${c} ILIKE ${ph}`).join(" OR ");
    return { sql: `(${colSql})`, params: [`%${term}%`] };
  });
  return {
    clauses: built.map((b) => b.sql),
    params: built.flatMap((b) => b.params),
    sql: built.map((b) => b.sql).join(conj),
  };
}

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, id DESC`;
}

function buildProjectFilterClause(projectId, allocator) {
  if (projectId === undefined || projectId === null) {
    return { sql: "", params: [] };
  }
  const n = typeof projectId === "number" ? projectId : parseInt(projectId, 10);
  if (!Number.isFinite(n) || n <= 0) return { sql: "", params: [] };
  return { sql: `c.project_id = ${allocator.next()}`, params: [n] };
}

// Validate POST/PUT body. POST is strict (all required fields must be
// present); PUT (partial=true) only validates provided fields.
function validateConfigBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  // projectId is required on POST, REJECTED on PUT (immutable post-create).
  if (body.projectId !== undefined || body.project_id !== undefined) {
    if (partial) {
      errors.push("projectId cannot be changed");
    } else {
      const v = body.projectId ?? body.project_id;
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push("projectId must be a positive integer");
      } else {
        out.project_id = n;
      }
    }
  } else if (!partial) {
    errors.push("projectId is required");
  }

  // name — free-form human-readable label, 1..200 chars.
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      errors.push("name must be a string");
    } else {
      const trimmed = body.name.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        errors.push("name must be 1..200 chars");
      } else {
        out.name = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("name is required");
  }

  // secret_token is REJECTED on PUT (immutable). On POST it is
  // server-generated and not accepted from the caller.
  if (body.secretToken !== undefined || body.secret_token !== undefined) {
    errors.push("secretToken cannot be set or changed");
  }

  // status
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  } else if (!partial) {
    out.status = "active";
  }

  // allowedOrigins — per-config allowlist.
  if (body.allowedOrigins !== undefined || body.allowed_origins !== undefined) {
    const raw = body.allowedOrigins ?? body.allowed_origins;
    if (!Array.isArray(raw)) {
      errors.push("allowedOrigins must be an array");
    } else if (raw.length > ALLOWED_ORIGINS_MAX) {
      errors.push(`allowedOrigins: maximum ${ALLOWED_ORIGINS_MAX} entries`);
    } else {
      const cleaned = [];
      const seen = new Set();
      for (let i = 0; i < raw.length; i++) {
        const result = validateAllowedOriginsEntry(raw[i], i, seen);
        if (typeof result === "string") {
          errors.push(result);
          continue;
        }
        cleaned.push(result.value);
      }
      if (errors.length === 0) {
        out.allowed_origins = cleaned;
      }
    }
  } else if (!partial) {
    out.allowed_origins = [];
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// Generate the 22-char base64url secret token. 16 random bytes = 128 bits
// of entropy, base64url-encoded to 22 chars (no padding).
function generateSecretToken() {
  return crypto.randomBytes(16).toString("base64url");
}

// ---------------------------------------------------------------------------
// GET /api/analytics — paginated list of analytics_configs
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(
    100,
    Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
  );
  const sortField = req.query.sortField || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  const rawQueries = req.query.queries;
  const queries = Array.isArray(rawQueries)
    ? rawQueries
    : rawQueries
      ? [rawQueries]
      : [];
  const filterType = req.query.filterType === "all" ? "all" : "any";

  const allocator = makePlaceholderAllocator(1);
  const projectFilter = buildProjectFilterClause(
    req.query.projectId ?? req.query.project_id,
    allocator,
  );
  const searchFilter = buildWhereClause(queries, filterType, allocator);

  // Enduser scoping: the user may only see configs on projects they're
  // assigned to. Admins get an empty clause.
  const scopedProjectIds = await getScopedProjectIds(req);
  const enduserScope =
    scopedProjectIds === null || scopedProjectIds === undefined
      ? { sql: "", params: [] }
      : appendProjectScope({
          placeholderIndex: allocator.next(),
          projectIds: scopedProjectIds,
          tableAlias: "c",
        });
  const enduserScopeSql = enduserScope.sql
    ? enduserScope.sql.replace(/^\s*AND\b/i, "")
    : "";

  const allConditions = [projectFilter.sql, searchFilter.sql, enduserScopeSql].filter(Boolean);
  const whereSql =
    allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
  const whereParams = [
    ...projectFilter.params,
    ...searchFilter.params,
    ...enduserScope.params,
  ];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;
  const limitPh = allocator.next();
  const offsetPh = allocator.next();

  try {
    const countSql = `SELECT COUNT(*)::int AS total
                      FROM analytics_configs c
                      JOIN projects p ON p.id = c.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT c.id, c.project_id, p.name AS project_name,
                                  c.name, c.secret_token, c.allowed_origins,
                                  c.status, c.created_at, c.updated_at
                           FROM analytics_configs c
                           JOIN projects p ON p.id = c.project_id
                           ${whereSql}
                           ${order}
                           LIMIT ${limitPh} OFFSET ${offsetPh}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...whereParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToConfigDTO);
    const sorted = !!req.query.sortField;

    return res.json({
      totalPages,
      totalElements,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset,
        sort: { sorted, unsorted: !sorted, empty: false },
      },
      numberOfElements: rows.length,
      size,
      content: rows,
      number: page,
      sort: { sorted, unsorted: !sorted, empty: false },
      first: page === 0,
      last: page === totalPages - 1,
      empty: rows.length === 0,
    });
  } catch (err) {
    console.error("[analytics/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics/by-project/:projectId
// Lazy upsert: returns the existing config for the project, or creates one
// with sensible defaults if none exists. This is the entry point the FE
// uses to fetch the snippet — operators shouldn't have to click through
// a "create analytics" wizard just to get the <script> tag.
// ---------------------------------------------------------------------------
router.get("/by-project/:projectId", async (req, res) => {
  const projectId = parseInt(req.params.projectId, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid project id" });
  }
  // Enduser scope: verify the project is in their list before reading or
  // creating. We return 404 (not 403) so endusers can't probe project ids
  // they're not assigned to.
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Analytics config not found" });
  }
  try {
    // Confirm the project exists. This catches "operator clicked a stale
    // /projects/view/123 link on a deleted project" and gives a clean 404
    // instead of a 23503 FK violation on the upsert.
    const projectCheck = await pool.query(
      `SELECT id, name FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projectCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    const projectName = projectCheck.rows[0].name;
    // Upsert: INSERT ... ON CONFLICT (project_id) DO NOTHING; then re-SELECT.
    // The DO NOTHING + re-SELECT pattern avoids a race where two concurrent
    // requests both try to create a row and one gets 23505 — instead the
    // second one waits on the unique index and then re-reads the existing
    // row. The `RETURNING` branch is the happy path; the empty-rows branch
    // is the "someone else just created it" path.
    const secretToken = generateSecretToken();
    const insertResult = await pool.query(
      `INSERT INTO analytics_configs (project_id, name, secret_token, allowed_origins, status)
       VALUES ($1, $2, $3, '{}', 'active')
       ON CONFLICT (project_id) DO NOTHING
       RETURNING id, project_id, name, secret_token, allowed_origins, status, created_at, updated_at`,
      [projectId, projectName, secretToken],
    );
    let row;
    if (insertResult.rowCount > 0) {
      row = insertResult.rows[0];
    } else {
      const { rows } = await pool.query(
        `SELECT id, project_id, name, secret_token, allowed_origins, status, created_at, updated_at
         FROM analytics_configs WHERE project_id = $1`,
        [projectId],
      );
      row = rows[0];
    }
    // Re-join the project name for DTO shape parity with the list endpoint.
    return res.json({ ...rowToConfigDTO(row), projectName });
  } catch (err) {
    if (err.code === "23505") {
      // Race fallback: another request created the row between our INSERT
      // and the next SELECT. Re-read.
      try {
        const { rows } = await pool.query(
          `SELECT c.id, c.project_id, p.name AS project_name, c.name,
                  c.secret_token, c.allowed_origins, c.status,
                  c.created_at, c.updated_at
           FROM analytics_configs c
           JOIN projects p ON p.id = c.project_id
           WHERE c.project_id = $1`,
          [projectId],
        );
        if (rows.length > 0) return res.json(rowToConfigDTO(rows[0]));
      } catch (e2) {
        console.error("[analytics/by-project] re-read", e2.code, e2.message);
      }
      return res.status(409).json({ errorMessage: "Conflict, please retry" });
    }
    console.error("[analytics/by-project]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics/:id
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Analytics config not found" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.project_id, p.name AS project_name,
              c.name, c.secret_token, c.allowed_origins, c.status,
              c.created_at, c.updated_at
       FROM analytics_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    return res.json(rowToConfigDTO(rows[0]));
  } catch (err) {
    console.error("[analytics/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/analytics/:id
// ---------------------------------------------------------------------------
router.put("/:id", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const validation = validateConfigBody(req.body, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  if (Object.keys(v).length === 0) {
    return res.status(400).json({ errorMessage: "No updatable fields provided" });
  }
  try {
    const setClauses = [];
    const params = [id];
    let p = 2;
    for (const [col, val] of Object.entries(v)) {
      setClauses.push(`${col} = $${p}`);
      params.push(val);
      p++;
    }
    setClauses.push("updated_at = now()");

    const sql = `UPDATE analytics_configs
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id`;
    const { rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    const { rows: joined } = await pool.query(
      `SELECT c.id, c.project_id, p.name AS project_name,
              c.name, c.secret_token, c.allowed_origins, c.status,
              c.created_at, c.updated_at
       FROM analytics_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1`,
      [id],
    );
    return res.json(rowToConfigDTO(joined[0]));
  } catch (err) {
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[analytics/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/analytics/:id
// Hard delete. CASCADE wipes all events for the config too.
// ---------------------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[analytics/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics/:id/snippet
// Returns the generated <script> tag the operator pastes into their
// customer's landing page. The snippet points at APP_PUBLIC_URL (or the
// current request host in dev) so the BE host is baked in at copy time.
// ---------------------------------------------------------------------------
router.get("/:id/snippet", async (req, res) => {
  // Read-only for endusers. We deliberately drop the forbidEnduserMutation
  // guard here so the portal view can render the embed snippet for the
  // operator to copy. Enduser scope is verified via project ownership
  // (see check below).
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  // Enduser scope: 404 (not 403) if the config is on a project the
  // enduser can't see.
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Analytics config not found" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT name, secret_token, allowed_origins FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    const config = rows[0];
    const origin =
      process.env.APP_PUBLIC_URL ||
      `${req.protocol}://${req.headers.host}`;
    // The script is fetched from /api/public/analytics/:secret_token/script.js.
    // The loader itself is INERT on <script> load — it only installs
    // window.analytics.{activate, deactivate, event} and does nothing
    // else until the host page calls activate() after the user consents
    // (GDPR / ePrivacy). The operator pastes the <script> tag; the
    // consent-gate wiring is the host page's responsibility.
    const scriptUrl = `${origin}/api/public/analytics/${config.secret_token}/script.js`;
    const snippet = `<!-- Analytics "${config.name}" -->\n<script async src="${scriptUrl}" data-analytics-token="${config.secret_token}"></script>`;
    return res.json({
      html: snippet,
      scriptUrl,
      secretToken: config.secret_token,
      origin,
      allowedOrigins: Array.isArray(config.allowed_origins)
        ? config.allowed_origins.filter((s) => typeof s === "string")
        : [],
    });
  } catch (err) {
    console.error("[analytics/snippet]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics/:id/stats
// Aggregate stats for the analytics dashboard. All bounded by the
// `?days=` window (1..90, default 30) so the queries stay fast.
//
// Returns:
//   - totals:        pageviews, events, unique visitors, unique sessions
//   - timeSeries:    [{ bucket, pageviews, events, visitors }] — hourly
//                    for windows ≤7d, daily for larger windows
//   - topPaths:      top 10 paths by pageview count
//   - topReferrers:  top 10 referrer hostnames (with "(direct)" for nulls)
//   - topLocales:    top 10 locales (browser language)
//   - devices:       { mobile, tablet, desktop } bucketed by screen width
//   - hourlyHeatmap: 7×24 grid (day-of-week × hour-of-day) of all events
//   - realtime:      pageviews + events over the last 30 minutes (1-min
//                    buckets) for the live "pulse" indicator
//   - recent:        20 most recent events with full context
//
// All queries are bounded by the window. For an MVP analytics module
// this is enough to validate the snippet is working and see rough
// traffic shape. Heavier aggregations (cohorts, retention) should
// land in a later iteration (materialized views, pg_cron rollups).
// ---------------------------------------------------------------------------
router.get("/:id/stats", async (req, res) => {
  // Read-only for endusers (same as /snippet). The enduser scope check
  // below rejects configs on projects they aren't assigned to.
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  // Verify the config exists (and the enduser is allowed to see it).
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Analytics config not found" });
  }
  const days = Math.min(
    90,
    Math.max(1, parseInt(req.query.days ?? "30", 10) || 30),
  );
  try {
    const configCheck = await pool.query(
      `SELECT id FROM analytics_configs WHERE id = $1`,
      [id],
    );
    if (configCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Analytics config not found" });
    }
    // ---------------------------------------------------------------------
    // Fan out the aggregates in parallel. Each query is bounded by the
    // window so total runtime is dominated by the slowest one, not the
    // sum. We intentionally don't wrap in a single multi-CTE statement
    // — pg's planner already does well with separate prepared queries
    // and the per-statement timing makes failures easier to attribute.
    // ---------------------------------------------------------------------
    const [
      totalsResult,
      timeSeriesResult,
      topPathsResult,
      topReferrersResult,
      topLocalesResult,
      devicesResult,
      hourlyHeatmapResult,
      realtimeResult,
      recentResult,
    ] = await Promise.all([
      // Totals
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
           COUNT(*) FILTER (WHERE event_type = 'event')::int AS events,
           COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL)::int AS unique_visitors,
           COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL)::int AS unique_sessions
         FROM analytics_events
         WHERE config_id = $1
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')`,
        [id, days],
      ),
      // Time-series: hourly for ≤7d, daily otherwise. The bucketing
      // branch is decided in JS so we don't have to round-trip the
      // `days` parameter as a SQL CASE.
      pool.query(
        days <= 7
          ? `SELECT
               date_trunc('hour', occurred_at) AS bucket,
               COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
               COUNT(*) FILTER (WHERE event_type = 'event')::int AS events,
               COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL)::int AS visitors
             FROM analytics_events
             WHERE config_id = $1
               AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
             GROUP BY bucket
             ORDER BY bucket ASC`
          : `SELECT
               date_trunc('day', occurred_at) AS bucket,
               COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
               COUNT(*) FILTER (WHERE event_type = 'event')::int AS events,
               COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL)::int AS visitors
             FROM analytics_events
             WHERE config_id = $1
               AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
             GROUP BY bucket
             ORDER BY bucket ASC`,
        [id, days],
      ),
      // Top paths
      pool.query(
        `SELECT path, COUNT(*)::int AS views
         FROM analytics_events
         WHERE config_id = $1
           AND event_type = 'pageview'
           AND path IS NOT NULL
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY path
         ORDER BY views DESC
         LIMIT 10`,
        [id, days],
      ),
      // Top referrers. We parse the URL in SQL to extract the hostname,
      // then strip a leading "www." so www.example.com and example.com
      // collapse together. Null referrers are bucketed as "(direct)".
      pool.query(
        `SELECT
           COALESCE(
             regexp_replace(
               substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'),
               '^www\\.', ''
             ),
             '(direct)'
           ) AS host,
           COUNT(*)::int AS visits
         FROM analytics_events
         WHERE config_id = $1
           AND event_type = 'pageview'
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY host
         ORDER BY visits DESC
         LIMIT 10`,
        [id, days],
      ),
      // Top locales
      pool.query(
        `SELECT
           COALESCE(locale, '(unknown)') AS locale,
           COUNT(*)::int AS visits
         FROM analytics_events
         WHERE config_id = $1
           AND event_type = 'pageview'
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY locale
         ORDER BY visits DESC
         LIMIT 10`,
        [id, days],
      ),
      // Device split. Common breakpoints:
      //   mobile  : screen_width < 768
      //   tablet  : 768..1023
      //   desktop : >= 1024
      // Null screen_width is bucketed as "unknown" so we don't lose
      // counts from older loaders / blocked browsers.
      pool.query(
        `SELECT
           CASE
             WHEN screen_width IS NULL THEN 'unknown'
             WHEN screen_width < 768 THEN 'mobile'
             WHEN screen_width < 1024 THEN 'tablet'
             ELSE 'desktop'
           END AS device,
           COUNT(*)::int AS visits
         FROM analytics_events
         WHERE config_id = $1
           AND event_type = 'pageview'
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY device
         ORDER BY visits DESC`,
        [id, days],
      ),
      // Hourly heatmap (7×24). We return a flat array; the FE pivots
      // to a 2D grid. day_of_week is 0=Sunday..6=Saturday to match
      // JS Date.getDay() so the FE can index without conversion.
      pool.query(
        `SELECT
           EXTRACT(DOW FROM occurred_at)::int AS dow,
           EXTRACT(HOUR FROM occurred_at)::int AS hour,
           COUNT(*)::int AS events
         FROM analytics_events
         WHERE config_id = $1
           AND occurred_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY dow, hour
         ORDER BY dow ASC, hour ASC`,
        [id, days],
      ),
      // Realtime pulse: 1-minute buckets for the last 30 minutes.
      // We materialise the time series even for empty buckets so the
      // FE gets a contiguous x-axis.
      pool.query(
        `WITH bounds AS (
           SELECT generate_series(
             date_trunc('minute', NOW()) - INTERVAL '29 minutes',
             date_trunc('minute', NOW()),
             INTERVAL '1 minute'
           ) AS bucket
         ),
         counts AS (
           SELECT
             date_trunc('minute', occurred_at) AS bucket,
             COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
             COUNT(*) FILTER (WHERE event_type = 'event')::int AS events
           FROM analytics_events
           WHERE config_id = $1
             AND occurred_at >= NOW() - INTERVAL '30 minutes'
           GROUP BY bucket
         )
         SELECT
           b.bucket,
           COALESCE(c.pageviews, 0)::int AS pageviews,
           COALESCE(c.events, 0)::int AS events
         FROM bounds b
         LEFT JOIN counts c ON c.bucket = b.bucket
         ORDER BY b.bucket ASC`,
        [id],
      ),
      // Recent (20 latest, trimmed payload)
      pool.query(
        `SELECT id, event_type, occurred_at, path, referrer, locale, session_id
         FROM analytics_events
         WHERE config_id = $1
         ORDER BY occurred_at DESC
         LIMIT 20`,
        [id],
      ),
    ]);

    // Normalise devices so the response always has the same shape even
    // when one of the buckets has zero hits.
    const deviceMap = new Map(
      devicesResult.rows.map((r) => [r.device, Number(r.visits)]),
    );
    const devices = {
      mobile: deviceMap.get("mobile") || 0,
      tablet: deviceMap.get("tablet") || 0,
      desktop: deviceMap.get("desktop") || 0,
      unknown: deviceMap.get("unknown") || 0,
    };

    // Realtime: also compute the total over the last 30 min as a single
    // number so the FE can show a "live" count without summing.
    const realtimeTotal = realtimeResult.rows.reduce(
      (acc, r) => ({
        pageviews: acc.pageviews + Number(r.pageviews),
        events: acc.events + Number(r.events),
      }),
      { pageviews: 0, events: 0 },
    );

    return res.json({
      days,
      bucket: days <= 7 ? "hour" : "day",
      totals: {
        pageviews: Number(totalsResult.rows[0].pageviews),
        events: Number(totalsResult.rows[0].events),
        uniqueVisitors: Number(totalsResult.rows[0].unique_visitors),
        uniqueSessions: Number(totalsResult.rows[0].unique_sessions),
      },
      timeSeries: timeSeriesResult.rows.map((r) => ({
        bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
        pageviews: Number(r.pageviews),
        events: Number(r.events),
        visitors: Number(r.visitors),
      })),
      topPaths: topPathsResult.rows.map((r) => ({
        path: r.path,
        views: Number(r.views),
      })),
      topReferrers: topReferrersResult.rows.map((r) => ({
        host: r.host,
        visits: Number(r.visits),
      })),
      topLocales: topLocalesResult.rows.map((r) => ({
        locale: r.locale,
        visits: Number(r.visits),
      })),
      devices,
      hourlyHeatmap: hourlyHeatmapResult.rows.map((r) => ({
        dow: Number(r.dow),
        hour: Number(r.hour),
        events: Number(r.events),
      })),
      realtime: {
        total30m: realtimeTotal,
        series: realtimeResult.rows.map((r) => ({
          bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
          pageviews: Number(r.pageviews),
          events: Number(r.events),
        })),
      },
      recent: recentResult.rows.map((r) => ({
        id: Number(r.id),
        eventType: r.event_type,
        occurredAt: r.occurred_at instanceof Date
          ? r.occurred_at.toISOString()
          : r.occurred_at,
        path: r.path,
        referrer: r.referrer,
        locale: r.locale,
        sessionId: r.session_id,
      })),
    });
  } catch (err) {
    console.error("[analytics/stats]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
