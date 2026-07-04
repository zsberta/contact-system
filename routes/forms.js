import express from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

// Admin CRUD for the Forms module. Authoritative source for the schema
// per ADR 0009 (Forms module replaces the legacy embeddable-form module
// that pre-dated ADR 0009 — locked-in 2026-07-03).
//
// Simpler than the legacy embeddable module:
//   - No `kind` (removed — the only purpose is form submission; reservation
//     and tracking use cases are deferred forever)
//   - No `fields` schema (BE is opaque — validates `data` as a bounded bag)
//   - No `consent_required` / `privacy_policy_url` (consent is owned by the FE)
//   - No `custom_css` / `snippet_id` (no iframe, no injected styles)
//
// Kept:
//   - `slug` (human-readable kebab-case label, immutable after create)
//   - `secret_token` (22-char base64url, server-generated, immutable after create,
//     used in public API URLs as the credential)
//   - `allowed_origins` text[] (per-form host-allowlist, empty = no restriction)
//   - `status` text (active/disabled, controlled via code not PG ENUM)
export const router = express.Router();
router.use(requireAuth);

const STATUS_VALUES = new Set(["active", "disabled"]);

// Per-form allowed-origins validator. Semantics:
// bare hostname, bare host+port, wildcard subdomain, scheme-prefixed,
// or loopback (localhost / 127.0.0.1 / [::1]) all accepted.
// The persisted form is always scheme-prefixed so it compares directly
// against `req.headers.origin` (which is always scheme-prefixed).
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

function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

// Snake_case DB row -> camelCase API DTO. `allowed_origins` is a TEXT[]
// so pg may return either an array or a JSON string — handle both.
const rowToFormDTO = (row) => {
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
    slug: row.slug,
    secretToken: row.secret_token,
    allowedOrigins,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

// Whitelist of sortable API fields -> DB columns. Anything else falls back to created_at.
const SORTABLE = {
  id: "id",
  name: "name",
  slug: "slug",
  status: "status",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

// Search across name + slug (ILIKE). Builder combines optional per-token
// wildcards with the chosen filterType ("any" vs "all").
const SEARCH_COLUMNS = ["name", "slug"];

// Shared placeholder allocator. Each clause-builder consumes placeholders
// in order so the resulting SQL's $1, $2, ... match the params slice
// exactly when concatenated with the rest of the query.
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
    // One placeholder per term, reused across every searchable column.
    // `allocator.next()` advances the global counter so the placeholder
    // index matches its position in the params slice the caller collects.
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
  return { sql: `f.project_id = ${allocator.next()}`, params: [n] };
}

// Validate POST/PUT body. POST is strict (all required fields must be
// present); PUT (partial=true) only validates provided fields and
// rejects `projectId` / `secret_token` changes (both are immutable
// post-create — see ADR 0009).
function validateFormBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  // projectId is required on POST, REJECTED on PUT (immutable post-create).
  // We return 400 with a stable message so the FE can show a localised
  // error without polling the schema.
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

  // slug — kebab-case, immutable after create. PUT that tries to change
  // slug will trigger a 23505 unique violation in pg on collision; we
  // map that to a 409 elsewhere. Empty/missing on POST = required; on
  // PUT = leave existing value untouched.
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string") {
      errors.push("slug must be a string");
    } else {
      const trimmed = body.slug.trim();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed) || trimmed.length < 1 || trimmed.length > 50) {
        errors.push("slug must be 1..50 chars, lowercase kebab-case (a-z, 0-9, hyphens)");
      } else {
        out.slug = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("slug is required");
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

  // allowedOrigins — per-form allowlist.
  // POST without the field = empty array (no restriction). PUT (partial)
  // without the field = leave existing value untouched.
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

// ---- GET /api/forms ----
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

  // Single allocator scopes $1, $2, ... across the entire query so the
  // resulting SQL's placeholders always match the params slice positions.
  // projectFilter consumes the first slot (if present), the search
  // builder consumes one slot per term, then LIMIT/OFFSET take the next
  // two slots. buildOrderClause emits only whitelisted column names so
  // it has no params.
  const allocator = makePlaceholderAllocator(1);
  const projectFilter = buildProjectFilterClause(
    req.query.projectId ?? req.query.project_id,
    allocator,
  );
  const searchFilter = buildWhereClause(queries, filterType, allocator);

  const allConditions = [projectFilter.sql, searchFilter.sql].filter(Boolean);
  const whereSql =
    allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
  const whereParams = [
    ...projectFilter.params,
    ...searchFilter.params,
  ];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;
  const limitPh = allocator.next();
  const offsetPh = allocator.next();

  try {
    const countSql = `SELECT COUNT(*)::int AS total
                      FROM forms f
                      JOIN projects p ON p.id = f.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT f.id, f.project_id, p.name AS project_name,
                                  f.name, f.slug, f.secret_token, f.allowed_origins,
                                  f.status, f.created_at, f.updated_at
                           FROM forms f
                           JOIN projects p ON p.id = f.project_id
                           ${whereSql}
                           ${order}
                           LIMIT ${limitPh} OFFSET ${offsetPh}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...whereParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToFormDTO);
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
    console.error("[forms/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/forms/:id ----
router.get("/:id", async (req, res) => {
  const formId = parseInt(req.params.id, 10);
  if (!Number.isFinite(formId) || formId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.project_id, p.name AS project_name,
              f.name, f.slug, f.secret_token, f.allowed_origins,
              f.status, f.created_at, f.updated_at
       FROM forms f
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1`,
      [formId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Form not found" });
    }
    return res.json(rowToFormDTO(rows[0]));
  } catch (err) {
    console.error("[forms/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/forms ----
router.post("/", async (req, res) => {
  const validation = validateFormBody(req.body, { partial: false });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;

  // Fail-fast on missing project (FK violation would bubble up but a
  // clean 404 is much friendlier for the FE error UX).
  try {
    const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [
      v.project_id,
    ]);
    if (proj.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
  } catch (err) {
    console.error("[forms/create] project lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Server-generated secret token. 16 random bytes → 22-char base64url.
  // Cryptographically unpredictable so it can't be guessed if an
  // operator leaks an embed URL.
  const secretToken = crypto.randomBytes(16).toString("base64url");

  try {
    const { rows } = await pool.query(
      `INSERT INTO forms
        (project_id, name, slug, secret_token, allowed_origins, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, name, slug, secret_token,
                 allowed_origins, status,
                 created_at, updated_at`,
      [
        v.project_id,
        v.name,
        v.slug,
        secretToken,
        Array.isArray(v.allowed_origins) ? v.allowed_origins : [],
        v.status ?? "active",
      ],
    );
    // Re-read with the project name joined so the DTO shape is identical
    // to GET /:id. Without the join the row would have project_name=null.
    const { rows: joined } = await pool.query(
      `SELECT f.id, f.project_id, p.name AS project_name,
              f.name, f.slug, f.secret_token, f.allowed_origins,
              f.status, f.created_at, f.updated_at
       FROM forms f
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1`,
      [rows[0].id],
    );
    return res.status(201).json(rowToFormDTO(joined[0]));
  } catch (err) {
    // 23505 = unique_violation. For slug, return 409 with the user-facing
    // message; for secret_token (astronomically rare) we fall through to
    // the 409 generic message.
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("slug")) {
        return res.status(409).json({ errorMessage: "Slug already in use" });
      }
      return res
        .status(409)
        .json({ errorMessage: "Conflict, please retry" });
    }
    // 23514 = check_violation (e.g. CHECK on slug regex fired). This
    // shouldn't reach here because validateFormBody pre-validates the
    // same constraints, but defend against driver/upstream drift.
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[forms/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/forms/:id ----
router.put("/:id", async (req, res) => {
  const formId = parseInt(req.params.id, 10);
  if (!Number.isFinite(formId) || formId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const validation = validateFormBody(req.body, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  if (Object.keys(v).length === 0) {
    return res
      .status(400)
      .json({ errorMessage: "No updatable fields provided" });
  }

  try {
    const setClauses = [];
    const params = [formId];
    let p = 2;
    for (const [col, val] of Object.entries(v)) {
      setClauses.push(`${col} = $${p}`);
      params.push(val);
      p++;
    }
    setClauses.push("updated_at = now()");

    const sql = `UPDATE forms
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id`;
    const { rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Form not found" });
    }
    // Re-fetch with the project name joined for a consistent DTO shape.
    const { rows: joined } = await pool.query(
      `SELECT f.id, f.project_id, p.name AS project_name,
              f.name, f.slug, f.secret_token, f.allowed_origins,
              f.status, f.created_at, f.updated_at
       FROM forms f
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1`,
      [formId],
    );
    return res.json(rowToFormDTO(joined[0]));
  } catch (err) {
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("slug")) {
        return res.status(409).json({ errorMessage: "Slug already in use" });
      }
      return res
        .status(409)
        .json({ errorMessage: "Conflict, please retry" });
    }
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[forms/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/forms/:id ----
// Hard delete. Forms are not financial records and the orchestrator
// decided not to enforce a 409 "has submissions" guard — operators
// can wipe a form along with its submissions via the FK CASCADE.
router.delete("/:id", async (req, res) => {
  const formId = parseInt(req.params.id, 10);
  if (!Number.isFinite(formId) || formId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM forms WHERE id = $1`,
      [formId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Form not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[forms/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/forms/:id/snippet ----
// Returns the rendered HTML snippet the operator pastes into their
// customer's site. Forms have no iframe — the snippet is a single
// <form> tag that POSTs directly to the public endpoint. The token
// is server-known, the slug is a human label. Origin is auto-derived
// from the request when APP_PUBLIC_URL is unset (dev convenience).
router.get("/:id/snippet", async (req, res) => {
  const formId = parseInt(req.params.id, 10);
  if (!Number.isFinite(formId) || formId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT name, slug, secret_token, allowed_origins FROM forms WHERE id = $1`,
      [formId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Form not found" });
    }
    const form = rows[0];
    const origin =
      process.env.APP_PUBLIC_URL ||
      `${req.protocol}://${req.headers.host}`;
    // The snippet is intentionally a self-contained <form> with a
    // single hidden field. Submission is a synchronous POST that 302s
    // back to a static "thanks" page hosted at the same origin. This
    // matches the no-iframe contract from ADR 0009 — the visitor never
    // leaves the host page (the form posts to our endpoint, we set a
    // 201 + Location header).
    const snippet = `<!-- CMS Form "${form.name}" (slug=${form.slug}) -->\n<form action="${origin}/api/public/forms/${form.secret_token}/submissions" method="POST" accept-charset="utf-8" target="_self">\n  <input type="hidden" name="slug" value="${form.slug}" />\n  <!-- Add your fields below (input / textarea / select name="<key>") -->\n</form>`;
    return res.json({
      html: snippet,
      secretToken: form.secret_token,
      slug: form.slug,
      origin,
      allowedOrigins: Array.isArray(form.allowed_origins)
        ? form.allowed_origins.filter((s) => typeof s === "string")
        : [],
    });
  } catch (err) {
    console.error("[forms/snippet]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Submissions — mounted on /api/forms/:id/submissions so the :id param is
// part of the route URL. requireAuth is already inherited from the router
// use() above.
// ---------------------------------------------------------------------------

// Sort whitelist — anything else falls back to submitted_at DESC.
const ALLOWED_SUB_SORT_FIELDS = new Set([
  "submittedAt",
  "ipAddress",
  "locale",
  "createdAt",
]);
const SUB_SORT_COLUMN_MAP = {
  submittedAt: "submitted_at",
  ipAddress: "ip_address",
  locale: "locale",
  createdAt: "created_at",
};

function buildSubmissionsWhere({ queries = [], filterType = "any" }, baseIndex = 2) {
  const terms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = [];
  const params = [];
  for (let i = 0; i < terms.length; i++) {
    const pattern = `%${terms[i].replace(/[%_]/g, (m) => "\\" + m)}%`;
    const pos = baseIndex + i;
    // data::text ILIKE on the validated JSONB blob. locale and ipAddress
    // are also searchable.
    clauses.push(
      "(s.ip_address::text ILIKE $" + pos +
      " OR s.locale ILIKE $" + pos +
      " OR s.data::text ILIKE $" + pos + ")",
    );
    params.push(pattern);
  }
  return {
    sql: " AND (" + clauses.join(conj) + ")",
    params,
  };
}

// ---- GET /api/forms/:id/submissions ----
router.get("/:id/submissions", async (req, res, next) => {
  try {
    const formId = parseInt(req.params.id, 10);
    if (!Number.isFinite(formId) || formId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid form id" });
    }
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
    const size = Math.min(
      100,
      Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
    );
    const sortFieldRaw = req.query.sortField ?? "submittedAt";
    const sortField = typeof sortFieldRaw === "string" ? sortFieldRaw : "submittedAt";
    if (!ALLOWED_SUB_SORT_FIELDS.has(sortField)) {
      return res.status(400).json({ errorMessage: "Invalid sortField" });
    }
    const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";

    const rawQueries = req.query.queries;
    const queries = Array.isArray(rawQueries)
      ? rawQueries
      : rawQueries
        ? [rawQueries]
        : [];
    const filterType = req.query.filterType === "all" ? "all" : "any";

    // Verify the form exists so we 404 instead of returning [].
    const formCheck = await pool.query(
      "SELECT id FROM forms WHERE id = $1",
      [formId],
    );
    if (formCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Form not found" });
    }

    const where = buildSubmissionsWhere({ queries, filterType }, 2);
    const col = SUB_SORT_COLUMN_MAP[sortField] ?? "submitted_at";
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    const orderSql = `ORDER BY ${col} ${dir}, id DESC`;

    const dataParams = [formId, ...where.params, size, page * size];
    const limitParam = dataParams.length - 1;
    const offsetParam = dataParams.length;

    const dataSql = `SELECT id, form_id, submitted_at, ip_address,
                            user_agent, referer, data, locale, created_at
                     FROM form_submissions s
                     WHERE s.form_id = $1${where.sql}
                     ${orderSql}
                     LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, dataParams);

    const countSql = `SELECT COUNT(*)::bigint AS total
                      FROM form_submissions s
                      WHERE s.form_id = $1${where.sql}`;
    const countResult = await pool.query(countSql, [formId, ...where.params]);
    const totalElements = Number(countResult.rows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalElements / size));

    const content = dataResult.rows.map((row) => {
      let data = {};
      if (row.data !== null && row.data !== undefined) {
        if (typeof row.data === "string") {
          try { data = JSON.parse(row.data); } catch { data = {}; }
        } else if (typeof row.data === "object") {
          data = row.data;
        }
      }
      return {
        id: Number(row.id),
        formId: Number(row.form_id),
        submittedAt: row.submitted_at instanceof Date
          ? row.submitted_at.toISOString()
          : row.submitted_at,
        ipAddress: row.ip_address ?? null,
        userAgent: row.user_agent ?? null,
        referer: row.referer ?? null,
        data,
        locale: row.locale ?? null,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      };
    });
    const sorted = !!req.query.sortField;

    return res.json({
      content,
      totalElements,
      totalPages,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset: page * size,
        sort: { sorted, unsorted: !sorted, empty: false },
      },
      numberOfElements: content.length,
      size,
      number: page,
      sort: { sorted, unsorted: !sorted, empty: false },
      first: page === 0,
      last: page >= totalPages - 1,
      empty: content.length === 0,
    });
  } catch (err) {
    console.error("[forms/submissions/list]", err.code, err.message);
    next(err);
  }
});

// ---- GET /api/forms/:id/submissions/:submissionId ----
router.get("/:id/submissions/:submissionId", async (req, res, next) => {
  try {
    const formId = parseInt(req.params.id, 10);
    const submissionId = parseInt(req.params.submissionId, 10);
    if (!Number.isFinite(formId) || formId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid form id" });
    }
    if (!Number.isFinite(submissionId) || submissionId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid submission id" });
    }
    const { rows, rowCount } = await pool.query(
      `SELECT id, form_id, submitted_at, ip_address, user_agent, referer,
              data, locale, created_at
       FROM form_submissions
       WHERE form_id = $1 AND id = $2`,
      [formId, submissionId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Submission not found" });
    }
    const row = rows[0];
    let data = {};
    if (row.data !== null && row.data !== undefined) {
      if (typeof row.data === "string") {
        try { data = JSON.parse(row.data); } catch { data = {}; }
      } else if (typeof row.data === "object") {
        data = row.data;
      }
    }
    return res.json({
      id: Number(row.id),
      formId: Number(row.form_id),
      submittedAt: row.submitted_at instanceof Date
        ? row.submitted_at.toISOString()
        : row.submitted_at,
      ipAddress: row.ip_address ?? null,
      userAgent: row.user_agent ?? null,
      referer: row.referer ?? null,
      data,
      locale: row.locale ?? null,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    });
  } catch (err) {
    console.error("[forms/submissions/get]", err.code, err.message);
    next(err);
  }
});
