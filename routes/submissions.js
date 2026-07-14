// routes/submissions.js
//
// Cross-project aggregation endpoints for the Submissions Overview page.
// These endpoints join form_submissions / reservation_bookings with their
// parent tables to scope results by the user's accessible projects.
//
// Mounted at /api/submissions — separate from the per-resource routes
// to avoid path parameter conflicts (/:id/submissions vs /submissions).

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";
import { checkSlotAvailability } from "../lib/reservation-availability.js";

export const router = express.Router();
router.use(requireAuth);

const isEnduser = (req) => req.user && req.user.role === "enduser";

// ---------------------------------------------------------------------------
// GET /api/submissions/forms — cross-project form submissions
//
// Query params: page, size, sortField (submittedAt|createdAt), sortOrder,
//               queries[], filterType, projectId
//
// Returns a paged list of form_submissions joined with forms (for form name
// + project name). Scoped to the user's accessible projects.
// ---------------------------------------------------------------------------

const ALLOWED_FORM_SORT_FIELDS = new Set(["submittedAt", "createdAt"]);
const FORM_SORT_COLUMN_MAP = {
  submittedAt: "s.submitted_at",
  createdAt: "s.created_at",
};

function buildFormSubmissionsWhere({ queries = [], filterType = "any" }, baseIndex) {
  const terms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = [];
  const params = [];
  for (let i = 0; i < terms.length; i++) {
    const pattern = `%${terms[i].replace(/[%_]/g, (m) => "\\" + m)}%`;
    const pos = baseIndex + i;
    clauses.push(
      `(s.ip_address::text ILIKE $${pos}` +
      ` OR s.locale ILIKE $${pos}` +
      ` OR s.data::text ILIKE $${pos}` +
      ` OR f.name ILIKE $${pos}` +
      ` OR proj.name ILIKE $${pos}` + `)`,
    );
    params.push(pattern);
  }
  return { sql: " AND (" + clauses.join(conj) + ")", params };
}

router.get("/forms", async (req, res, next) => {
  try {
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
    const size = Math.min(
      100,
      Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
    );
    const sortFieldRaw = req.query.sortField ?? "submittedAt";
    const sortField = typeof sortFieldRaw === "string" ? sortFieldRaw : "submittedAt";
    if (!ALLOWED_FORM_SORT_FIELDS.has(sortField)) {
      return res.status(400).json({ errorMessage: "Invalid sortField" });
    }
    const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";

    const rawQueries = req.query.queries;
    const queries = Array.isArray(rawQueries)
      ? rawQueries
      : rawQueries ? [rawQueries] : [];
    const filterType = req.query.filterType === "all" ? "all" : "any";

    // Optional project filter (beyond the enduser scope).
    const projectIdRaw = req.query.projectId;
    const projectIdFilter =
      projectIdRaw && /^\d+$/.test(String(projectIdRaw))
        ? Number(projectIdRaw)
        : null;

    // Enduser scope: get the list of allowed project IDs.
    const scopedProjectIds = await getScopedProjectIds(req);

    const where = buildFormSubmissionsWhere({ queries, filterType }, 1);
    const col = FORM_SORT_COLUMN_MAP[sortField] ?? "s.submitted_at";
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    const orderSql = `ORDER BY ${col} ${dir}, s.id DESC`;

    // Build the project scope clause.
    let scopeSql = "";
    const scopeParams = [];
    let nextParam = where.params.length + 1;

    if (scopedProjectIds !== null) {
      // Enduser: restrict to their assigned projects.
      if (scopedProjectIds.length === 0) {
        // No projects assigned — return empty.
        return res.json({
          content: [],
          totalElements: 0,
          totalPages: 0,
          pageable: {
            paged: true,
            pageSize: size,
            pageNumber: page,
            unpaged: false,
            offset: page * size,
            sort: { sorted: false, unsorted: true, empty: false },
          },
          numberOfElements: 0,
          size,
          number: page,
          sort: { sorted: false, unsorted: true, empty: false },
          first: true,
          last: true,
          empty: true,
        });
      }
      scopeSql = ` AND f.project_id = ANY($${nextParam}::bigint[])`;
      scopeParams.push(scopedProjectIds);
      nextParam++;
    }

    if (projectIdFilter !== null) {
      scopeSql += ` AND f.project_id = $${nextParam}`;
      scopeParams.push(projectIdFilter);
      nextParam++;
    }

    // Params order: [where params, scope params, size, page*size]
    // Placeholders: $1..$N for where, $N+1..$M for scope, $M+1=size, $M+2=offset
    const baseParam = where.params.length;
    const dataParams = [...where.params, ...scopeParams, size, page * size];
    const limitParam = baseParam + scopeParams.length + 1;
    const offsetParam = limitParam + 1;

    const dataSql = `
      SELECT s.id, s.form_id, s.submitted_at, s.ip_address, s.user_agent,
             s.referer, s.data, s.locale, s.created_at,
             f.name AS form_name, f.project_id,
             proj.name AS project_name
      FROM form_submissions s
      JOIN forms f ON f.id = s.form_id
      JOIN projects proj ON proj.id = f.project_id
      WHERE 1=1${scopeSql}${where.sql}
      ${orderSql}
      LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, dataParams);

    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM form_submissions s
      JOIN forms f ON f.id = s.form_id
      JOIN projects proj ON proj.id = f.project_id
      WHERE 1=1${scopeSql}${where.sql}`;
    const countResult = await pool.query(countSql, [...where.params, ...scopeParams]);
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
        formName: row.form_name ?? "",
        projectId: Number(row.project_id),
        projectName: row.project_name ?? "",
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
    console.error("[submissions/forms]", err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/submissions/bookings — cross-project reservation bookings
//
// Query params: page, size, sortField (startsAt|endsAt|bookedAt), sortOrder,
//               queries[], filterType, projectId
//
// Returns a paged list of reservation_bookings joined with reservations
// (for reservation name + project name). Scoped to the user's accessible
// projects.
// ---------------------------------------------------------------------------

const ALLOWED_BOOKING_SORT_FIELDS = new Set(["startsAt", "endsAt", "bookedAt"]);
const BOOKING_SORT_COLUMN_MAP = {
  startsAt: "b.starts_at",
  endsAt: "b.ends_at",
  bookedAt: "b.booked_at",
};

function buildBookingsWhere({ queries = [], filterType = "any" }, baseIndex) {
  const terms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = [];
  const params = [];
  for (let i = 0; i < terms.length; i++) {
    const pattern = `%${terms[i].replace(/[%_]/g, (m) => "\\" + m)}%`;
    const pos = baseIndex + i;
    clauses.push(
      `(b.ip_address::text ILIKE $${pos}` +
      ` OR b.locale ILIKE $${pos}` +
      ` OR b.data::text ILIKE $${pos}` +
      ` OR r.name ILIKE $${pos}` +
      ` OR proj.name ILIKE $${pos}` + `)`,
    );
    params.push(pattern);
  }
  return { sql: " AND (" + clauses.join(conj) + ")", params };
}

router.get("/bookings", async (req, res, next) => {
  try {
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
      : rawQueries ? [rawQueries] : [];
    const filterType = req.query.filterType === "all" ? "all" : "any";

    const projectIdRaw = req.query.projectId;
    const projectIdFilter =
      projectIdRaw && /^\d+$/.test(String(projectIdRaw))
        ? Number(projectIdRaw)
        : null;

    const scopedProjectIds = await getScopedProjectIds(req);

    const where = buildBookingsWhere({ queries, filterType }, 1);
    const col = BOOKING_SORT_COLUMN_MAP[sortField] ?? "b.booked_at";
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    const orderSql = `ORDER BY ${col} ${dir}, b.id DESC`;

    let scopeSql = "";
    const scopeParams = [];
    let nextParam = where.params.length + 1;

    if (scopedProjectIds !== null) {
      if (scopedProjectIds.length === 0) {
        return res.json({
          content: [],
          totalElements: 0,
          totalPages: 0,
          pageable: {
            paged: true,
            pageSize: size,
            pageNumber: page,
            unpaged: false,
            offset: page * size,
            sort: { sorted: false, unsorted: true, empty: false },
          },
          numberOfElements: 0,
          size,
          number: page,
          sort: { sorted: false, unsorted: true, empty: false },
          first: true,
          last: true,
          empty: true,
        });
      }
      scopeSql = ` AND r.project_id = ANY($${nextParam}::bigint[])`;
      scopeParams.push(scopedProjectIds);
      nextParam++;
    }

    if (projectIdFilter !== null) {
      scopeSql += ` AND r.project_id = $${nextParam}`;
      scopeParams.push(projectIdFilter);
      nextParam++;
    }

    // Params order: [where params, scope params, size, page*size]
    const baseParam = where.params.length;
    const dataParams = [...where.params, ...scopeParams, size, page * size];
    const limitParam = baseParam + scopeParams.length + 1;
    const offsetParam = limitParam + 1;

    const dataSql = `
      SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
             b.ip_address, b.user_agent, b.referer, b.data, b.locale,
             r.name AS reservation_name, r.project_id,
             proj.name AS project_name
      FROM reservation_bookings b
      JOIN reservations r ON r.id = b.reservation_id
      JOIN projects proj ON proj.id = r.project_id
      WHERE 1=1${scopeSql}${where.sql}
      ${orderSql}
      LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, dataParams);

    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM reservation_bookings b
      JOIN reservations r ON r.id = b.reservation_id
      JOIN projects proj ON proj.id = r.project_id
      WHERE 1=1${scopeSql}${where.sql}`;
    const countResult = await pool.query(countSql, [...where.params, ...scopeParams]);
    const totalElements = Number(countResult.rows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalElements / size));

    const content = dataResult.rows.map((row) => {
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
        reservationName: row.reservation_name ?? "",
        projectId: Number(row.project_id),
        projectName: row.project_name ?? "",
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
    console.error("[submissions/bookings]", err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/submissions/bookings/calendar?from=...&to=...&projectId=...
//
// Returns all bookings in a time window across all accessible reservations.
// Used by the calendar tab on the submissions page. Unlike the paged
// endpoints, this returns ALL matching rows (capped at 5000) so the
// frontend can render them on a monthly grid.
// ---------------------------------------------------------------------------

router.get("/bookings/calendar", async (req, res, next) => {
  try {
    // Express parses duplicate query params as arrays — force string.
    const fromRaw = Array.isArray(req.query.from) ? req.query.from[0] : req.query.from;
    const toRaw = Array.isArray(req.query.to) ? req.query.to[0] : req.query.to;
    if (!fromRaw || !toRaw) {
      return res.status(400).json({ errorMessage: "from and to are required" });
    }
    const from = new Date(String(fromRaw));
    const to = new Date(String(toRaw));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ errorMessage: "Invalid date range" });
    }

    const projectIdRaw = req.query.projectId;
    const projectIdFilter =
      projectIdRaw && /^\d+$/.test(String(projectIdRaw))
        ? Number(projectIdRaw)
        : null;

    const scopedProjectIds = await getScopedProjectIds(req);

    let scopeSql = "";
    const scopeParams = [];
    let nextParam = 3;

    if (scopedProjectIds !== null) {
      if (scopedProjectIds.length === 0) {
        return res.json({ bookings: [], reservations: [] });
      }
      scopeSql = ` AND r.project_id = ANY($${nextParam}::bigint[])`;
      scopeParams.push(scopedProjectIds);
      nextParam++;
    }

    if (projectIdFilter !== null) {
      scopeSql += ` AND r.project_id = $${nextParam}`;
      scopeParams.push(projectIdFilter);
      nextParam++;
    }

    const bookingsSql = `
      SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
             b.ip_address, b.user_agent, b.referer, b.data, b.locale,
             r.name AS reservation_name, r.project_id,
             r.granularity, r.slot_duration_minutes,
             proj.name AS project_name
      FROM reservation_bookings b
      JOIN reservations r ON r.id = b.reservation_id
      JOIN projects proj ON proj.id = r.project_id
      WHERE b.starts_at >= $1 AND b.starts_at < $2${scopeSql}
      ORDER BY b.starts_at ASC
      LIMIT 5000`;

    const bookingsResult = await pool.query(bookingsSql, [
      from.toISOString(),
      to.toISOString(),
      ...scopeParams,
    ]);

    const bookings = bookingsResult.rows.map((row) => {
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
        reservationName: row.reservation_name ?? "",
        projectId: Number(row.project_id),
        projectName: row.project_name ?? "",
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
        granularity: row.granularity,
        slotDurationMinutes: row.slot_duration_minutes,
      };
    });

    // Also return the list of accessible active reservations so the
    // frontend can populate a "select reservation" dropdown for custom
    // booking creation. Build a separate scope clause with $1-based
    // placeholders since this query has no from/to params.
    let resScopeSql = "";
    const resScopeParams = [];
    let resNextParam = 1;
    if (scopedProjectIds !== null) {
      if (scopedProjectIds.length === 0) {
        return res.json({ bookings: [], reservations: [] });
      }
      resScopeSql = ` AND r.project_id = ANY($${resNextParam}::bigint[])`;
      resScopeParams.push(scopedProjectIds);
      resNextParam++;
    }
    if (projectIdFilter !== null) {
      resScopeSql += ` AND r.project_id = $${resNextParam}`;
      resScopeParams.push(projectIdFilter);
      resNextParam++;
    }
    const reservationsSql = `
      SELECT r.id, r.name, r.project_id, r.granularity,
             r.slot_duration_minutes, r.status,
             proj.name AS project_name
      FROM reservations r
      JOIN projects proj ON proj.id = r.project_id
      WHERE r.status = 'active'${resScopeSql}
      ORDER BY proj.name, r.name`;
    const reservationsResult = await pool.query(reservationsSql, resScopeParams);

    const reservations = reservationsResult.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      projectId: Number(row.project_id),
      projectName: row.project_name ?? "",
      granularity: row.granularity,
      slotDurationMinutes: row.slot_duration_minutes,
      status: row.status,
    }));

    return res.json({ bookings, reservations });
  } catch (err) {
    console.error("[submissions/bookings/calendar]", err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/submissions/bookings — admin-only custom booking creation
//
// Body: { reservationId, startsAt, endsAt }
//
// Mirrors the logic from POST /api/reservations/:id/bookings but accepts
// the reservation ID in the body instead of the URL.
// ---------------------------------------------------------------------------

const parseStrictIso = (s) => {
  if (typeof s !== "string" || s.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 19) !== s.slice(0, 19)) {
    return null;
  }
  return d;
};

const SLOT_GRID_MAX_MINUTES = 24 * 60;

router.post("/bookings", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const reservationId = parseInt(body.reservationId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservationId" });
    }

    // Verify reservation exists and load config.
    const reservationResult = await pool.query(
      `SELECT id, status, granularity, slot_duration_minutes,
              disable_hungarian_holidays
       FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (reservationResult.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    const reservation = reservationResult.rows[0];

    if (reservation.status !== "active") {
      return res.status(400).json({ errorMessage: "Reservation is not active" });
    }

    let startsAtIso;
    let endsAtIso;
    try {
      const startsAt = parseStrictIso(body.startsAt);
      const endsAt = parseStrictIso(body.endsAt);
      if (!startsAt || !endsAt) {
        return res.status(400).json({ errorMessage: "startsAt and endsAt must be ISO 8601 UTC" });
      }
      if (endsAt.getTime() <= startsAt.getTime()) {
        return res.status(400).json({ errorMessage: "endsAt must be after startsAt" });
      }
      startsAtIso = startsAt.toISOString();
      endsAtIso = endsAt.toISOString();
    } catch {
      return res.status(400).json({ errorMessage: "startsAt and endsAt must be ISO 8601 UTC" });
    }

    // Granularity alignment (same as reservation-embed.js).
    if (
      reservation.slot_duration_minutes !== null &&
      reservation.slot_duration_minutes !== undefined &&
      reservation.granularity !== "day"
    ) {
      const slot = reservation.slot_duration_minutes;
      if (slot > SLOT_GRID_MAX_MINUTES) {
        return res.status(500).json({ errorMessage: "Server misconfiguration" });
      }
      const startDate = new Date(startsAtIso);
      const startDayAnchor = Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
        0, 0, 0, 0,
      );
      const startsMs = new Date(startsAtIso).getTime();
      const offsetMin = Math.round((startsMs - startDayAnchor) / 60000);
      if (offsetMin < 0 || (offsetMin % slot) !== 0) {
        return res.status(400).json({
          errorMessage: `startsAt must align to ${slot}-minute slot boundary`,
        });
      }
      const endDate = new Date(endsAtIso);
      const endOffsetMin = Math.round((endDate.getTime() - startDayAnchor) / 60000);
      if (endOffsetMin <= 0 || (endOffsetMin % slot) !== 0) {
        return res.status(400).json({
          errorMessage: `endsAt must align to ${slot}-minute slot boundary`,
        });
      }
    }

    // Server-side availability check: disabled ranges + schedules.
    const avail = await checkSlotAvailability(
      reservationId,
      startsAtIso,
      endsAtIso,
      reservation.disable_hungarian_holidays,
    );
    if (!avail.available) {
      return res.status(400).json({ errorMessage: avail.reason });
    }

    // Atomic insert — EXCLUDE constraint catches overlaps.
    // Accept optional `data` JSONB from the body (e.g. comment/note).
    let bookingData = null;
    if (body.data && typeof body.data === "object" && Object.keys(body.data).length > 0) {
      bookingData = JSON.stringify(body.data);
    }
    const insertResult = await pool.query(
      `INSERT INTO reservation_bookings
         (reservation_id, starts_at, ends_at, ip_address, user_agent, referer, locale, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id, starts_at, ends_at, booked_at`,
      [
        reservationId,
        startsAtIso,
        endsAtIso,
        null,
        "admin-panel",
        null,
        null,
        bookingData,
      ],
    );

    const row = insertResult.rows[0];
    const result = {
      id: Number(row.id),
      reservationId,
      startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : row.starts_at,
      endsAt: row.ends_at instanceof Date ? row.ends_at.toISOString() : row.ends_at,
      bookedAt: row.booked_at instanceof Date ? row.booked_at.toISOString() : row.booked_at,
    };

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === "23P01") {
      return res.status(409).json({ errorMessage: "Slot already booked" });
    }
    console.error("[submissions/bookings/create]", err.code, err.message);
    next(err);
  }
});
