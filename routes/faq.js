import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds } from "../lib/scope.js";
import { invalidateFaqCache } from "./faq-public.js";

// CRUD for the FAQ (GYIK) module.
// Pattern mirrors routes/blog.js — same auth/RBAC/scope contract.

export const router = express.Router();
router.use(requireAuth);

const isEnduser = (req) => req.user && req.user.role === "enduser";
const requireProjectAccess = async (req, res, projectId) => {
  if (!isEnduser(req)) return null;
  const scopedProjectIds = await getScopedProjectIds(req);
  if (Array.isArray(scopedProjectIds) && !scopedProjectIds.includes(Number(projectId))) {
    return res.status(403).json({ errorMessage: "Access denied to this project" });
  }
  return null;
};

const STATUS_VALUES = new Set(["draft", "published"]);
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const QUESTION_MAX = 500;
const ANSWER_MAX = 50000;

function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

const rowToFaqItemDTO = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name ?? null,
    question: row.question,
    answer: row.answer,
    sortOrder: Number(row.sort_order),
    locale: row.locale,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by == null ? null : Number(row.created_by),
  };
};

const SORTABLE = {
  id: "id",
  question: "question",
  sortOrder: "sort_order",
  status: "status",
  locale: "locale",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const SEARCH_COLUMNS = ["f.question", "f.answer"];

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
    clauses: built.map((b) => b.sql),
    params: built.flatMap((b) => b.params),
    sql: built.map((b) => b.sql).join(conj),
  };
}

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "sort_order";
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

function buildStatusFilterClause(status, allocator) {
  if (!status) return { sql: "", params: [] };
  if (typeof status !== "string" || !STATUS_VALUES.has(status)) {
    return { sql: "", params: [], invalid: true };
  }
  return { sql: `f.status = ${allocator.next()}`, params: [status] };
}

function buildLocaleFilterClause(locale, allocator) {
  if (!locale) return { sql: "", params: [] };
  if (typeof locale !== "string" || !LOCALE_RE.test(locale)) {
    return { sql: "", params: [], invalid: true };
  }
  return { sql: `f.locale = ${allocator.next()}`, params: [locale] };
}

function validateFaqItemBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

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

  if (body.locale !== undefined) {
    if (typeof body.locale !== "string" || !LOCALE_RE.test(body.locale)) {
      errors.push("locale must match /^[a-z]{2}(-[A-Z]{2})?$/");
    } else {
      out.locale = body.locale;
    }
  } else if (!partial) {
    out.locale = "hu";
  }

  if (body.question !== undefined) {
    if (typeof body.question !== "string") {
      errors.push("question must be a string");
    } else {
      const trimmed = body.question.trim();
      if (trimmed.length < 1 || trimmed.length > QUESTION_MAX) {
        errors.push(`question must be 1..${QUESTION_MAX} chars`);
      } else {
        out.question = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("question is required");
  }

  if (body.answer !== undefined) {
    if (typeof body.answer !== "string") {
      errors.push("answer must be a string");
    } else {
      const trimmed = body.answer.trim();
      if (trimmed.length < 1 || trimmed.length > ANSWER_MAX) {
        errors.push(`answer must be 1..${ANSWER_MAX} chars`);
      } else {
        out.answer = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("answer is required");
  }

  if (body.sortOrder !== undefined || body.sort_order !== undefined) {
    const v = body.sortOrder ?? body.sort_order;
    const n = typeof v === "number" ? v : parseInt(v, 10);
    if (!Number.isFinite(n)) {
      errors.push("sortOrder must be a number");
    } else {
      out.sort_order = n;
    }
  } else if (!partial) {
    out.sort_order = 0;
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of: ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  } else if (!partial) {
    out.status = "draft";
  }

  return { out, errors };
}

// ---- GET /api/faq — paged list ----
router.get("/", async (req, res) => {
  try {
    const allocator = makePlaceholderAllocator(1);
    const conditions = [];
    const params = [];

    if (isEnduser(req)) {
      const scopedProjectIds = await getScopedProjectIds(req);
      if (Array.isArray(scopedProjectIds) && scopedProjectIds.length === 0) {
        return res.json({
          content: [], totalElements: 0, totalPages: 0, number: 0, size: 10,
          first: true, last: true, empty: true, numberOfElements: 0,
          sort: { sorted: false, unsorted: true, empty: true },
          pageable: { paged: true, pageSize: 10, pageNumber: 0, unpaged: false, offset: 0,
            sort: { sorted: false, unsorted: true, empty: true } },
        });
      }
      if (Array.isArray(scopedProjectIds)) {
        const ph = allocator.next();
        conditions.push(`f.project_id = ANY(${ph}::int[])`);
        params.push(scopedProjectIds);
      }
    }

    const projectFilter = buildProjectFilterClause(req.query.projectId, allocator);
    if (projectFilter.sql) { conditions.push(projectFilter.sql); params.push(...projectFilter.params); }

    const statusFilter = buildStatusFilterClause(req.query.status, allocator);
    if (statusFilter.invalid) return res.status(400).json({ errorMessage: "Invalid status" });
    if (statusFilter.sql) { conditions.push(statusFilter.sql); params.push(...statusFilter.params); }

    const localeFilter = buildLocaleFilterClause(req.query.locale, allocator);
    if (localeFilter.invalid) return res.status(400).json({ errorMessage: "Invalid locale" });
    if (localeFilter.sql) { conditions.push(localeFilter.sql); params.push(...localeFilter.params); }

    const searchResult = buildWhereClause(req.query.queries, req.query.filterType, allocator);
    if (searchResult.sql) { conditions.push(searchResult.sql); params.push(...searchResult.params); }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size || "10", 10) || 10));
    const sortField = req.query.sortField || "sort_order";
    const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
    const orderSql = buildOrderClause(sortField, sortOrder);

    const countQuery = `SELECT COUNT(*) FROM faq_items f ${whereSql}`;
    const countResult = await pool.query(countQuery, params);
    const totalElements = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalElements / size) || 1;

    const dataPh = allocator.next();
    const dataQuery = `
      SELECT f.*, p.name AS project_name
      FROM faq_items f
      LEFT JOIN projects p ON p.id = f.project_id
      ${whereSql}
      ${orderSql}
      LIMIT ${dataPh} OFFSET ${allocator.next()}
    `;
    const dataParams = [...params, size, page * size];
    const dataResult = await pool.query(dataQuery, dataParams);

    return res.json({
      content: dataResult.rows.map(rowToFaqItemDTO),
      totalElements,
      totalPages,
      number: page,
      size,
      first: page === 0,
      last: page >= totalPages - 1,
      empty: totalElements === 0,
      numberOfElements: dataResult.rows.length,
      sort: { sorted: true, unsorted: false, empty: false },
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset: page * size,
        sort: { sorted: true, unsorted: false, empty: false },
      },
    });
  } catch (err) {
    console.error("[faq/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/faq/:id ----
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS project_name FROM faq_items f
       LEFT JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "FAQ item not found" });
    }
    const denied = await requireProjectAccess(req, res, rows[0].project_id);
    if (denied) return denied;
    return res.json(rowToFaqItemDTO(rows[0]));
  } catch (err) {
    console.error("[faq/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/faq — create ----
router.post("/", async (req, res) => {
  try {
    const { out, errors } = validateFaqItemBody(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errorMessage: errors.join(", ") });
    }
    const denied = await requireProjectAccess(req, res, out.project_id);
    if (denied) return denied;

    const { rows } = await pool.query(
      `INSERT INTO faq_items (project_id, question, answer, sort_order, locale, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [out.project_id, out.question, out.answer, out.sort_order, out.locale, out.status, req.user?.id || null],
    );
    invalidateFaqCache(out.project_id);
    return res.status(201).json(rowToFaqItemDTO(rows[0]));
  } catch (err) {
    console.error("[faq/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/faq/:id — update ----
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    const { out, errors } = validateFaqItemBody(req.body, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json({ errorMessage: errors.join(", ") });
    }
    if (Object.keys(out).length === 0) {
      return res.status(400).json({ errorMessage: "No valid fields to update" });
    }
    const existing = await pool.query(`SELECT project_id FROM faq_items WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ errorMessage: "FAQ item not found" });
    }
    const denied = await requireProjectAccess(req, res, existing.rows[0].project_id);
    if (denied) return denied;

    const setClauses = [];
    const setParams = [];
    let idx = 1;
    for (const [col, val] of Object.entries(out)) {
      setClauses.push(`${col} = $${idx++}`);
      setParams.push(val);
    }
    setParams.push(id);

    const { rows } = await pool.query(
      `UPDATE faq_items SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      setParams,
    );
    invalidateFaqCache(existing.rows[0].project_id);
    return res.json(rowToFaqItemDTO(rows[0]));
  } catch (err) {
    console.error("[faq/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/faq/:id ----
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    const existing = await pool.query(`SELECT project_id FROM faq_items WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ errorMessage: "FAQ item not found" });
    }
    const denied = await requireProjectAccess(req, res, existing.rows[0].project_id);
    if (denied) return denied;
    await pool.query(`DELETE FROM faq_items WHERE id = $1`, [id]);
    invalidateFaqCache(existing.rows[0].project_id);
    return res.status(204).end();
  } catch (err) {
    console.error("[faq/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/faq/:id/publish ----
router.post("/:id/publish", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    const existing = await pool.query(`SELECT project_id FROM faq_items WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ errorMessage: "FAQ item not found" });
    }
    const denied = await requireProjectAccess(req, res, existing.rows[0].project_id);
    if (denied) return denied;
    const { rows } = await pool.query(
      `UPDATE faq_items SET status = 'published' WHERE id = $1 RETURNING *`,
      [id],
    );
    invalidateFaqCache(existing.rows[0].project_id);
    return res.json(rowToFaqItemDTO(rows[0]));
  } catch (err) {
    console.error("[faq/publish]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/faq/:id/unpublish ----
router.post("/:id/unpublish", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    const existing = await pool.query(`SELECT project_id FROM faq_items WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ errorMessage: "FAQ item not found" });
    }
    const denied = await requireProjectAccess(req, res, existing.rows[0].project_id);
    if (denied) return denied;
    const { rows } = await pool.query(
      `UPDATE faq_items SET status = 'draft' WHERE id = $1 RETURNING *`,
      [id],
    );
    invalidateFaqCache(existing.rows[0].project_id);
    return res.json(rowToFaqItemDTO(rows[0]));
  } catch (err) {
    console.error("[faq/unpublish]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
