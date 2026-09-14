// routes/logs.js
//
// Admin-only activity log API. Read-only; rows are written by
// lib/activity-log.js logActivity() calls across all routers.
//
// Endpoints:
//   GET /api/logs      — paged, filterable list (mirrors routes/users.js pattern)
//   GET /api/logs/meta — distinct actions / entity types / actor types for filters
//   GET /api/logs/:id  — single row or 404

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/jwtAuth.js";

export const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// Snake_case DB row -> camelCase API DTO. createdAt normalised to ISO.
function rowToLogDTO(row) {
  return {
    id: Number(row.id),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    actorIp: row.actor_ip,
    method: row.method,
    path: row.path,
    action: row.action,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id === null ? null : Number(row.entity_id),
    entityLabel: row.entity_label,
    projectId: row.project_id === null ? null : Number(row.project_id),
    statusCode: row.status_code,
    ok: !!row.ok,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

// Free-text search across the human-meaningful columns.
const SEARCH_COLUMNS = ["action", "path", "actor_email", "entity_label", "metadata::text"];
function buildWhereClause(queries, filterType) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const joiner = filterType === "all" ? " AND " : " OR ";
  const clauses = terms.map((term, i) => {
    const ors = SEARCH_COLUMNS.map((col, j) => `${col} ILIKE $${i * SEARCH_COLUMNS.length + j + 1}`);
    return `(${ors.join(" OR ")})`;
  });
  const params = [];
  for (const term of terms) {
    const like = `%${term.trim()}%`;
    for (let k = 0; k < SEARCH_COLUMNS.length; k += 1) params.push(like);
  }
  return { sql: `WHERE ${clauses.join(joiner)}`, params };
}

const SORTABLE = {
  id: "id",
  createdAt: "created_at",
  action: "action",
  actionType: "action_type",
  actorType: "actor_type",
  entityType: "entity_type",
  projectId: "project_id",
  method: "method",
};

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, id DESC`;
}

// GET /api/logs/meta — distinct filter values for the frontend selects.
router.get("/meta", async (_req, res) => {
  try {
    const [actions, entityTypes, actorTypes] = await Promise.all([
      pool.query(`SELECT DISTINCT action FROM activity_logs ORDER BY 1`),
      pool.query(`SELECT DISTINCT entity_type FROM activity_logs WHERE entity_type IS NOT NULL ORDER BY 1`),
      pool.query(`SELECT DISTINCT actor_type FROM activity_logs ORDER BY 1`),
    ]);
    return res.json({
      actions: actions.rows.map((r) => r.action),
      entityTypes: entityTypes.rows.map((r) => r.entity_type),
      actorTypes: actorTypes.rows.map((r) => r.actor_type),
    });
  } catch (err) {
    console.error("[logs/meta]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// GET /api/logs — paginated list with free-text + dedicated filters.
router.get("/", async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? "10", 10) || 10));
  const sortField = req.query.sortField || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  const rawQueries = req.query.queries;
  const queries = Array.isArray(rawQueries) ? rawQueries : rawQueries ? [rawQueries] : [];
  const filterType = req.query.filterType === "all" ? "all" : "any";

  const where = buildWhereClause(queries, filterType);
  const extras = [];
  // Dedicated filters — each appends one placeholder-bound predicate.
  // (Offset math: count placeholders already used by where + earlier extras.)
  const addExtra = (sql, value) => {
    const n = where.params.length + extras.flatMap((e) => e.params).length + 1;
    extras.push({ sql: sql.replace("?", `$${n}`), params: [value] });
  };
  if (req.query.actionType) addExtra(`action_type = ?`, req.query.actionType);
  if (req.query.action) {
    const actions = String(req.query.action).split(",").map((s) => s.trim()).filter(Boolean);
    if (actions.length === 1) addExtra(`action = ?`, actions[0]);
    else if (actions.length > 1) {
      const start = where.params.length + extras.flatMap((e) => e.params).length + 1;
      const placeholders = actions.map((_, i) => `$${start + i}`).join(", ");
      extras.push({ sql: `action IN (${placeholders})`, params: actions });
    }
  }
  if (req.query.actorType) addExtra(`actor_type = ?`, req.query.actorType);
  if (req.query.actorEmail) addExtra(`actor_email ILIKE ?`, `%${req.query.actorEmail}%`);
  if (req.query.entityType) addExtra(`entity_type = ?`, req.query.entityType);
  if (req.query.entityId !== undefined && req.query.entityId !== "") {
    const eid = parseInt(req.query.entityId, 10);
    if (Number.isFinite(eid)) addExtra(`entity_id = ?`, eid);
  }
  if (req.query.projectId !== undefined && req.query.projectId !== "") {
    const pid = parseInt(req.query.projectId, 10);
    if (Number.isFinite(pid)) addExtra(`project_id = ?`, pid);
  }
  if (req.query.method) addExtra(`method = ?`, String(req.query.method).toUpperCase());
  if (req.query.dateFrom) addExtra(`created_at >= ?`, req.query.dateFrom);
  if (req.query.dateTo) addExtra(`created_at <= ?`, req.query.dateTo);

  const whereConds = where.sql ? [where.sql.replace(/^WHERE\s+/, "")] : [];
  const extraConds = extras.map((e) => e.sql);
  const allConds = [...whereConds, ...extraConds];
  const fullWhereSql = allConds.length > 0 ? `WHERE ${allConds.join(" AND ")}` : "";
  const fullWhereParams = [...where.params, ...extras.flatMap((e) => e.params)];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM activity_logs ${fullWhereSql}`,
      fullWhereParams,
    );
    const totalElements = countResult.rows[0].total;

    const baseParamCount = fullWhereParams.length;
    const dataResult = await pool.query(
      `SELECT id, created_at, actor_type, actor_user_id, actor_email, actor_role,
              actor_ip, method, path, action, action_type,
              entity_type, entity_id, entity_label, project_id,
              status_code, ok, metadata
       FROM activity_logs
       ${fullWhereSql}
       ${order}
       LIMIT $${baseParamCount + 1} OFFSET $${baseParamCount + 2}`,
      [...fullWhereParams, size, offset],
    );

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToLogDTO);
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
    console.error("[logs/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// GET /api/logs/:id — single row or 404.
router.get("/:id", async (req, res) => {
  const logId = parseInt(req.params.id, 10);
  if (!Number.isFinite(logId) || logId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, actor_type, actor_user_id, actor_email, actor_role,
              actor_ip, method, path, action, action_type,
              entity_type, entity_id, entity_label, project_id,
              status_code, ok, metadata
       FROM activity_logs WHERE id = $1`,
      [logId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Log entry not found" });
    }
    return res.json(rowToLogDTO(rows[0]));
  } catch (err) {
    console.error("[logs/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
