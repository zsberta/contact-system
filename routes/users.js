// routes/users.js
//
// Admin CRUD for the users table. Enduser creation goes through the
// invite flow — see POST /api/users + POST /api/users/:id/invite below.
//
// Roles:
//   - admin    — sees and edits everything (default for new admin users)
//   - enduser  — limited to the projects in user_project_assignments;
//                signin is gated by a must_set_password flag that's only
//                cleared after the enduser claims their invite via
//                POST /api/auth/set-password.
//
// Invites are issued via /api/users/:id/invite. The token is a 32-byte
// base64url string; only its sha256 hash is stored. The plaintext is
// returned ONCE in the response (so the admin can copy it) and also
// sent via email (so the enduser gets it).
import express from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/jwtAuth.js";
import { sendMail, resolvePublicUrl } from "../lib/email.js";
import { renderInvite } from "../lib/email-templates.js";

export const router = express.Router();

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST || "12", 10);
const INVITE_TTL_SEC = 24 * 60 * 60; // 24 hours

// All non-public routes require admin. The route-level guards below are
// belt-and-braces — the users resource is admin-only by definition.
router.use(requireAuth);
router.use(requireAdmin);

const PASSWORD_DENY_LIST = new Set([
  "changeme",
  "changeme123",
  "admin",
  "password",
  "12345678",
  "qwerty",
  "letmein",
]);

const ROLE_VALUES = new Set(["admin", "enduser"]);

// Snake_case DB column -> camelCase API field. createdAt is normalised to ISO.
function rowToUserDTO(row) {
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    enabled: row.enabled,
    role: row.role,
    mustSetPassword: !!row.must_set_password,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// Build WHERE clause from queries[] + filterType.
const SEARCH_COLUMNS = ["email", "first_name", "last_name"];
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

const SORTABLE = {
  id: "id",
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  createdAt: "created_at",
  enabled: "enabled",
  role: "role",
};

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, id DESC`;
}

// GET /api/users — paginated list with search + sort
router.get("/", async (req, res) => {
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
  // Optional ?role=admin|enduser filter (used by the FE to split the list).
  const roleFilter = req.query.role;
  const validRoleFilter = ROLE_VALUES.has(roleFilter) ? roleFilter : null;

  const where = buildWhereClause(queries, filterType);
  // Add the role filter on top of the search WHERE. We re-use the same
  // named-placeholder style so the operator never has to know about the
  // exact count of bound params.
  const extras = [];
  if (validRoleFilter) {
    extras.push({ sql: `role = $${where.params.length + 1}`, params: [validRoleFilter] });
  }
  const fullWhereSql = [
    where.sql,
    ...extras.map((e) => (where.sql ? e.sql.replace(/^/, " AND ") : `WHERE ${e.sql}`)),
  ].filter(Boolean).join("");
  const fullWhereParams = [...where.params, ...extras.flatMap((e) => e.params)];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM users ${fullWhereSql}`;
    const countResult = await pool.query(countSql, fullWhereParams);
    const totalElements = countResult.rows[0].total;

    const baseParamCount = fullWhereParams.length;
    const limitParam = baseParamCount + 1;
    const offsetParam = baseParamCount + 2;
    const dataSqlFinal = `SELECT id, first_name, last_name, email, enabled, role, must_set_password, created_at
                          FROM users
                          ${fullWhereSql}
                          ${order}
                          LIMIT $${limitParam} OFFSET $${offsetParam}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...fullWhereParams,
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
    // eslint-disable-next-line no-console
    console.error("[users/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// GET /api/users/:id — full user details (includes project assignments)
router.get("/:id", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, enabled, role, must_set_password, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "User not found" });
    }
    const dto = rowToUserDTO(rows[0]);
    // Project assignments (only meaningful for endusers; admins get []).
    const { rows: aRows } = await pool.query(
      `SELECT project_id FROM user_project_assignments
       WHERE user_id = $1 ORDER BY project_id ASC`,
      [userId],
    );
    dto.projectIds = aRows.map((r) => Number(r.project_id));
    return res.json(dto);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[users/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// POST /api/users — create a new user.
//
// Admins MUST provide a password. Endusers MUST NOT — they're created
// without a password and the server issues an invite token, returning
// the plaintext token in the response AND emailing it.
router.post("/", async (req, res) => {
  const { firstName, lastName, email, password, role } = req.body || {};

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
  const resolvedRole = role === "enduser" ? "enduser" : "admin";

  if (resolvedRole === "admin") {
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ errorMessage: "Password must be at least 8 characters" });
    }
    if (PASSWORD_DENY_LIST.has(password.toLowerCase())) {
      return res.status(400).json({ errorMessage: "Password is too weak" });
    }
  } else {
    // enduser creation: password is ignored. The invite flow is the
    // only way to set the initial password.
    if (password !== undefined && password !== null && password !== "") {
      return res.status(400).json({ errorMessage: "Endusers are created via the invite flow — leave password empty" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let passwordHash = null;
    let mustSet = false;
    if (resolvedRole === "admin") {
      passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    } else {
      // Enduser: no password yet, must call set-password via the invite.
      mustSet = true;
    }
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, enabled, role, must_set_password)
       VALUES ($1, $2, $3, $4, true, $5, $6)
       RETURNING id, first_name, last_name, email, enabled, role, must_set_password, created_at`,
      [email.toLowerCase(), passwordHash, firstName, lastName, resolvedRole, mustSet],
    );
    const dto = rowToUserDTO(rows[0]);
    dto.projectIds = [];
    let inviteToken = null;
    if (resolvedRole === "enduser") {
      // Issue the invite in the same tx so a crash between the two
      // can't leave a half-created user with no invite.
      const plain = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(plain).digest("hex");
      await client.query(
        `INSERT INTO invite_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [dto.id, tokenHash, INVITE_TTL_SEC],
      );
      inviteToken = plain;
      // Best-effort email. Failure does NOT roll back the create.
      const publicUrl = resolvePublicUrl(req);
      const link = `${publicUrl}/set-password?token=${encodeURIComponent(plain)}`;
      const { subject, html, text } = renderInvite({
        userName: firstName || null,
        inviteLink: link,
        isReinvite: false,
      });
      await sendMail({ to: dto.email, subject, html, text });
    }
    await client.query("COMMIT");
    return res.status(201).json({ ...dto, inviteToken });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ errorMessage: "Email already exists" });
    }
    // eslint-disable-next-line no-console
    console.error("[users/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

// PUT /api/users/:id — update an existing user
router.put("/:id", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  const { firstName, lastName, email, password, enabled, role } = req.body || {};

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
  if (role !== undefined && !ROLE_VALUES.has(role)) {
    return res.status(400).json({ errorMessage: "Invalid role" });
  }
  let passwordHash = null;
  if (typeof password === "string" && password.length > 0) {
    if (password.length < 8) {
      return res.status(400).json({ errorMessage: "Password must be at least 8 characters" });
    }
    if (PASSWORD_DENY_LIST.has(password.toLowerCase())) {
      return res.status(400).json({ errorMessage: "Password is too weak" });
    }
    passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  }
  const enabledValue = enabled === undefined ? true : !!enabled;

  try {
    const setClauses = [
      "first_name = $2",
      "last_name = $3",
      "email = $4",
      "enabled = $5",
      "updated_at = now()",
    ];
    const params = [userId, firstName, lastName, email.toLowerCase(), enabledValue];
    if (passwordHash !== null) {
      setClauses.push(`password_hash = $${params.length + 1}`);
      params.push(passwordHash);
    }
    if (role !== undefined) {
      setClauses.push(`role = $${params.length + 1}`);
      params.push(role);
    }
    const sql = `UPDATE users
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id, first_name, last_name, email, enabled, role, must_set_password, created_at`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "User not found" });
    }
    const dto = rowToUserDTO(rows[0]);
    const { rows: aRows } = await pool.query(
      `SELECT project_id FROM user_project_assignments WHERE user_id = $1 ORDER BY project_id ASC`,
      [userId],
    );
    dto.projectIds = aRows.map((r) => Number(r.project_id));
    return res.json(dto);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ errorMessage: "Email already exists" });
    }
    // eslint-disable-next-line no-console
    console.error("[users/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// DELETE /api/users/:id — delete a user (refuses to delete the last enabled user)
router.delete("/:id", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetRes = await client.query(
      `SELECT enabled FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (targetRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ errorMessage: "User not found" });
    }
    const target = targetRes.rows[0];
    if (target.enabled) {
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM users WHERE enabled = true`,
      );
      if (countRes.rows[0].total <= 1) {
        await client.query("ROLLBACK");
        return res.status(409).json({ errorMessage: "Cannot delete the last enabled user" });
      }
    }
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query("COMMIT");
    return res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("[users/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Invite management
// ---------------------------------------------------------------------------
//
// Issue a new invite for a user (admin or enduser). The new invite
// supersedes any prior unconsumed invite for the same user (we mark
// those as consumed with a sentinel reason). The plaintext token is
// returned in the response (so the admin can copy-paste it) and is also
// emailed to the user.
router.post("/:id/invite", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows: userRows } = await pool.query(
      `SELECT id, email, first_name, role, must_set_password FROM users WHERE id = $1`,
      [userId],
    );
    if (userRows.length === 0) {
      return res.status(404).json({ errorMessage: "User not found" });
    }
    const user = userRows[0];
    if (user.role === "admin") {
      // Admins are created with a password directly. Re-inviting would
      // re-issue a token the admin would never use, so we reject.
      return res.status(400).json({ errorMessage: "Admins cannot be re-invited" });
    }
    // Invalidate prior unconsumed invites for this user so only the
    // latest is usable.
    await pool.query(
      `UPDATE invite_tokens SET consumed_at = now()
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
    );
    const plain = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(plain).digest("hex");
    await pool.query(
      `INSERT INTO invite_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [userId, tokenHash, INVITE_TTL_SEC],
    );
    // Re-flip must_set_password so the user can't sign in until they
    // claim this invite (defeats a "claim once, change password via
    // the admin" shortcut).
    await pool.query(
      `UPDATE users SET must_set_password = true, updated_at = now() WHERE id = $1`,
      [userId],
    );
    const publicUrl = resolvePublicUrl(req);
    const link = `${publicUrl}/set-password?token=${encodeURIComponent(plain)}`;
    const { subject, html, text } = renderInvite({
      userName: user.first_name || null,
      inviteLink: link,
      isReinvite: true,
    });
    await sendMail({ to: user.email, subject, html, text });
    return res.json({
      inviteToken: plain,
      expiresAt: new Date(Date.now() + INVITE_TTL_SEC * 1000).toISOString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[users/invite]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// Revoke all outstanding (unconsumed, unexpired) invite tokens for a user.
router.delete("/:id/invite", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE invite_tokens SET consumed_at = now()
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
    );
    return res.json({ revoked: rowCount });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[users/invite/revoke]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Project assignment management
// ---------------------------------------------------------------------------
//
// Two shapes, both with explicit verbs to keep the FE contract obvious:
//
//   PUT  /api/users/:id/projects          body: { projectIds: number[] }
//                                         Replace the user's assignment set
//                                         atomically. Removes old, inserts new.
//
//   POST /api/users/:id/projects          body: { projectId: number }
//                                         Add a single project. (Idempotent.)
//
//   DELETE /api/users/:id/projects/:pid   Remove a single project assignment.
//                                         (Idempotent — 204 even if no row.)
// ---------------------------------------------------------------------------
router.put("/:id/projects", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const { projectIds } = req.body || {};
  if (!Array.isArray(projectIds)) {
    return res.status(400).json({ errorMessage: "projectIds must be an array" });
  }
  if (projectIds.length > 200) {
    return res.status(400).json({ errorMessage: "projectIds: maximum 200 entries" });
  }
  // Validate each id is a positive integer.
  const cleaned = [];
  const seen = new Set();
  for (const p of projectIds) {
    const n = typeof p === "number" ? p : parseInt(p, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ errorMessage: "projectIds contains invalid id" });
    }
    if (!seen.has(n)) {
      seen.add(n);
      cleaned.push(n);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount: userExists } = await client.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [userId],
    );
    if (userExists === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ errorMessage: "User not found" });
    }
    // Validate every project exists. We do this in one round-trip with
    // ANY($1) so it scales to large assignment sets.
    if (cleaned.length > 0) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM projects WHERE id = ANY($1::bigint[])`,
        [cleaned],
      );
      if (rowCount !== cleaned.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ errorMessage: "One or more projectIds do not exist" });
      }
    }
    await client.query(`DELETE FROM user_project_assignments WHERE user_id = $1`, [userId]);
    for (const pid of cleaned) {
      await client.query(
        `INSERT INTO user_project_assignments (user_id, project_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, pid],
      );
    }
    await client.query("COMMIT");
    return res.json({ userId, projectIds: cleaned });
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("[users/assignments/replace]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

router.post("/:id/projects", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const { projectId } = req.body || {};
  const pid = typeof projectId === "number" ? projectId : parseInt(projectId, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return res.status(400).json({ errorMessage: "Invalid projectId" });
  }
  try {
    const { rowCount: userExists } = await pool.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [userId],
    );
    if (userExists === 0) return res.status(404).json({ errorMessage: "User not found" });
    const { rowCount: projExists } = await pool.query(
      `SELECT 1 FROM projects WHERE id = $1`,
      [pid],
    );
    if (projExists === 0) return res.status(404).json({ errorMessage: "Project not found" });
    await pool.query(
      `INSERT INTO user_project_assignments (user_id, project_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, pid],
    );
    return res.status(204).send();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[users/assignments/add]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.delete("/:id/projects/:pid", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const pid = parseInt(req.params.pid, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return res.status(400).json({ errorMessage: "Invalid project id" });
  }
  try {
    await pool.query(
      `DELETE FROM user_project_assignments WHERE user_id = $1 AND project_id = $2`,
      [userId, pid],
    );
    return res.status(204).send();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[users/assignments/remove]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
