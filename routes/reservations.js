// Admin CRUD for the Reservations module.
//
// Mirrors routes/forms.js (ADR 0009) 1:1 for the operator-config columns:
//   - project_id, name, slug, secret_token, allowed_origins, status
//   - paged list with projectId filter, search, sort whitelist
//   - server-generated secret_token at create time, immutable thereafter
//   - slug immutable on PUT (orchestrator decision — same as forms)
//
// Differences from forms (operator-side):
//   - granularity            TEXT CHECK ('day'|'hour'|'minute'), default 'hour'
//   - slot_duration_minutes  INTEGER NULL > 0, restricted to hour/minute
//   - lead_time_minutes      INTEGER NOT NULL >= 0
//   - max_advance_days       INTEGER NOT NULL >= 1
//   - extra_fields_enabled   BOOLEAN NOT NULL DEFAULT false
//
// Submissions are a separate route (handled in routes/reservation-embed.js),
// keyed by reservation_id, with date/time + optional dynamic JSONB.

import express from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();
router.use(requireAuth);

const STATUS_VALUES = new Set(["active", "disabled"]);
const GRANULARITY_VALUES = new Set(["day", "hour", "minute"]);

const ALLOWED_ORIGINS_MAX = 100;
const NAME_MAX = 200;
const SLUG_MAX = 50;
const SLOT_DURATION_MAX_MINUTES = 24 * 60; // 1 day cap
const LEAD_TIME_MAX_MINUTES = 30 * 24 * 60; // 30 days cap (anything beyond is silly)
const MAX_ADVANCE_DAYS_MAX = 365; // 1 year cap

// Origin validation regexes — copied verbatim from routes/forms.js so the
// Forms + Reservations operator UX surface is identical.
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

const NON_NEG_INT_RE = /^(0|[1-9][0-9]*)$/;
const POS_INT_RE = /^[1-9][0-9]*$/;

function parseStrictInt(raw, { min, max } = {}) {
  if (typeof raw !== "string" || !NON_NEG_INT_RE.test(raw)) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

// Snake_case DB row → camelCase API DTO. `allowed_origins` is a TEXT[]
// so pg may return either an array or a JSON string — handle both.
const rowToReservationDTO = (row) => {
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
    granularity: row.granularity,
    slotDurationMinutes: row.slot_duration_minutes === null || row.slot_duration_minutes === undefined
      ? null
      : Number(row.slot_duration_minutes),
    leadTimeMinutes: Number(row.lead_time_minutes),
    maxAdvanceDays: Number(row.max_advance_days),
    extraFieldsEnabled: !!row.extra_fields_enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

const SORTABLE = {
  id: "id",
  name: "name",
  slug: "slug",
  status: "status",
  granularity: "granularity",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

// IMPORTANT: columns must be table-qualified because the GET /:list
// SELECT joins projects p (which also exposes a `name` column); an
// unqualified `name` would trip PG `42702 ambiguous column`. Fix: see
// git history and sessions/2026-07-04-reservation-api-curl-tests.
const SEARCH_COLUMNS = ["r.name", "r.slug"];

function makePlaceholderAllocator(startIndex = 1) {
  let n = startIndex;
  return {
    next: () => `$${n++}`,
    current: () => n - 1,
  };
}

function buildWhereClause(queries, filterType, allocator) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const built = terms.map((term) => {
    const ph = allocator.next();
    const colSql = SEARCH_COLUMNS.map((c) => `${c} ILIKE ${ph}`).join(" OR ");
    return { sql: `(${colSql})`, params: [`%${term}%`] };
  });
  return {
    sql: built.map((b) => b.sql).join(conj),
    params: built.flatMap((b) => b.params),
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
  return { sql: `r.project_id = ${allocator.next()}`, params: [n] };
}

// Validate POST/PUT body. POST is strict (all required fields must be
// present); PUT (partial=true) only validates provided fields and
// rejects `projectId` / `secret_token` changes (both immutable post-create,
// mirroring ADR 0009's forms contract).
function validateReservationBody(body, { partial = false } = {}) {
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
      if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
        errors.push(`name must be 1..${NAME_MAX} chars`);
      } else {
        out.name = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("name is required");
  }

  // slug — kebab-case, immutable on PUT (orchestrator chose strict lock).
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string") {
      errors.push("slug must be a string");
    } else {
      const trimmed = body.slug.trim();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed) || trimmed.length < 1 || trimmed.length > SLUG_MAX) {
        errors.push(`slug must be 1..${SLUG_MAX} chars, lowercase kebab-case (a-z, 0-9, hyphens)`);
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

  // allowedOrigins — per-reservation allowlist.
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

  // granularity — required on POST, optional on PUT.
  if (body.granularity !== undefined) {
    if (typeof body.granularity !== "string" || !GRANULARITY_VALUES.has(body.granularity)) {
      errors.push(`granularity must be one of ${[...GRANULARITY_VALUES].join(", ")}`);
    } else {
      out.granularity = body.granularity;
    }
  } else if (!partial) {
    out.granularity = "hour";
  }

  // slotDurationMinutes — optional. Must be null or a positive integer ≤ 1440.
  // If granularity is 'day', the BE-level CHECK rejects non-null anyway,
  // and we pre-validate here with a friendly message.
  if (body.slotDurationMinutes !== undefined && body.slotDurationMinutes !== null) {
    const raw = typeof body.slotDurationMinutes === "number"
      ? String(body.slotDurationMinutes)
      : body.slotDurationMinutes;
    const n = parseStrictInt(raw, { min: 1, max: SLOT_DURATION_MAX_MINUTES });
    if (n === null) {
      errors.push(`slotDurationMinutes must be a positive integer (1..${SLOT_DURATION_MAX_MINUTES})`);
    } else {
      out.slot_duration_minutes = n;
    }
  } else if (body.slotDurationMinutes === null) {
    out.slot_duration_minutes = null;
  }

  // leadTimeMinutes — required ≥ 0.
  if (body.leadTimeMinutes !== undefined) {
    const raw = typeof body.leadTimeMinutes === "number"
      ? String(body.leadTimeMinutes)
      : body.leadTimeMinutes;
    const n = parseStrictInt(raw, { min: 0, max: LEAD_TIME_MAX_MINUTES });
    if (n === null) {
      errors.push(`leadTimeMinutes must be an integer 0..${LEAD_TIME_MAX_MINUTES}`);
    } else {
      out.lead_time_minutes = n;
    }
  } else if (!partial) {
    out.lead_time_minutes = 60;
  }

  // maxAdvanceDays — required ≥ 1.
  if (body.maxAdvanceDays !== undefined) {
    const raw = typeof body.maxAdvanceDays === "number"
      ? String(body.maxAdvanceDays)
      : body.maxAdvanceDays;
    const n = parseStrictInt(raw, { min: 1, max: MAX_ADVANCE_DAYS_MAX });
    if (n === null) {
      errors.push(`maxAdvanceDays must be an integer 1..${MAX_ADVANCE_DAYS_MAX}`);
    } else {
      out.max_advance_days = n;
    }
  } else if (!partial) {
    out.max_advance_days = 90;
  }

  // extraFieldsEnabled — boolean.
  if (body.extraFieldsEnabled !== undefined) {
    if (typeof body.extraFieldsEnabled !== "boolean") {
      errors.push("extraFieldsEnabled must be a boolean");
    } else {
      out.extra_fields_enabled = body.extraFieldsEnabled;
    }
  } else if (!partial) {
    out.extra_fields_enabled = false;
  }

  // Cross-field: slot_duration_minutes only meaningful for hour/minute granularity.
  // We reject explicitly to give a friendly message; the DB CHECK is the
  // authoritative guard.
  const slotDefined = Object.prototype.hasOwnProperty.call(out, "slot_duration_minutes");
  if (slotDefined && out.slot_duration_minutes !== null && out.slot_duration_minutes !== undefined) {
    // Resolve the effective granularity. For PUT, the operator may have
    // omitted it — if so we don't reject (existing DB granularity could
    // be 'day'). For POST, granularity is always present.
    const effGranularity = out.granularity; // undefined means PUT omitted granularity
    if (effGranularity && effGranularity === "day") {
      errors.push("slotDurationMinutes must be null when granularity is 'day'");
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// ---- GET /api/reservations ----
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
                      FROM reservations r
                      JOIN projects p ON p.id = r.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT r.id, r.project_id, p.name AS project_name,
                                  r.name, r.slug, r.secret_token, r.allowed_origins,
                                  r.status, r.granularity, r.slot_duration_minutes,
                                  r.lead_time_minutes, r.max_advance_days,
                                  r.extra_fields_enabled,
                                  r.created_at, r.updated_at
                           FROM reservations r
                           JOIN projects p ON p.id = r.project_id
                           ${whereSql}
                           ${order}
                           LIMIT ${limitPh} OFFSET ${offsetPh}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...whereParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToReservationDTO);
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
    console.error("[reservations/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/reservations/:id ----
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name,
              r.name, r.slug, r.secret_token, r.allowed_origins,
              r.status, r.granularity, r.slot_duration_minutes,
              r.lead_time_minutes, r.max_advance_days,
              r.extra_fields_enabled,
              r.created_at, r.updated_at
       FROM reservations r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    return res.json(rowToReservationDTO(rows[0]));
  } catch (err) {
    console.error("[reservations/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/reservations ----
router.post("/", async (req, res) => {
  const validation = validateReservationBody(req.body, { partial: false });
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
    console.error("[reservations/create] project lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Server-generated secret token. 16 random bytes → 22-char base64url.
  // Cryptographically unpredictable so it can't be guessed if an
  // operator leaks an embed URL.
  const secretToken = crypto.randomBytes(16).toString("base64url");

  try {
    const insertResult = await pool.query(
      `INSERT INTO reservations
        (project_id, name, slug, secret_token, allowed_origins, status,
         granularity, slot_duration_minutes, lead_time_minutes, max_advance_days,
         extra_fields_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        v.project_id,
        v.name,
        v.slug,
        secretToken,
        Array.isArray(v.allowed_origins) ? v.allowed_origins : [],
        v.status ?? "active",
        v.granularity ?? "hour",
        v.slot_duration_minutes ?? null,
        v.lead_time_minutes ?? 60,
        v.max_advance_days ?? 90,
        !!v.extra_fields_enabled,
      ],
    );
    const newId = Number(insertResult.rows[0].id);
    // Re-read with the project name joined so the DTO shape is identical
    // to GET /:id. Without the join the row would have project_name=null.
    const { rows: joined } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name,
              r.name, r.slug, r.secret_token, r.allowed_origins,
              r.status, r.granularity, r.slot_duration_minutes,
              r.lead_time_minutes, r.max_advance_days,
              r.extra_fields_enabled,
              r.created_at, r.updated_at
       FROM reservations r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1`,
      [newId],
    );
    return res.status(201).json(rowToReservationDTO(joined[0]));
  } catch (err) {
    // 23505 = unique_violation. For slug, return 409 with the user-facing
    // message; for secret_token (astronomically rare) we fall through to
    // the 409 generic message.
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("slug")) {
        return res.status(409).json({ errorMessage: "Slug already in use" });
      }
      return res.status(409).json({ errorMessage: "Conflict, please retry" });
    }
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[reservations/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/reservations/:id ----
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const validation = validateReservationBody(req.body, { partial: true });
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

    const sql = `UPDATE reservations
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id`;
    const { rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    const { rows: joined } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name,
              r.name, r.slug, r.secret_token, r.allowed_origins,
              r.status, r.granularity, r.slot_duration_minutes,
              r.lead_time_minutes, r.max_advance_days,
              r.extra_fields_enabled,
              r.created_at, r.updated_at
       FROM reservations r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1`,
      [id],
    );
    return res.json(rowToReservationDTO(joined[0]));
  } catch (err) {
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("slug")) {
        return res.status(409).json({ errorMessage: "Slug already in use" });
      }
      return res.status(409).json({ errorMessage: "Conflict, please retry" });
    }
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[reservations/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/reservations/:id ----
// Hard delete. Reservations are not financial records and the orchestrator
// decided not to enforce a 409 "has bookings" guard — operators can wipe a
// reservation along with its bookings via the FK CASCADE.
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM reservations WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[reservations/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/reservations/:id/snippet ----
// Returns the rendered HTML snippet + the availability URL the landing
// page can call to fetch already-booked ranges. Mirrors forms' snippet
// response shape so the FE only needs one snippet-component template.
router.get("/:id/snippet", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT name, slug, secret_token, granularity, slot_duration_minutes,
              lead_time_minutes, max_advance_days, allowed_origins
       FROM reservations WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    const r = rows[0];
    const origin =
      process.env.APP_PUBLIC_URL ||
      `${req.protocol}://${req.headers.host}`;
    // The snippet is a self-contained <form> tag that POSTs directly to the
    // public endpoint, plus a separate GET availability endpoint the FE
    // hits to render greyed-out slots before the visitor submits.
    const snippet = `<!-- CMS Reservation "${r.name}" (slug=${r.slug}) -->
<form id="cms-reservation-${r.slug}"
      action="${origin}/api/public/reservations/${r.secret_token}/bookings"
      method="POST"
      accept-charset="utf-8"
      target="_self"
      data-granularity="${r.granularity}"
      ${r.slot_duration_minutes !== null ? `data-slot-duration-minutes="${r.slot_duration_minutes}" ` : ""}data-availability-endpoint="${origin}/api/public/reservations/${r.secret_token}/availability">
  <!-- Required hidden fields: startsAt and endsAt in ISO 8601 UTC.
       GET the availability endpoint (see data-availability-endpoint) and
       grey-out already-booked ranges client-side before submitting. -->
</form>`;
    return res.json({
      html: snippet,
      secretToken: r.secret_token,
      slug: r.slug,
      origin,
      granularity: r.granularity,
      slotDurationMinutes: r.slot_duration_minutes === null || r.slot_duration_minutes === undefined
        ? null
        : Number(r.slot_duration_minutes),
      leadTimeMinutes: Number(r.lead_time_minutes),
      maxAdvanceDays: Number(r.max_advance_days),
      availabilityEndpoint: `${origin}/api/public/reservations/${r.secret_token}/availability`,
      submissionEndpoint: `${origin}/api/public/reservations/${r.secret_token}/bookings`,
      allowedOrigins: Array.isArray(r.allowed_origins)
        ? r.allowed_origins.filter((s) => typeof s === "string")
        : [],
    });
  } catch (err) {
    console.error("[reservations/snippet]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Bookings (admin)
//
// Mounted on /api/reservations/:id/bookings so the :id param is part of
// the route URL. requireAuth is already inherited from the router use()
// above. We add a route in the SAME router because it doesn't need a
// different mount (admins must be authenticated; no public alias).
// ---------------------------------------------------------------------------

const ALLOWED_BOOKING_SORT_FIELDS = new Set([
  "startsAt",
  "endsAt",
  "bookedAt",
  "ipAddress",
  "locale",
]);
const BOOKING_SORT_COLUMN_MAP = {
  startsAt: "starts_at",
  endsAt: "ends_at",
  bookedAt: "booked_at",
  ipAddress: "ip_address",
  locale: "locale",
};

function buildBookingsWhere({ queries = [], filterType = "any" }, baseIndex = 2) {
  const terms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = [];
  const params = [];
  for (let i = 0; i < terms.length; i++) {
    const pattern = `%${terms[i].replace(/[%_]/g, (m) => "\\" + m)}%`;
    const pos = baseIndex + i;
    // data::text ILIKE on the validated JSONB blob (only meaningful when
    // extra_fields_enabled on the reservation). locale and ipAddress are
    // also searchable.
    clauses.push(
      "(b.ip_address::text ILIKE $" + pos +
      " OR b.locale ILIKE $" + pos +
      " OR b.data::text ILIKE $" + pos + ")",
    );
    params.push(pattern);
  }
  return {
    sql: " AND (" + clauses.join(conj) + ")",
    params,
  };
}

// Snake_case booking row → camelCase DTO.
const rowToBookingDTO = (row) => {
  let data = null;
  if (row.data !== null && row.data !== undefined) {
    if (typeof row.data === "string") {
      try { data = JSON.parse(row.data); } catch { data = null; }
    } else if (typeof row.data === "object") {
      data = row.data;
    }
  }
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    startsAt: row.starts_at instanceof Date
      ? row.starts_at.toISOString()
      : row.starts_at,
    endsAt: row.ends_at instanceof Date
      ? row.ends_at.toISOString()
      : row.ends_at,
    bookedAt: row.booked_at instanceof Date
      ? row.booked_at.toISOString()
      : row.booked_at,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    referer: row.referer ?? null,
    locale: row.locale ?? null,
    data,
  };
};

// ---- GET /api/reservations/:id/bookings ----
router.get("/:id/bookings", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
    const size = Math.min(
      100,
      Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
    );
    const sortFieldRaw = req.query.sortField ?? "bookedAt";
    const sortField = typeof sortFieldRaw === "string" ? sortFieldRaw : "bookedAt";
    if (!ALLOWED_BOOKING_SORT_FIELDS.has(sortField)) {
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

    // Verify the reservation exists so we 404 instead of returning [].
    const reservationCheck = await pool.query(
      "SELECT id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }

    const where = buildBookingsWhere({ queries, filterType }, 2);
    const col = BOOKING_SORT_COLUMN_MAP[sortField] ?? "booked_at";
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    const orderSql = `ORDER BY ${col} ${dir}, id DESC`;

    const dataParams = [reservationId, ...where.params, size, page * size];
    const limitParam = dataParams.length - 1;
    const offsetParam = dataParams.length;

    const dataSql = `SELECT id, reservation_id, starts_at, ends_at, booked_at,
                            ip_address, user_agent, referer, data, locale
                     FROM reservation_bookings b
                     WHERE b.reservation_id = $1${where.sql}
                     ${orderSql}
                     LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, dataParams);

    const countSql = `SELECT COUNT(*)::bigint AS total
                      FROM reservation_bookings b
                      WHERE b.reservation_id = $1${where.sql}`;
    const countResult = await pool.query(countSql, [reservationId, ...where.params]);
    const totalElements = Number(countResult.rows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalElements / size));

    const content = dataResult.rows.map(rowToBookingDTO);
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
    console.error("[reservations/bookings/list]", err.code, err.message);
    next(err);
  }
});

// ---- GET /api/reservations/:id/bookings/:bookingId ----
router.get("/:id/bookings/:bookingId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const bookingId = parseInt(req.params.bookingId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid booking id" });
    }
    const { rows, rowCount } = await pool.query(
      `SELECT id, reservation_id, starts_at, ends_at, booked_at,
              ip_address, user_agent, referer, data, locale
       FROM reservation_bookings
       WHERE reservation_id = $1 AND id = $2`,
      [reservationId, bookingId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Booking not found" });
    }
    return res.json(rowToBookingDTO(rows[0]));
  } catch (err) {
    console.error("[reservations/bookings/get]", err.code, err.message);
    next(err);
  }
});
