// lib/scope.js
//
// Helpers for restricting queries/results to the projects an enduser is
// assigned to. The admin role bypasses scoping entirely (returns null,
// meaning "no extra WHERE clause").
//
// All scoping happens at the SQL level using `project_id = ANY($N::bigint[])`
// so it's impossible to accidentally return an unassigned project even
// if a route is reused. The list of project_ids is loaded from the
// signed JWT — we do NOT re-query the DB on every request, but it
// means a freshly-revoked project takes up to JWT_ACCESS_TTL seconds
// to take effect on an already-signed-in enduser.

import { pool } from "../db/pool.js";

const ADMIN_ROLE = "admin";
const ENDUSER_ROLE = "enduser";

// Returns the list of project_ids the given user is allowed to see, or
// `null` if the user is an admin (i.e. no scoping). Enduser with no
// assignments returns an empty array (caller should treat that as
// "no rows").
export async function getScopedProjectIds(req) {
  if (!req || !req.user) return null;
  if (req.user.role === ADMIN_ROLE) return null;
  if (req.user.role === ENDUSER_ROLE) {
    // Prefer the IDs already on the JWT (avoids a DB roundtrip).
    if (Array.isArray(req.user.projectIds)) {
      // Coerce to plain bigint-shaped numbers defensively.
      return req.user.projectIds
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    // Fall back to the DB. Should only happen if the JWT predates the
    // enduser module (no projectIds claim). We log so it's visible.
    // eslint-disable-next-line no-console
    console.warn(
      `[scope] enduser ${req.user.id} JWT missing projectIds — falling back to DB`,
    );
    const { rows } = await pool.query(
      `SELECT project_id FROM user_project_assignments WHERE user_id = $1`,
      [req.user.id],
    );
    return rows.map((r) => Number(r.project_id));
  }
  // Unknown role — deny by returning an empty list rather than null
  // (null would mean "admin" and accidentally grant full access).
  return [];
}

// Append a scoping clause to a SELECT/UPDATE/DELETE SQL fragment. The
// clause is empty for admins. For endusers it's
// " AND <columnExpression> = ANY($N::bigint[])" where
// `columnExpression` defaults to "project_id" (the column on forms /
// reservations / payments / project_attachments) but can be overridden
// for queries that join a different shape — e.g. on the projects table
// itself the scoping column is "id" because there's no project_id on
// projects.
//
// `placeholderIndex` is the 1-based index that the caller has assigned
// to the projectIds[] array binding. The caller is responsible for
// adding the corresponding value at params[placeholderIndex - 1].
//
// `tableAlias` is the optional table alias to qualify the column
// (e.g. "f" or "r"). Pass null/undefined for unqualified.
//
// `column` overrides the column name (default "project_id"). Useful for
// tables that don't have a project_id column but the scoping still
// applies (projects.id, project_attachments.project_id, etc.).
//
// Returns { sql, params } — sql is "" for admins, params is empty.
export function appendProjectScope({
  placeholderIndex,
  projectIds,
  tableAlias,
  column = "project_id",
}) {
  if (projectIds === null || projectIds === undefined) {
    return { sql: "", params: [] };
  }
  const colExpr = tableAlias ? `${tableAlias}.${column}` : column;
  // `placeholderIndex` is the 1-based integer index; the caller is
  // responsible for the corresponding params entry. We accept both
  // numeric (preferred) and pre-formatted "$N" string (for allocator
  // helpers that emit a string with the dollar sign baked in).
  const ph =
    typeof placeholderIndex === "string"
      ? placeholderIndex
      : `$${placeholderIndex}`;
  return {
    sql: ` AND ${colExpr} = ANY(${ph}::bigint[])`,
    params: [projectIds],
  };
}

// 403 helper. Callers can early-return `if (isEnduser && !isAllowed) ...`.
export function forbidEnduserUnlessOwner({ req, ownerUserId }) {
  if (!req || !req.user) return false;
  if (req.user.role === ADMIN_ROLE) return false;
  if (req.user.role === ENDUSER_ROLE) {
    return Number(ownerUserId) !== Number(req.user.id);
  }
  return true;
}
