import express from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";

export const router = express.Router();

// All routes require a valid JWT — CSRF is enforced globally for non-GET elsewhere.
// We declare requireAuth on each handler (mirrors the users route pattern) to make
// the contract obvious at the call site.
const UPLOAD_ROOT = process.env.UPLOADS_DIR || "/app/uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// Read-only for endusers. The CRUD verbs refuse if the requester is an
// enduser. Scoping is applied to every read query.
const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduserMutation = (req, res) => {
  if (isEnduser(req)) {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  return null;
};

// Whitelist of sniffed mime types we accept. We deliberately do NOT trust the
// client's Content-Type header — file-type sniffs the first ~4KB of the buffer.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const STATUS_VALUES = new Set([
  "under_construction",
  "customer_paid",
  "waiting_for_payment",
  "notified_customer",
  "have_to_notify",
  "paid",
  "cancelled",
  "completed",
]);
const PERIOD_VALUES = new Set(["monthly", "yearly", "one_off"]);

// Whitelist of sortable API fields -> DB columns. Anything else falls back to created_at.
const SORTABLE = {
  id: "id",
  name: "name",
  status: "status",
  customerName: "customer_name",
  price: "price",
  fordulonap: "fordulonap",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

// Snake_case DB column -> camelCase API field. Timestamps normalised to ISO.
function rowToProjectDTO(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    domainAddress: row.domain_address,
    // pg returns NUMERIC as string to preserve precision — coerce to number for the API.
    price: row.price == null ? null : Number(row.price),
    fordulonap: row.fordulonap,
    billingPeriod: row.billing_period,
    status: row.status,
    comment: row.comment,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastStatusChangeAt: new Date(row.last_status_change_at).toISOString(),
  };
}

function rowToAttachmentDTO(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    uploadedAt: new Date(row.uploaded_at).toISOString(),
  };
}

// Build WHERE clause from queries[] + filterType. Mirrors the users route:
// each term matches against the whitelisted search columns (ILIKE), combined
// per filterType ("any" = OR, "all" = AND).
const SEARCH_COLUMNS = [
  "name",
  "domain_address",
  "customer_name",
  "customer_email",
  "comment",
];
function buildWhereClause(queries, filterType) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  // One placeholder per term, reused across every searchable column.
  // Mirrors the pattern in routes/reservations.js so the param count
  // matches the bound params exactly (prevents pg 08P01 "bind message
  // supplies N parameters, but prepared statement requires M").
  let n = 1;
  const clauses = terms.map((term) => {
    const ph = `$${n++}`;
    const colSql = SEARCH_COLUMNS.map((c) => `${c} ILIKE ${ph}`).join(" OR ");
    return { sql: `(${colSql})`, params: [`%${term}%`] };
  });
  return {
    sql: `WHERE ${clauses.map((c) => c.sql).join(conj)}`,
    params: clauses.flatMap((c) => c.params),
  };
}

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  // Tie-breaker on id so pagination is deterministic when many rows share a value.
  return `ORDER BY ${col} ${dir}, id DESC`;
}

// Normalize empty / whitespace-only strings to null. Optional string fields
// accept both explicit null and "" — and to stay forgiving with callers that
// send e.g. "   " we trim and treat empty as null. Non-strings pass through
// unchanged so the existing type-check below can reject them with a clear
// error message.
function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

// "Looks like an email" — one @, with non-whitespace text on both sides and a
// dot in the domain. Deliberately not strict RFC 5322; we only need to reject
// obvious garbage, not validate every legal edge case.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Validation helpers for fordulonap ----

// monthly: "DD", 1..28 (capped to avoid month-length ambiguity).
function validateMonthly(value) {
  if (typeof value !== "string" || !/^(0?[1-9]|[12]\d|3[01])$/.test(value)) {
    return { ok: false, error: "monthly fordulonap must be a day number 1..28" };
  }
  const day = parseInt(value, 10);
  if (day < 1 || day > 28) {
    return { ok: false, error: "monthly fordulonap must be 1..28" };
  }
  return { ok: true, normalized: String(day) };
}

// yearly: "MM-DD". Accept both "MM-DD" and the full ISO date the UI sends; we
// normalise to "MM-DD" on the way in.
function validateYearly(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "yearly fordulonap must be a string" };
  }
  // Direct MM-DD form.
  const md = /^(\d{2})-(\d{2})$/.exec(value);
  if (md) {
    const mm = +md[1];
    const dd = +md[2];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return { ok: false, error: "yearly fordulonap has invalid month/day" };
    }
    return { ok: true, normalized: value };
  }
  // ISO date form from the UI: extract MM-DD.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    return { ok: true, normalized: `${iso[2]}-${iso[3]}` };
  }
  return { ok: false, error: "yearly fordulonap must be MM-DD or YYYY-MM-DD" };
}

// one_off: "YYYY-MM-DD", must be a valid calendar date.
function validateOneOff(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, error: "one_off fordulonap must be YYYY-MM-DD" };
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: "one_off fordulonap is not a valid date" };
  }
  // Round-trip check — rejects e.g. "2024-02-31" which Date silently rolls forward.
  const iso = d.toISOString().slice(0, 10);
  if (iso !== value) {
    return { ok: false, error: "one_off fordulonap is not a valid calendar date" };
  }
  return { ok: true, normalized: value };
}

function validateFordulonap(value, period) {
  if (value === null || value === undefined || value === "") {
    // Both fields are optional in the spec; cron simply skips projects without them.
    return { ok: true, normalized: null };
  }
  if (period === "monthly") return validateMonthly(value);
  if (period === "yearly") return validateYearly(value);
  if (period === "one_off") return validateOneOff(value);
  return { ok: false, error: "invalid billing_period" };
}

// Validate POST/PUT body. Returns { ok, value } on success, { ok: false, error }
// otherwise. Accepts partial payloads for PUT (only validate provided fields).
function validateProjectBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200) {
      errors.push("name must be a string 1..200 chars");
    } else {
      out.name = body.name;
    }
  } else if (!partial) {
    errors.push("name is required");
  }

  if (body.domainAddress !== undefined || body.domain_address !== undefined) {
    const v = emptyToNull(body.domainAddress ?? body.domain_address);
    if (v === null) {
      out.domain_address = null; // explicitly allowed
    } else if (typeof v !== "string" || v.length > 500) {
      errors.push("domainAddress must be a string up to 500 chars or null");
    } else {
      out.domain_address = v;
    }
  }

  if (body.price !== undefined) {
    const v = body.price;
    if (v === null || v === "") {
      out.price = null;
    } else {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        errors.push("price must be a non-negative number or null");
      } else {
        out.price = n;
      }
    }
  }

  if (body.billingPeriod !== undefined || body.billing_period !== undefined) {
    const v = emptyToNull(body.billingPeriod ?? body.billing_period);
    if (v === null) {
      out.billing_period = null; // explicitly allowed ("no billing")
    } else if (typeof v !== "string" || !PERIOD_VALUES.has(v)) {
      errors.push(`billingPeriod must be one of ${[...PERIOD_VALUES].join(", ")} or null`);
    } else {
      out.billing_period = v;
    }
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  }

  if (body.comment !== undefined) {
    const v = emptyToNull(body.comment);
    if (v === null) {
      out.comment = null; // explicitly allowed
    } else if (typeof v !== "string") {
      errors.push("comment must be a string or null");
    } else {
      out.comment = v;
    }
  }

  if (body.customerName !== undefined || body.customer_name !== undefined) {
    const v = emptyToNull(body.customerName ?? body.customer_name);
    if (v === null) {
      out.customer_name = null; // explicitly allowed
    } else if (typeof v !== "string" || v.length > 200) {
      errors.push("customerName must be a string up to 200 chars or null");
    } else {
      out.customer_name = v;
    }
  }

  if (body.customerPhone !== undefined || body.customer_phone !== undefined) {
    const v = emptyToNull(body.customerPhone ?? body.customer_phone);
    if (v === null) {
      out.customer_phone = null; // explicitly allowed
    } else if (typeof v !== "string" || v.length > 50) {
      errors.push("customerPhone must be a string up to 50 chars or null");
    } else {
      out.customer_phone = v;
    }
  }

  if (body.customerEmail !== undefined || body.customer_email !== undefined) {
    const v = emptyToNull(body.customerEmail ?? body.customer_email);
    if (v === null) {
      out.customer_email = null; // explicitly allowed
    } else if (typeof v !== "string" || v.length > 255 || !EMAIL_RE.test(v)) {
      errors.push("customerEmail must be a valid email or null");
    } else {
      // Normalise to lowercase so the wire format is consistent even though
      // the DB column (CITEXT) is already case-insensitive on lookup.
      out.customer_email = v.toLowerCase();
    }
  }

  // fordulonap is validated against billing_period (period-dependent encoding).
  // For PUT we accept partial: if either is provided, re-check the combination.
  if (body.fordulonap !== undefined) {
    const period = out.billing_period !== undefined ? out.billing_period : undefined;
    // For partial updates we can't fully validate fordulonap unless billing_period
    // is also in the payload — in that case we just stash the raw value and let
    // the DB constraint reject obviously bad input. The cron code is defensive
    // against malformed strings regardless.
    if (period !== undefined) {
      const v = validateFordulonap(body.fordulonap, period);
      if (!v.ok) errors.push(v.error);
      else out.fordulonap = v.normalized;
    } else {
      // Trust the caller; cron tolerates anything that doesn't parse.
      if (body.fordulonap !== null && typeof body.fordulonap !== "string") {
        errors.push("fordulonap must be a string or null");
      } else {
        out.fordulonap = body.fordulonap;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// Multer error handler for the upload route. Translates known errors into the
// project's standard { errorMessage } shape.
function handleMulterError(err, _req, res, next) {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ errorMessage: "File too large" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ errorMessage: err.message });
  }
  return next(err);
}

// ---- GET /api/projects ----
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? "10", 10) || 10));
  const sortField = req.query.sortField || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  const rawQueries = req.query.queries;
  const queries = Array.isArray(rawQueries)
    ? rawQueries
    : rawQueries
      ? [rawQueries]
      : [];
  const filterType = req.query.filterType === "all" ? "all" : "any";

  const where = buildWhereClause(queries, filterType);
  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;

  // Enduser scoping: limit to the user's assigned projects. The list of
  // ids comes from the JWT (no DB roundtrip) and is bound as a single
  // bigint[] parameter via appendProjectScope. The helper returns
  // " AND <col> = ANY($N::bigint[])" for endusers, or "" for admins.
  // On the projects table the scoping column is "id" (the projects
  // table doesn't have a project_id column).
  const scopedProjectIds = await getScopedProjectIds(req);
  const scope = appendProjectScope({
    placeholderIndex: where.params.length + 1,
    projectIds: scopedProjectIds,
    tableAlias: null,
    column: "id",
  });
  // appendProjectScope returns " AND ..." — we keep both forms available
  // so the composer below can chain it as " AND ..." (with the search
  // WHERE) or as a standalone "WHERE ..." (without one).
  // Compose the final WHERE: when both are empty, the result is "";
  // when only scope is present, the leading " AND " is stripped and we
  // prepend WHERE. When search is present, scope chains with it via the
  // leading " AND ".
  let composedWhere = "";
  if (where.sql && scope.sql) {
    composedWhere = `${where.sql}${scope.sql}`;
  } else if (where.sql) {
    composedWhere = where.sql;
  } else if (scope.sql) {
    composedWhere = `WHERE ${scope.sql.replace(/^\s*AND\b/i, "")}`;
  }
  const composedParams = [...where.params, ...scope.params];

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM projects ${composedWhere}`;
    const countResult = await pool.query(countSql, composedParams);
    const totalElements = countResult.rows[0].total;

    const baseParamCount = composedParams.length;
    const limitParam = baseParamCount + 1;
    const offsetParam = baseParamCount + 2;
    const dataSqlFinal = `SELECT id, name, domain_address, price, fordulonap,
                                 billing_period, status, comment, customer_name,
                                 customer_phone, customer_email, created_at,
                                 updated_at, last_status_change_at
                          FROM projects
                          ${composedWhere}
                          ${order}
                          LIMIT $${limitParam} OFFSET $${offsetParam}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...composedParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToProjectDTO);
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
    console.error("[projects/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/projects/:id ----
router.get("/:id", requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  // Enduser scope: refuse upfront if the project is not in the user's
  // assignment set. The 404 is fine here — it doesn't reveal whether
  // the project exists for someone else.
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, domain_address, price, fordulonap, billing_period,
              status, comment, customer_name, customer_phone, customer_email,
              created_at, updated_at, last_status_change_at
       FROM projects WHERE id = $1`,
      [projectId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    return res.json(rowToProjectDTO(rows[0]));
  } catch (err) {
    console.error("[projects/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/projects ----
router.post("/", requireAuth, async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const validation = validateProjectBody(req.body, { partial: false });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  // Default status if not provided — DB also defaults but being explicit avoids a round-trip.
  if (!v.status) v.status = "under_construction";

  try {
    const { rows } = await pool.query(
      `INSERT INTO projects
        (name, domain_address, price, fordulonap, billing_period,
         status, comment, customer_name, customer_phone, customer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, name, domain_address, price, fordulonap, billing_period,
                 status, comment, customer_name, customer_phone, customer_email,
                 created_at, updated_at, last_status_change_at`,
      [
        v.name,
        v.domain_address ?? null,
        v.price ?? null,
        v.fordulonap ?? null,
        v.billing_period ?? null,
        v.status,
        v.comment ?? null,
        v.customer_name ?? null,
        v.customer_phone ?? null,
        v.customer_email ?? null,
      ],
    );
    return res.status(201).json(rowToProjectDTO(rows[0]));
  } catch (err) {
    // 22P02 = invalid_text_representation (e.g. enum mismatch).
    if (err.code === "22P02") {
      return res.status(400).json({ errorMessage: "Invalid enum value" });
    }
    console.error("[projects/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/projects/:id ----
router.put("/:id", requireAuth, async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const validation = validateProjectBody(req.body, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  if (Object.keys(v).length === 0) {
    return res.status(400).json({ errorMessage: "No updatable fields provided" });
  }

  // When fordulonap changes we also bump last_status_change_at only if status is
  // being changed in the same payload — keep this simple and predictable.
  const bumpLastStatus = v.status !== undefined;

  try {
    // Dynamic SET — only update fields the caller actually provided.
    const setClauses = [];
    const params = [projectId];
    let p = 2;
    for (const [col, val] of Object.entries(v)) {
      setClauses.push(`${col} = $${p}`);
      params.push(val);
      p++;
    }
    setClauses.push("updated_at = now()");
    if (bumpLastStatus) {
      setClauses.push("last_status_change_at = now()");
    }

    const sql = `UPDATE projects
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id, name, domain_address, price, fordulonap,
                           billing_period, status, comment, customer_name,
                           customer_phone, customer_email, created_at,
                           updated_at, last_status_change_at`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    return res.json(rowToProjectDTO(rows[0]));
  } catch (err) {
    if (err.code === "22P02") {
      return res.status(400).json({ errorMessage: "Invalid enum value" });
    }
    console.error("[projects/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/projects/:id ----
router.delete("/:id", requireAuth, async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    // Best-effort disk cleanup. We do this AFTER the DB delete so the FK
    // cascade has already removed the attachment rows. A failure here must not
    // surface to the caller — the project is gone. Log and move on.
    try {
      await fsp.rm(path.join(UPLOAD_ROOT, "projects", String(projectId)), {
        recursive: true,
        force: true,
      });
    } catch (fsErr) {
      console.error(
        "[projects/delete] failed to remove upload dir",
        projectId,
        fsErr.message,
      );
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[projects/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/projects/:id/attachments ----
router.get("/:id/attachments", requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Project not found" });
  }
  try {
    // Verify the project exists so we can return a clean 404 instead of [].
    const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId]);
    if (proj.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    const { rows } = await pool.query(
      `SELECT id, project_id, original_filename, stored_filename, mime_type,
              size_bytes, uploaded_at
       FROM project_attachments WHERE project_id = $1
       ORDER BY uploaded_at DESC, id DESC`,
      [projectId],
    );
    return res.json(rows.map(rowToAttachmentDTO));
  } catch (err) {
    console.error("[projects/attachments/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/projects/:id/attachments ----
// Multipart upload. Field name is "file". 100 MB hard cap. We sniff the
// actual mime (file-type) — never trust req.file.mimetype.
router.post(
  "/:id/attachments",
  requireAuth,
  (req, res, next) => {
    const guard = forbidEnduserMutation(req, res);
    if (guard) return guard;
    const projectId = parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    req._projectId = projectId;
    next();
  },
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    const projectId = req._projectId;
    if (!req.file) {
      return res.status(400).json({ errorMessage: "No file uploaded" });
    }

    // Sniff the real mime from the buffer. fileTypeFromBuffer returns
    // undefined when it can't determine a type — treat that as unknown/reject.
    let sniff;
    try {
      sniff = await fileTypeFromBuffer(req.file.buffer);
    } catch (e) {
      console.error("[projects/attachments/upload] sniff failed", e.message);
      sniff = null;
    }
    const sniffedMime = sniff?.mime ?? null;
    if (!sniffedMime || !ALLOWED_MIME.has(sniffedMime)) {
      return res.status(400).json({ errorMessage: "File type not allowed" });
    }

    // Verify the project exists before we drop a file on disk.
    try {
      const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId]);
      if (proj.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Project not found" });
      }
    } catch (err) {
      console.error("[projects/attachments/upload] project lookup", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }

    const ext = path.extname(req.file.originalname || "");
    const stored = `${crypto.randomUUID()}${ext}`;
    const projectDir = path.join(UPLOAD_ROOT, "projects", String(projectId));
    const fullPath = path.join(projectDir, stored);

    try {
      await fsp.mkdir(projectDir, { recursive: true });
      await fsp.writeFile(fullPath, req.file.buffer);
    } catch (err) {
      console.error("[projects/attachments/upload] write failed", err.message);
      return res.status(500).json({ errorMessage: "Failed to store file" });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO project_attachments
          (project_id, original_filename, stored_filename, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, project_id, original_filename, stored_filename, mime_type,
                   size_bytes, uploaded_at`,
        [
          projectId,
          req.file.originalname,
          stored,
          sniffedMime,
          req.file.size,
        ],
      );
      return res.status(201).json(rowToAttachmentDTO(rows[0]));
    } catch (err) {
      // Roll back the disk write if the DB insert fails so we don't leak orphans.
      try {
        await fsp.unlink(fullPath);
      } catch {
        /* ignore */
      }
      console.error("[projects/attachments/upload] db insert", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ---- GET /api/projects/:id/attachments/:attId/download ----
router.get("/:id/attachments/:attId/download", requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Attachment not found" });
  }
  if (!Number.isFinite(attId) || attId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid attachment id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT original_filename, stored_filename, mime_type
       FROM project_attachments
       WHERE id = $1 AND project_id = $2`,
      [attId, projectId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Attachment not found" });
    }
    const att = rows[0];
    const fullPath = path.join(UPLOAD_ROOT, "projects", String(projectId), att.stored_filename);

    // Use async stat instead of createReadStream's auto-handling so we can
    // distinguish ENOENT (file vanished) from a stream error.
    try {
      await fsp.access(fullPath);
    } catch {
      return res.status(410).json({ errorMessage: "File is no longer available" });
    }

    // RFC 5987 + quoted filename for the original name. Use a generic
    // ascii-safe fallback for the quoted form to keep headers parseable.
    const ascii = att.original_filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const utf8 = encodeURIComponent(att.original_filename);
    res.setHeader("Content-Type", att.mime_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    );
    const stream = fs.createReadStream(fullPath);
    stream.on("error", (err) => {
      console.error("[projects/attachments/download] stream error", err.message);
      if (!res.headersSent) {
        res.status(500).json({ errorMessage: "Failed to read file" });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error("[projects/attachments/download]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/projects/:id/attachments/:attId ----
router.delete("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const projectId = parseInt(req.params.id, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(attId) || attId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid attachment id" });
  }
  try {
    const { rows, rowCount } = await pool.query(
      `DELETE FROM project_attachments
       WHERE id = $1 AND project_id = $2
       RETURNING stored_filename`,
      [attId, projectId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Attachment not found" });
    }
    const fullPath = path.join(UPLOAD_ROOT, "projects", String(projectId), rows[0].stored_filename);
    try {
      await fsp.unlink(fullPath);
    } catch (fsErr) {
      // File already gone — log but don't fail the request.
      console.error(
        "[projects/attachments/delete] unlink failed",
        fullPath,
        fsErr.message,
      );
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[projects/attachments/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
