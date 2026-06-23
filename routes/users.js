import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST || "12", 10);

// Refuse known-weak passwords — mirrors db/seed.js. We don't enforce the 12-char
// admin floor here (that one is reserved for the seeded admin); normal users get 8+.
const PASSWORD_DENY_LIST = new Set([
  "changeme",
  "changeme123",
  "admin",
  "password",
  "12345678",
  "qwerty",
  "letmein",
]);

// Snake_case DB column -> camelCase API field. createdAt is normalised to ISO.
function rowToUserDTO(row) {
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// Build WHERE clause from queries[] + filterType. Mirrors the inventobee search pattern:
// each term matches against email OR first_name OR last_name (case-insensitive ILIKE),
// combined per filterType ("any" = OR, "all" = AND).
function buildWhereClause(queries, filterType) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) {
    return { sql: "", params: [] };
  }

  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = terms
    .map(() => "(email ILIKE $X OR first_name ILIKE $X OR last_name ILIKE $X)")
    .join(conj);
  // Replace placeholder $X markers with concrete positional params below.
  let placeholder = 1;
  let nextPlaceholder = () => `$${placeholder++}`;
  const sql = clauses.replaceAll("$X", () => nextPlaceholder());
  const params = terms.map((t) => `%${t}%`);
  return { sql: `WHERE ${sql}`, params };
}

// Whitelist of sortable API fields -> DB columns. Anything else is ignored safely.
const SORTABLE = {
  id: "id",
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  createdAt: "created_at",
  enabled: "enabled",
};

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  // Tie-breaker on id so pagination is deterministic when many rows share a value.
  return `ORDER BY ${col} ${dir}, id DESC`;
}

// GET /api/users — paginated list with search + sort
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? "10", 10) || 10));
  const sortField = req.query.sortField || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  // Express parses repeated keys as an array; coerce safely.
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

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM users ${where.sql}`;
    const countResult = await pool.query(countSql, where.params);
    const totalElements = countResult.rows[0].total;

    // LIMIT/OFFSET positional params come after all WHERE params.
    const baseParamCount = where.params.length;
    const limitParam = baseParamCount + 1;
    const offsetParam = baseParamCount + 2;
    const dataSqlFinal = `SELECT id, first_name, last_name, email, enabled, created_at
                          FROM users
                          ${where.sql}
                          ${order}
                          LIMIT $${limitParam} OFFSET $${offsetParam}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...where.params,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToUserDTO);
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
    console.error("[users/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// GET /api/users/:id — full user details
router.get("/:id", requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, enabled, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "User not found" });
    }
    return res.json(rowToUserDTO(rows[0]));
  } catch (err) {
    console.error("[users/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// POST /api/users — create a new user
router.post("/", requireAuth, async (req, res) => {
  const { firstName, lastName, email, password } = req.body || {};

  if (
    typeof firstName !== "string" ||
    firstName.length < 1 ||
    firstName.length > 50
  ) {
    return res.status(400).json({ errorMessage: "Invalid first name" });
  }
  if (
    typeof lastName !== "string" ||
    lastName.length < 1 ||
    lastName.length > 50
  ) {
    return res.status(400).json({ errorMessage: "Invalid last name" });
  }
  if (
    typeof email !== "string" ||
    email.length < 1 ||
    email.length > 255 ||
    !email.includes("@")
  ) {
    return res.status(400).json({ errorMessage: "Invalid email" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res
      .status(400)
      .json({ errorMessage: "Password must be at least 8 characters" });
  }
  if (PASSWORD_DENY_LIST.has(password.toLowerCase())) {
    return res.status(400).json({ errorMessage: "Password is too weak" });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, enabled)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, first_name, last_name, email, enabled, created_at`,
      [email.toLowerCase(), hash, firstName, lastName],
    );
    return res.status(201).json(rowToUserDTO(rows[0]));
  } catch (err) {
    // 23505 = unique_violation on email (CITEXT UNIQUE).
    if (err.code === "23505") {
      return res.status(409).json({ errorMessage: "Email already exists" });
    }
    console.error("[users/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// PUT /api/users/:id — update an existing user
router.put("/:id", requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  const { firstName, lastName, email, password, enabled } = req.body || {};

  if (
    typeof firstName !== "string" ||
    firstName.length < 1 ||
    firstName.length > 50
  ) {
    return res.status(400).json({ errorMessage: "Invalid first name" });
  }
  if (
    typeof lastName !== "string" ||
    lastName.length < 1 ||
    lastName.length > 50
  ) {
    return res.status(400).json({ errorMessage: "Invalid last name" });
  }
  if (
    typeof email !== "string" ||
    email.length < 1 ||
    email.length > 255 ||
    !email.includes("@")
  ) {
    return res.status(400).json({ errorMessage: "Invalid email" });
  }
  // Password is OPTIONAL on edit. Empty/undefined = keep current.
  let passwordHash = null;
  if (typeof password === "string" && password.length > 0) {
    if (password.length < 8) {
      return res
        .status(400)
        .json({ errorMessage: "Password must be at least 8 characters" });
    }
    if (PASSWORD_DENY_LIST.has(password.toLowerCase())) {
      return res.status(400).json({ errorMessage: "Password is too weak" });
    }
    passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  }
  // enabled defaults to true when omitted, matching the create behaviour.
  const enabledValue = enabled === undefined ? true : !!enabled;

  try {
    // Build dynamic SET clause so we don't overwrite password_hash with NULL when the caller
    // didn't provide a new password.
    const setClauses = [
      "first_name = $2",
      "last_name = $3",
      "email = $4",
      "enabled = $5",
      "updated_at = now()",
    ];
    const params = [
      userId,
      firstName,
      lastName,
      email.toLowerCase(),
      enabledValue,
    ];
    if (passwordHash !== null) {
      setClauses.push(`password_hash = $${params.length + 1}`);
      params.push(passwordHash);
    }
    const sql = `UPDATE users
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id, first_name, last_name, email, enabled, created_at`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "User not found" });
    }
    return res.json(rowToUserDTO(rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ errorMessage: "Email already exists" });
    }
    console.error("[users/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// DELETE /api/users/:id — delete a user (refuses to delete the last enabled user)
router.delete("/:id", requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Look up the target user — both for the 404 case and to check enabled.
    // FOR UPDATE locks the row so a concurrent create/delete can't race past us.
    const targetRes = await client.query(
      `SELECT enabled FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (targetRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ errorMessage: "User not found" });
    }
    const target = targetRes.rows[0];

    // Soft-lock guard: if this user is enabled and they are the last enabled user, refuse.
    // We re-count inside the same transaction so we can't slip past via a concurrent insert.
    if (target.enabled) {
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM users WHERE enabled = true`,
      );
      if (countRes.rows[0].total <= 1) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ errorMessage: "Cannot delete the last enabled user" });
      }
    }

    // Belt-and-braces revoke. The FK is ON DELETE CASCADE so this would happen
    // automatically, but revoking explicitly makes the intent obvious in the log.
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query("COMMIT");
    return res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[users/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});
