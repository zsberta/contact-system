// Admin CRUD for the Reservations module.
//
// Mirrors routes/forms.js (ADR 0009) for the operator-config columns:
//   - project_id, name, secret_token, allowed_origins, status
//   - paged list with projectId filter, search, sort whitelist
//   - server-generated secret_token at create time, immutable thereafter
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
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";
// generateHolidayRows removed: holiday rules are now per-service in
// reservation_service_holiday_rules. Holidays are checked dynamically.
import { isHungarianHoliday } from "../lib/hungarian-holidays.js";
import { checkSlotAvailability } from "../lib/reservation-availability.js";
import {
  parseStrictIso,
  SLOT_GRID_MAX_MINUTES,
  validateBookingItem,
  validateReservationContact,
  validateReservationServiceFields,
} from "../lib/booking-validation.js";
import {
  createReservationBooking,
  rowToReservationBookingDTO,
  rowToReservationCustomerDTO,
  upsertReservationCustomer,
} from "../lib/reservation-booking.js";
import { getServiceAvailability } from "../lib/reservation-availability.js";
import { notifySubmitter } from "../lib/email.js";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import path from "node:path";
import fs from "node:fs";

const isEnduser = (req) => req.user && req.user.role === "enduser";

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

// Strict ISO 8601 parse — imported from lib/booking-validation.js
// (shared with routes/reservation-embed.js so admin create + public
// submission use identical parsing rules).

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
    secretToken: row.secret_token,
    allowedOrigins,
    status: row.status,
    extraFieldsEnabled: !!row.extra_fields_enabled,
    disableHungarianHolidays: !!row.disable_hungarian_holidays,
    embedTitle: row.embed_title ?? "Időpont foglalás",
    brandColor: row.brand_color ?? "#0A2540",
    iframeWidth: row.iframe_width ?? "100%",
    iframeHeight: row.iframe_height ?? "760px",
    privacyPolicyUrl: row.privacy_policy_url ?? null,
    cookiePolicyUrl: row.cookie_policy_url ?? null,
    timezone: row.timezone ?? "UTC",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

const SORTABLE = {
  id: "id",
  name: "name",
  status: "status",
  granularity: "granularity",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

// IMPORTANT: columns must be table-qualified because the GET /:list
// SELECT joins projects p (which also exposes a `name` column); an
// unqualified `name` would trip PG `42702 ambiguous column`. Fix: see
// git history and sessions/2026-07-04-reservation-api-curl-tests.
const SEARCH_COLUMNS = ["r.name"];

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

const MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseReservationIdParam(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function startOfMonthUtc(year, month) {
  return new Date(Date.UTC(year, month, 1));
}

function startOfNextMonthUtc(year, month) {
  return new Date(Date.UTC(year, month + 1, 1));
}

function formatMonthKey(year, month) {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
}

function formatDateKey(date) {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatTimeFromIso(iso, timezone) {
  if (typeof iso !== "string") return iso;
  // Day-details sessions must display in the reservation's timezone — the
  // month grid generates Budapest-labelled slots, so a raw UTC slice here
  // made the day modal disagree with the calendar (e.g. 00:00 Budapest
  // slots stored as 22:00Z showed as "22:00" in the modal).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return formatTimeInTz(d, timezone || "UTC");
}

function calendarDayOfWeek(date) {
  return date.getUTCDay();
}

function calendarDayOfMonth(date) {
  return date.getUTCDate();
}

function matchesSchedule(schedule, date) {
  if (!schedule) return false;
  const freq = schedule.frequency;
  if (freq === "daily") return true;
  if (freq === "weekly") return Number(schedule.day_of_week) === calendarDayOfWeek(date);
  if (freq === "monthly") return Number(schedule.day_of_month) === calendarDayOfMonth(date);
  return false;
}

function collectScheduleWindows(schedules, date) {
  if (!schedules || schedules.length === 0) {
    return [{ start_time: "00:00", end_time: "24:00" }];
  }
  return schedules.filter((s) => matchesSchedule(s, date));
}

function parseTimeToMinutes(value) {
  const text = typeof value === "string" ? value.slice(0, 5) : String(value);
  const [hours, minutes] = text.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function normalizeScheduleTime(value) {
  return typeof value === "string" ? value.slice(0, 5) : String(value);
}

function buildUtcDateFromLocalParts(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month, day, hour || 0, minute || 0, 0));
}

function dayRangeForUtcDate(dateStr, tz) {
  const [yearRaw, monthRaw, dayRaw] = dateStr.split("-").map(Number);
  const year = yearRaw;
  const month = monthRaw - 1;
  const day = dayRaw;

  const startLocal = buildUtcDateFromLocalParts(year, month, day, 0, 0);
  const startOffset = getUtcOffsetMinutes(startLocal, tz);
  const startUtc = new Date(startLocal.getTime() + startOffset * 60000);

  // End = 00:00 local on the NEXT day. Computing it from the next day's
  // local midnight keeps 23/25-hour DST transition days correct; adding
  // a fixed 24h to startUtc clipped the last hour on fall-back days.
  const nextLocal = buildUtcDateFromLocalParts(year, month, day + 1, 0, 0);
  const nextOffset = getUtcOffsetMinutes(nextLocal, tz);
  const endUtc = new Date(nextLocal.getTime() + nextOffset * 60000);
  return { startUtc, endUtc };
}

function getUtcOffsetMinutes(utcReferenceDate, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const localMs = (instantMs) => {
    const parts = formatter.formatToParts(new Date(instantMs));
    const map = Object.create(null);
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = parseInt(part.value, 10);
      }
    }
    return Date.UTC(
      map.year,
      map.month - 1,
      map.day,
      map.hour === 24 ? 0 : map.hour,
      map.minute,
      map.second || 0,
    );
  };

  const targetMs = utcReferenceDate.getTime();
  let offsetMin = (targetMs - localMs(targetMs)) / 60000;

  // Round-trip verification: the chosen instant must display back as the
  // requested local wall time. Keeps DST-ambiguous slot labels honest
  // (see lib/reservation-availability.js getUtcOffsetMinutes).
  for (let i = 0; i < 2; i++) {
    const candidateMs = targetMs + offsetMin * 60000;
    const deltaMs = localMs(candidateMs) - targetMs;
    if (deltaMs === 0) break;
    offsetMin -= deltaMs / 60000;
  }
  return offsetMin;
}

async function loadReservationTimezone(reservationId, db = pool) {
  const result = await db.query(
    `SELECT timezone FROM reservations WHERE id = $1`,
    [reservationId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    timezone: row.timezone || "UTC",
  };
}

async function loadActiveReservationServices(reservationId, db = pool) {
  const result = await db.query(
    `SELECT rs.id, rs.reservation_id, rs.status, rs.sort_order, rs.duration_minutes,
            rs.price_amount, rs.currency, rs.capacity, rs.worker_user_id,
            rs.granularity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days,
            COALESCE(rst.name, 'Untitled') AS service_name,
            u.first_name AS worker_first_name, u.last_name AS worker_last_name
     FROM reservation_services rs
     LEFT JOIN reservation_service_translations rst
       ON rst.service_id = rs.id AND rst.locale = (
         SELECT default_locale FROM reservations WHERE id = rs.reservation_id
       )
     LEFT JOIN users u ON u.id = rs.worker_user_id
     WHERE rs.reservation_id = $1 AND rs.status = 'active'
     ORDER BY rs.sort_order, rs.id`,
    [reservationId],
  );
  return result.rows;
}

async function loadServiceSchedules(serviceIds, db = pool) {
  if (serviceIds.length === 0) return {};
  const result = await db.query(
    `SELECT service_id, frequency, day_of_week, day_of_month, start_time, end_time
     FROM reservation_service_availability_schedules
     WHERE service_id = ANY($1::bigint[])`,
    [serviceIds],
  );
  const map = Object.create(null);
  for (const row of result.rows) {
    if (!map[row.service_id]) map[row.service_id] = [];
    map[row.service_id].push(row);
  }
  return map;
}

async function loadReservationSchedules(reservationId, db = pool) {
  const result = await db.query(
    `SELECT frequency, day_of_week, day_of_month, start_time, end_time
     FROM reservation_availability_schedules
     WHERE reservation_id = $1`,
    [reservationId],
  );
  return result.rows;
}

async function loadDisabledRanges(reservationId, startUtc, endUtc, db = pool) {
  const result = await db.query(
    `SELECT dr.id, dr.starts_at, dr.ends_at, dr.source, dr.enabled,
            COALESCE(
              (SELECT ARRAY_AGG(drs.service_id ORDER BY drs.service_id)
               FROM reservation_disabled_range_services drs
               WHERE drs.disabled_range_id = dr.id),
              '{}'
            ) AS service_ids
     FROM reservation_disabled_ranges dr
     WHERE dr.reservation_id = $1
       AND tstzrange(dr.starts_at, dr.ends_at, '[)') &&
           tstzrange($2::timestamptz, $3::timestamptz, '[)')
       AND dr.enabled = true
     ORDER BY dr.starts_at ASC`,
    [reservationId, startUtc.toISOString(), endUtc.toISOString()],
  );
  return result.rows;
}

async function loadServiceHolidayRules(reservationId, db = pool) {
  const result = await db.query(
    `SELECT hr.service_id, hr.holiday_key, hr.enabled
     FROM reservation_service_holiday_rules hr
     JOIN reservation_services rs ON rs.id = hr.service_id
     WHERE rs.reservation_id = $1 AND hr.enabled = true`,
    [reservationId],
  );
  const map = Object.create(null);
  for (const row of result.rows) {
    if (!map[row.service_id]) map[row.service_id] = new Set();
    map[row.service_id].add(row.holiday_key);
  }
  return map;
}

function filterManualRangesForService(ranges, serviceId) {
  return ranges.filter(range => {
    const ids = range.service_ids || [];
    if (ids.length === 0) return true; // orphan = applies to all
    return ids.includes(serviceId);
  });
}

function overlapsDisabledRange(startUtc, endUtc, disabledRanges) {
  const startMs = startUtc.getTime();
  const endMs = endUtc.getTime();
  return disabledRanges.some((range) => {
    const rangeStartMs = new Date(range.starts_at).getTime();
    const rangeEndMs = new Date(range.ends_at).getTime();
    return startMs < rangeEndMs && rangeStartMs < endMs;
  });
}

// Format an instant as HH:MM wall-clock in a timezone.
function formatTimeInTz(date, timezone) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
}

function generateServiceSlotsForDate({ service, schedules, timezone, dateStr, disabledRanges, enabledHolidays, bookingsForDate }) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const windows = collectScheduleWindows(schedules, date);
  const slots = [];
  const durationMin = Number(service.duration_minutes || 0);
  const capacity = Number(service.capacity || 0);

  // Check if this date is a holiday with an enabled rule
  const [yearRaw, monthRaw, dayRaw] = dateStr.split("-").map(Number);
  const holidayKey = isHungarianHoliday(yearRaw, monthRaw, dayRaw);
  const isHolidayBlocked = holidayKey && enabledHolidays && enabledHolidays.has(holidayKey);
  if (isHolidayBlocked) return []; // entire day blocked

  for (const window of windows) {

    const windowStartMin = parseTimeToMinutes(window.start_time);
    const windowEndMin = parseTimeToMinutes(window.end_time);
    const interval = Number(service.slot_duration_minutes || durationMin || 60);

    for (let cursorMin = windowStartMin; cursorMin + durationMin <= windowEndMin; cursorMin += interval) {
      const cursorHour = Math.floor(cursorMin / 60);
      const cursorMinute = cursorMin % 60;
      const endCursorMin = cursorMin + durationMin;
      const endHour = Math.floor(endCursorMin / 60);
      const endMinute = endCursorMin % 60;

      const slotStartLocal = buildUtcDateFromLocalParts(yearRaw, monthRaw - 1, dayRaw, cursorHour, cursorMinute);
      const slotStartOffset = getUtcOffsetMinutes(slotStartLocal, timezone);
      const startUtc = new Date(slotStartLocal.getTime() + slotStartOffset * 60000);
      const endUtc = new Date(startUtc.getTime() + durationMin * 60000);
      // Skip phantom slots — local wall times that don't exist due to
      // spring-forward DST: the resolved instant displays as a different
      // wall time than the label, so the slot would be misleading.
      const startLabel = `${String(cursorHour).padStart(2, "0")}:${String(cursorMinute).padStart(2, "0")}`;
      if (formatTimeInTz(startUtc, timezone) !== startLabel) continue;

      const now = new Date();
      const leadTimeMs = Number(service.lead_time_minutes || 0) * 60000;
      if (startUtc.getTime() < now.getTime() + leadTimeMs) continue;
      if (service.max_advance_days) {
        const maxAdvanceMs = Number(service.max_advance_days) * 24 * 60 * 60 * 1000;
        if (startUtc.getTime() > now.getTime() + maxAdvanceMs) continue;
      }
      if (overlapsDisabledRange(startUtc, endUtc, disabledRanges)) continue;

      const startIso = startUtc.toISOString();
      const endIso = endUtc.toISOString();
      const overlapCount = bookingsForDate.filter((booking) => {
        const bookingStartMs = new Date(booking.starts_at).getTime();
        const bookingEndMs = new Date(booking.ends_at).getTime();
        return startUtc.getTime() < bookingEndMs && bookingStartMs < endUtc.getTime();
      }).length;

      const seatsTaken = Math.min(capacity, overlapCount);
      slots.push({
        serviceId: service.id,
        serviceName: service.service_name,
        workerUserId: service.worker_user_id != null ? Number(service.worker_user_id) : null,
        workerFirstName: service.worker_first_name || null,
        workerInitial: (service.worker_first_name || "").trim().charAt(0) || null,
        startTime: `${String(cursorHour).padStart(2, "0")}:${String(cursorMinute).padStart(2, "0")}`,
        endTime: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
        startsAt: startIso,
        endsAt: endIso,
        seatsTaken,
        capacity,
      });
    }
  }

  return slots;
}

async function loadBookingsForDate(reservationId, dateStr, tz = "UTC", db = pool) {
  const { startUtc, endUtc } = dayRangeForUtcDate(dateStr, tz);
  const result = await db.query(
    `SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at, b.data, b.locale,
            b.service_id, b.first_name, b.last_name, b.email, b.phone, b.comment,
            b.customer_id, b.created_by_user_id, b.worker_user_id,
            b.service_name_snapshot, b.duration_minutes_snapshot,
            b.price_amount_snapshot, b.currency_snapshot, b.timezone,
            b.status, b.source, b.cancellation_reason,
            COALESCE(
              rst_default.name,
              rst_fallback.name,
              b.service_name_snapshot
            ) AS service_name,
            COALESCE(wb.first_name, ws.first_name) AS worker_first_name,
            COALESCE(wb.last_name, ws.last_name) AS worker_last_name
     FROM reservation_bookings b
     LEFT JOIN reservations r ON r.id = b.reservation_id
     LEFT JOIN reservation_service_translations rst_default
       ON rst_default.service_id = b.service_id
       AND rst_default.locale = r.default_locale
     LEFT JOIN reservation_service_translations rst_fallback
       ON rst_fallback.service_id = b.service_id
       AND rst_fallback.locale = 'hu'
     LEFT JOIN users wb ON wb.id = b.worker_user_id
     LEFT JOIN reservation_services svc ON svc.id = b.service_id
     LEFT JOIN users ws ON ws.id = svc.worker_user_id
     WHERE b.reservation_id = $1
       AND b.starts_at >= $2::timestamptz
       AND b.starts_at < $3::timestamptz
     ORDER BY b.starts_at, b.id`,
    [reservationId, startUtc.toISOString(), endUtc.toISOString()],
  );
  return result.rows;
}

function aggregateActiveBookings(bookings) {
  // Include all bookings for display, but the caller uses this list
  // for both display and capacity counting. Cancelled bookings show
  // in the UI but don't consume seats.
  return bookings;
}

async function getCalendarMonthSlots({ reservationId, monthKey, db = pool }) {
  if (!monthKey || !MONTH_RE.test(monthKey)) return null;

  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;

  const reservationMeta = await loadReservationTimezone(reservationId, db);
  if (!reservationMeta) return null;

  const services = await loadActiveReservationServices(reservationId, db);
  if (services.length === 0) return { month: monthKey, slots: [] };

  const serviceIds = services.map((service) => service.id);
  const [serviceSchedulesMap, reservationSchedules, disabledRanges, holidayRules] = await Promise.all([
    loadServiceSchedules(serviceIds, db),
    loadReservationSchedules(reservationId, db),
    loadDisabledRanges(
      reservationId,
      new Date(startOfMonthUtc(year, month).getTime() - 24 * 60 * 60 * 1000),
      new Date(startOfNextMonthUtc(year, month).getTime() + 24 * 60 * 60 * 1000),
      db,
    ),
    loadServiceHolidayRules(reservationId, db),
  ]);

  const startDate = startOfMonthUtc(year, month);
  const endDate = startOfNextMonthUtc(year, month);
  const bookingsResult = await db.query(
    `SELECT b.service_id, b.starts_at, b.ends_at
     FROM reservation_bookings b
     WHERE b.reservation_id = $1
       AND b.status = 'confirmed'
       AND b.starts_at >= $2::timestamptz - interval '1 day'
       AND b.ends_at < $3::timestamptz + interval '1 day'`,
    [reservationId, startDate.toISOString(), endDate.toISOString()],
  );

  const bookingsByService = Object.create(null);
  for (const booking of bookingsResult.rows) {
    const key = Number(booking.service_id);
    if (!bookingsByService[key]) bookingsByService[key] = [];
    bookingsByService[key].push(booking);
  }

  const slots = [];
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    for (const service of services) {
      const serviceBookings = bookingsByService[Number(service.id)] || [];
      const serviceRanges = filterManualRangesForService(disabledRanges, service.id);
      const serviceHolidayKeys = holidayRules[service.id] || new Set();
      const generatedSlots = generateServiceSlotsForDate({
        service,
        schedules: serviceSchedulesMap[service.id] || reservationSchedules,
        timezone: reservationMeta.timezone,
        dateStr,
        disabledRanges: serviceRanges,
        enabledHolidays: serviceHolidayKeys,
        bookingsForDate: aggregateActiveBookings(serviceBookings),
      });

      for (const slot of generatedSlots) {
        slots.push({
          date: dateStr,
          serviceId: slot.serviceId,
          serviceName: slot.serviceName,
          workerUserId: slot.workerUserId,
          workerInitial: slot.workerInitial,
          startTime: slot.startTime,
          endTime: slot.endTime,
          seatsTaken: slot.seatsTaken,
          capacity: slot.capacity,
        });
      }
    }
  }

  return { month: monthKey, slots };
}

async function getCalendarDayDetails({ reservationId, dateStr, db = pool }) {
  if (!dateStr || !ISO_DATE_RE.test(dateStr)) return null;

  const reservationMeta = await loadReservationTimezone(reservationId, db);
  if (!reservationMeta) return null;

  const services = await loadActiveReservationServices(reservationId, db);
  const bookings = await loadBookingsForDate(reservationId, dateStr, reservationMeta.timezone || "UTC", db);
  const activeBookings = aggregateActiveBookings(bookings);
  const bookingsByService = Object.create(null);
  for (const booking of activeBookings) {
    const key = Number(booking.service_id);
    if (!bookingsByService[key]) bookingsByService[key] = [];
    bookingsByService[key].push(booking);
  }

  const serviceGroups = [];
  for (const service of services) {
    const serviceBookings = bookingsByService[Number(service.id)] || [];
    if (serviceBookings.length === 0) continue;

    const sessions = [];
    const bookingsByStart = Object.create(null);
    for (const booking of serviceBookings) {
      const startKey = booking.starts_at instanceof Date
        ? booking.starts_at.toISOString()
        : String(booking.starts_at);
      if (!bookingsByStart[startKey]) bookingsByStart[startKey] = [];
      bookingsByStart[startKey].push(booking);
    }

    for (const [startKey, groupBookings] of Object.entries(bookingsByStart)) {
      const booking = groupBookings[0];
      const startIso = booking.starts_at instanceof Date
        ? booking.starts_at.toISOString()
        : String(booking.starts_at);
      const endIso = booking.ends_at instanceof Date
        ? booking.ends_at.toISOString()
        : String(booking.ends_at);
      const overlapCount = bookingsForRange(serviceBookings, startIso, endIso);
      const capacity = Number(service.capacity || 0);

      sessions.push({
        workerFirstName: booking.worker_first_name || service.worker_first_name || null,
        workerLastName: booking.worker_last_name || service.worker_last_name || null,
        startTime: formatTimeFromIso(startIso, reservationMeta.timezone),
        endTime: formatTimeFromIso(endIso, reservationMeta.timezone),
        startsAt: startIso,
        endsAt: endIso,
        seatsTaken: Math.min(capacity, overlapCount),
        capacity,
        bookings: groupBookings.map((row) => ({
          id: Number(row.id),
          customer: {
            firstName: row.first_name || null,
            lastName: row.last_name || null,
            email: row.email || null,
            phone: row.phone || null,
          },
          status: row.status,
          cancellationReason: row.cancellation_reason || null,
        })),
      });
    }

    sessions.sort((a, b) => (a.startsAt || "").localeCompare(b.startsAt || ""));

    serviceGroups.push({
      serviceName: service.service_name,
      serviceId: Number(service.id),
      sessions,
    });
  }

  serviceGroups.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  return { date: dateStr, services: serviceGroups };
}

function bookingsForRange(bookings, startIso, endIso) {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  return bookings.filter((booking) => {
    if (booking.status === "cancelled") return false;
    const bookingStartMs = new Date(booking.starts_at).getTime();
    const bookingEndMs = new Date(booking.ends_at).getTime();
    return startMs < bookingEndMs && bookingStartMs < endMs;
  }).length;
}

function rowToCalendarSlotSummary(row) {
  return {
    date: row.date,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    workerUserId: row.workerUserId || null,
    workerInitial: row.workerInitial || null,
    startTime: row.startTime,
    endTime: row.endTime,
    seatsTaken: row.seatsTaken,
    capacity: row.capacity,
  };
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

  // slug — optional, auto-generated from name if not provided. Immutable on PUT.
  if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
    if (typeof body.slug !== "string") {
      errors.push("slug must be a string");
    } else {
      const trimmed = body.slug.trim();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed) || trimmed.length > SLUG_MAX) {
        errors.push(`slug must be lowercase kebab-case (a-z, 0-9, hyphens), max ${SLUG_MAX} chars`);
      } else {
        out.slug = trimmed;
      }
    }
  } else if (!partial) {
    // Auto-generate slug from name
    const base = (body.name || "reservation")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      .slice(0, SLUG_MAX);
    out.slug = base || `reservation-${Date.now()}`;
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

  // embedTitle — optional text, shown as heading in the public embed widget.
  if (body.embedTitle !== undefined) {
    if (body.embedTitle !== null && typeof body.embedTitle !== "string") {
      errors.push("embedTitle must be a string or null");
    } else {
      out.embed_title = body.embedTitle || "Időpont foglalás";
    }
  } else if (!partial) {
    out.embed_title = "Időpont foglalás";
  }

  // brandColor — hex color for the embed widget.
  if (body.brandColor !== undefined) {
    if (typeof body.brandColor !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(body.brandColor)) {
      errors.push("brandColor must be a valid hex color (e.g. #0A2540)");
    } else {
      out.brand_color = body.brandColor;
    }
  } else if (!partial) {
    out.brand_color = "#0A2540";
  }

  // iframeWidth — CSS width for the embed iframe.
  if (body.iframeWidth !== undefined) {
    if (typeof body.iframeWidth !== "string") {
      errors.push("iframeWidth must be a string");
    } else {
      out.iframe_width = body.iframeWidth || "100%";
    }
  } else if (!partial) {
    out.iframe_width = "100%";
  }

  // iframeHeight — CSS height for the embed iframe.
  if (body.iframeHeight !== undefined) {
    if (typeof body.iframeHeight !== "string") {
      errors.push("iframeHeight must be a string");
    } else {
      out.iframe_height = body.iframeHeight || "760px";
    }
  } else if (!partial) {
    out.iframe_height = "760px";
  }


  // privacyPolicyUrl — link to the privacy policy on the embed form.
  if (body.privacyPolicyUrl !== undefined) {
    if (body.privacyPolicyUrl !== null && typeof body.privacyPolicyUrl !== "string") {
      errors.push("privacyPolicyUrl must be a string or null");
    } else if (body.privacyPolicyUrl && !/^https?:\/\//.test(body.privacyPolicyUrl)) {
      errors.push("privacyPolicyUrl must be a valid URL (http or https)");
    } else {
      out.privacy_policy_url = body.privacyPolicyUrl || null;
    }
  }

  if (body.cookiePolicyUrl !== undefined || body.cookie_policy_url !== undefined) {
    const raw = body.cookiePolicyUrl ?? body.cookie_policy_url;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors.push("cookiePolicyUrl must be a string or null");
    } else if (raw && !/^https?:\/\//.test(raw)) {
      errors.push("cookiePolicyUrl must be a valid URL (http or https)");
    } else {
      out.cookie_policy_url = raw || null;
    }
  }

  // timezone — IANA timezone string (e.g. "Europe/Budapest").
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string") {
      errors.push("timezone must be a string");
    } else {
      const tz = body.timezone.trim();
      // Basic IANA format check: Area/City (letters, digits, underscores, hyphens, slashes)
      if (!/^[A-Za-z_]+\/[A-Za-z_]+([\/A-Za-z_]*)$/.test(tz)) {
        errors.push("timezone must be a valid IANA timezone (e.g. Europe/Budapest)");
      } else {
        out.timezone = tz;
      }
    }
  } else if (!partial) {
    out.timezone = "UTC";
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
  // Enduser scoping: only show reservations on the user's assigned projects.
  const scopedProjectIds = await getScopedProjectIds(req);
  // Only allocate a placeholder when we'll actually emit SQL. Otherwise
  // the allocator advances but the SQL has no $N to bind, which silently
  // shifts LIMIT/OFFSET to the wrong parameter index.
  const enduserScope =
    scopedProjectIds === null || scopedProjectIds === undefined
      ? { sql: "", params: [] }
      : appendProjectScope({
          placeholderIndex: allocator.next(),
          projectIds: scopedProjectIds,
          tableAlias: "r",
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
                      FROM reservations r
                      JOIN projects p ON p.id = r.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT r.id, r.project_id, p.name AS project_name,
                                  r.name, r.slug, r.secret_token, r.allowed_origins,
                                  r.status, r.granularity, r.slot_duration_minutes,
                                  r.lead_time_minutes, r.max_advance_days,
                                  r.extra_fields_enabled, r.disable_hungarian_holidays,
                                  r.embed_title, r.created_at, r.updated_at
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

// ===========================================================================
// Image upload constants (mirrors routes/blog-attachments.js exactly)
// ===========================================================================
const UPLOAD_ROOT = process.env.UPLOADS_DIR || "/app/uploads";
const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = ["image/webp", "image/png", "image/jpeg", "image/avif"];
const ALLOWED_MIME_SET = new Set(ALLOWED_MIME);
const EXT_FOR_MIME = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/avif": "avif" };
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_SET.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported image type: ${file.mimetype}`));
  },
});

// ===========================================================================
// Service CRUD routes — registered before /:id to avoid param conflicts
// ===========================================================================

// ---- GET /api/reservations/:reservationId/services ----
router.get("/:reservationId/services", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && scopedIds.length === 0) {
      return res.status(403).json({ errorMessage: "No accessible projects" });
    }
    const result = await pool.query(
      `SELECT rs.*, rst.name, rst.description,
              u.first_name AS worker_first_name, u.last_name AS worker_last_name, u.email AS worker_email,
              rsa.stored_filename AS image_stored_filename
       FROM reservation_services rs
       LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (
         SELECT default_locale FROM reservations WHERE id = rs.reservation_id
       )
       LEFT JOIN users u ON u.id = rs.worker_user_id
       LEFT JOIN reservation_service_attachments rsa ON rsa.service_id = rs.id AND rsa.purpose = 'cover'
       WHERE rs.reservation_id = $1
       ORDER BY rs.sort_order, rs.id`,
      [reservationId],
    );
    return res.json(result.rows.map(rowToServiceDTO));
  } catch (err) {
    console.error("[reservations/services/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/reservations/:reservationId/services/:serviceId ----
router.get("/:reservationId/services/:serviceId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(reservationId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ errorMessage: "Invalid ids" });
    }
    const result = await pool.query(
      `SELECT rs.*,
              rst.name, rst.description,
              u.first_name AS worker_first_name, u.last_name AS worker_last_name, u.email AS worker_email,
              rsa.stored_filename AS image_stored_filename
       FROM reservation_services rs
       LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (
         SELECT default_locale FROM reservations WHERE id = rs.reservation_id
       )
       LEFT JOIN users u ON u.id = rs.worker_user_id
       LEFT JOIN reservation_service_attachments rsa ON rsa.service_id = rs.id AND rsa.purpose = 'cover'
       WHERE rs.id = $1 AND rs.reservation_id = $2`,
      [serviceId, reservationId],
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Service not found" });
    const svc = result.rows[0];
    // Load translations
    const transResult = await pool.query(
      `SELECT locale, name, description FROM reservation_service_translations WHERE service_id = $1`,
      [serviceId],
    );
    // Load fields
    const fieldsResult = await pool.query(
      `SELECT rsf.*, json_agg(rfft.*) AS translations
       FROM reservation_service_fields rsf
       LEFT JOIN reservation_service_field_translations rfft ON rfft.field_id = rsf.id
       WHERE rsf.service_id = $1
       GROUP BY rsf.id
       ORDER BY rsf.sort_order`,
      [serviceId],
    );
    const dto = rowToServiceDTO(svc);
    dto.translations = transResult.rows;
    dto.fields = fieldsResult.rows.map((f) => ({
      id: f.id, fieldKey: f.field_key, fieldType: f.field_type,
      required: f.required, sortOrder: f.sort_order, options: f.options,
      translations: (f.translations || []).filter((t) => t.field_id != null),
    }));
    return res.json(dto);
  } catch (err) {
    console.error("[reservations/services/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/reservations/:reservationId/services ----
router.post("/:reservationId/services", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const body = req.body ?? {};
    const { status, sortOrder, durationMinutes, priceAmount, currency, capacity, workerUserId, translations, fields } = body;

    if (!durationMinutes || durationMinutes <= 0) return res.status(400).json({ errorMessage: "durationMinutes must be > 0" });
    if (priceAmount !== undefined && priceAmount < 0) return res.status(400).json({ errorMessage: "priceAmount must be >= 0" });
    if (capacity !== undefined && capacity < 1) return res.status(400).json({ errorMessage: "capacity must be >= 1" });
    if (currency && !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ errorMessage: "currency must be 3 uppercase letters" });

    // Validate worker if provided
    if (workerUserId) {
      const projResult = await pool.query(`SELECT project_id FROM reservations WHERE id = $1`, [reservationId]);
      if (projResult.rowCount === 0) return res.status(404).json({ errorMessage: "Reservation not found" });
      const projectId = projResult.rows[0].project_id;
      const wCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true AND id IN (
          SELECT user_id FROM user_project_assignments WHERE project_id = $2
        )`, [workerUserId, projectId]);
      if (wCheck.rowCount === 0) return res.status(400).json({ errorMessage: "Invalid worker: must be an active enduser assigned to this project" });
    }

    // Validate translations — default locale name required
    const reservationResult = await pool.query(`SELECT default_locale FROM reservations WHERE id = $1`, [reservationId]);
    const defaultLocale = reservationResult.rows[0]?.default_locale || "hu";
    if (!translations || typeof translations !== "object") {
      return res.status(400).json({ errorMessage: "translations is required" });
    }
    const defaultTrans = translations[defaultLocale];
    if (!defaultTrans?.name) {
      return res.status(400).json({ errorMessage: `Name is required for default locale (${defaultLocale})` });
    }

    const insertResult = await pool.query(
      `INSERT INTO reservation_services (reservation_id, status, sort_order, duration_minutes, price_amount, currency, capacity, worker_user_id,
                                          granularity, slot_duration_minutes, lead_time_minutes, max_advance_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [reservationId, status || "active", sortOrder || 0, durationMinutes, priceAmount || 0, currency || "HUF", capacity || 1, workerUserId || null,
       body.granularity || "hour", body.slotDurationMinutes ?? null, body.leadTimeMinutes ?? 60, body.maxAdvanceDays ?? 90],
    );
    const service = insertResult.rows[0];

    // Insert translations
    for (const [locale, trans] of Object.entries(translations)) {
      if (trans.name || trans.description) {
        await pool.query(
          `INSERT INTO reservation_service_translations (service_id, locale, name, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (service_id, locale) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
          [service.id, locale, trans.name || null, trans.description || null],
        );
      }
    }

    // Insert fields
    if (fields && Array.isArray(fields)) {
      for (const field of fields) {
        const fieldResult = await pool.query(
          `INSERT INTO reservation_service_fields (service_id, field_key, field_type, required, sort_order, options)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [service.id, field.fieldKey, field.fieldType || "text", field.required || false, field.sortOrder || 0, field.options ? JSON.stringify(field.options) : null],
        );
        if (field.translations) {
          for (const [locale, t] of Object.entries(field.translations)) {
            await pool.query(
              `INSERT INTO reservation_service_field_translations (field_id, locale, label, placeholder)
               VALUES ($1, $2, $3, $4)`,
              [fieldResult.rows[0].id, locale, t.label || field.fieldKey, t.placeholder || null],
            );
          }
        }
      }
    }

    return res.status(201).json(rowToServiceDTO(service));
  } catch (err) {
    console.error("[reservations/services/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/reservations/:reservationId/services/:serviceId ----
router.put("/:reservationId/services/:serviceId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(reservationId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ errorMessage: "Invalid ids" });
    }
    const body = req.body ?? {};
    const { status, sortOrder, durationMinutes, priceAmount, currency, capacity, workerUserId, translations, fields } = body;

    // Check service exists
    const existCheck = await pool.query(`SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2`, [serviceId, reservationId]);
    if (existCheck.rowCount === 0) return res.status(404).json({ errorMessage: "Service not found" });

    // Validate worker if provided
    if (workerUserId) {
      const projResult = await pool.query(`SELECT project_id FROM reservations WHERE id = $1`, [reservationId]);
      if (projResult.rowCount === 0) return res.status(404).json({ errorMessage: "Reservation not found" });
      const projectId = projResult.rows[0].project_id;
      const wCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true AND id IN (
          SELECT user_id FROM user_project_assignments WHERE project_id = $2
        )`, [workerUserId, projectId]);
      if (wCheck.rowCount === 0) return res.status(400).json({ errorMessage: "Invalid worker" });
    }

    // Update service
    const sets = [];
    const params = [];
    let pi = 1;
    if (status !== undefined) { sets.push(`status = $${pi++}`); params.push(status); }
    if (sortOrder !== undefined) { sets.push(`sort_order = $${pi++}`); params.push(sortOrder); }
    if (durationMinutes !== undefined) { sets.push(`duration_minutes = $${pi++}`); params.push(durationMinutes); }
    if (priceAmount !== undefined) { sets.push(`price_amount = $${pi++}`); params.push(priceAmount); }
    if (currency !== undefined) { sets.push(`currency = $${pi++}`); params.push(currency); }
    if (capacity !== undefined) { sets.push(`capacity = $${pi++}`); params.push(capacity); }
    if (body.granularity !== undefined) { sets.push(`granularity = $${pi++}`); params.push(body.granularity); }
    if (body.slotDurationMinutes !== undefined) { sets.push(`slot_duration_minutes = $${pi++}`); params.push(body.slotDurationMinutes ?? null); }
    if (body.leadTimeMinutes !== undefined) { sets.push(`lead_time_minutes = $${pi++}`); params.push(body.leadTimeMinutes); }
    if (body.maxAdvanceDays !== undefined) { sets.push(`max_advance_days = $${pi++}`); params.push(body.maxAdvanceDays); }
    if (workerUserId !== undefined) { sets.push(`worker_user_id = $${pi++}`); params.push(workerUserId || null); }
    if (sets.length > 0) {
      params.push(serviceId, reservationId);
      await pool.query(`UPDATE reservation_services SET ${sets.join(", ")} WHERE id = $${pi++} AND reservation_id = $${pi}`, params);
    }

    // Update translations
    if (translations && typeof translations === "object") {
      for (const [locale, trans] of Object.entries(translations)) {
        if (trans.name !== undefined || trans.description !== undefined) {
          await pool.query(
            `INSERT INTO reservation_service_translations (service_id, locale, name, description)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (service_id, locale) DO UPDATE SET name = COALESCE(EXCLUDED.name, reservation_service_translations.name), description = COALESCE(EXCLUDED.description, reservation_service_translations.description)`,
            [serviceId, locale, trans.name || null, trans.description || null],
          );
        }
      }
    }

    // Update fields (replace all)
    if (fields && Array.isArray(fields)) {
      await pool.query(`DELETE FROM reservation_service_fields WHERE service_id = $1`, [serviceId]);
      for (const field of fields) {
        const fieldResult = await pool.query(
          `INSERT INTO reservation_service_fields (service_id, field_key, field_type, required, sort_order, options)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [serviceId, field.fieldKey, field.fieldType || "text", field.required || false, field.sortOrder || 0, field.options ? JSON.stringify(field.options) : null],
        );
        if (field.translations) {
          for (const [locale, t] of Object.entries(field.translations)) {
            await pool.query(
              `INSERT INTO reservation_service_field_translations (field_id, locale, label, placeholder)
               VALUES ($1, $2, $3, $4)`,
              [fieldResult.rows[0].id, locale, t.label || field.fieldKey, t.placeholder || null],
            );
          }
        }
      }
    }

    const result = await pool.query(`SELECT * FROM reservation_services WHERE id = $1 AND reservation_id = $2`, [serviceId, reservationId]);
    return res.json(rowToServiceDTO(result.rows[0]));
  } catch (err) {
    console.error("[reservations/services/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/reservations/:reservationId/services/:serviceId ----
router.delete("/:reservationId/services/:serviceId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(reservationId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ errorMessage: "Invalid ids" });
    }
    // Check if bookings exist — archive instead of hard-delete
    const bookingCheck = await pool.query(
      `SELECT 1 FROM reservation_bookings WHERE service_id = $1 AND reservation_id = $2 LIMIT 1`,
      [serviceId, reservationId],
    );
    if (bookingCheck.rowCount > 0) {
      // Archive (disable) instead of delete
      await pool.query(
        `UPDATE reservation_services SET status = 'disabled' WHERE id = $1 AND reservation_id = $2`,
        [serviceId, reservationId],
      );
      return res.json({ message: "Service archived (disabled)" });
    }
    // Hard delete — no bookings exist
    await pool.query(`DELETE FROM reservation_service_fields WHERE service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM reservation_service_translations WHERE service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM reservation_service_attachments WHERE service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM reservation_services WHERE id = $1 AND reservation_id = $2`, [serviceId, reservationId]);
    return res.json({ message: "Service deleted" });
  } catch (err) {
    console.error("[reservations/services/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// Workers route — admin-only list of project-assigned endusers
// ===========================================================================
router.get("/:reservationId/workers", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const projResult = await pool.query(`SELECT project_id FROM reservations WHERE id = $1`, [reservationId]);
    if (projResult.rowCount === 0) return res.status(404).json({ errorMessage: "Reservation not found" });
    const projectId = projResult.rows[0].project_id;
    const result = await pool.query(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.email
       FROM users u
       JOIN user_project_assignments upa ON upa.user_id = u.id AND upa.project_id = $1
       WHERE u.role = 'enduser' AND u.enabled = true
       ORDER BY u.first_name, u.last_name`,
      [projectId],
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("[reservations/workers]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// Service image upload/delete — mirrors routes/blog-attachments.js
// ===========================================================================
router.post("/services/:serviceId/image", async (req, res, next) => {
  try {
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid service id" });
    }
    // Check service exists and user has project access
    const svcCheck = await pool.query(
      `SELECT rs.id, rs.reservation_id, r.project_id
       FROM reservation_services rs
       JOIN reservations r ON r.id = rs.reservation_id
       WHERE rs.id = $1`, [serviceId]);
    if (svcCheck.rowCount === 0) return res.status(404).json({ errorMessage: "Service not found" });
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && !scopedIds.includes(Number(svcCheck.rows[0].project_id))) {
      return res.status(403).json({ errorMessage: "Access denied" });
    }

    imageUpload.single("file")(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ errorMessage: "File exceeds 10 MB limit" });
        return res.status(400).json({ errorMessage: err.message });
      }
      if (!req.file) return res.status(400).json({ errorMessage: "No file provided" });

      const buffer = req.file.buffer;
      const sniffed = await fileTypeFromBuffer(buffer);
      if (!sniffed || !ALLOWED_MIME_SET.has(sniffed.mime)) {
        return res.status(400).json({ errorMessage: "Unsupported image type" });
      }
      const ext = EXT_FOR_MIME[sniffed.mime] || "bin";
      const storedFilename = `${crypto.randomUUID()}.${ext}`;
      const uploadDir = path.join(UPLOAD_ROOT, "reservation-services", String(serviceId));
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, storedFilename), buffer);

      // Delete old cover if exists
      await pool.query(`DELETE FROM reservation_service_attachments WHERE service_id = $1 AND purpose = 'cover'`, [serviceId]);
      // Insert new
      const insertResult = await pool.query(
        `INSERT INTO reservation_service_attachments (service_id, original_filename, stored_filename, mime_type, size_bytes, purpose, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, 'cover', $6) RETURNING *`,
        [serviceId, req.file.originalname, storedFilename, sniffed.mime, buffer.length, req.user?.id || null],
      );
      const att = insertResult.rows[0];
      const imageUrl = `/api/public/reservations/assets/${storedFilename}`;
      return res.json({ imageUrl, id: att.id, storedFilename, mimeType: att.mime_type, sizeBytes: att.size_bytes, uploadedAt: att.uploaded_at });
    });
  } catch (err) {
    console.error("[reservations/service-image/upload]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.delete("/services/:serviceId/image", async (req, res, next) => {
  try {
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid service id" });
    }
    const result = await pool.query(
      `DELETE FROM reservation_service_attachments WHERE service_id = $1 AND purpose = 'cover' RETURNING stored_filename`,
      [serviceId],
    );
    if (result.rowCount > 0) {
      const filePath = path.join(UPLOAD_ROOT, "reservation-services", String(serviceId), result.rows[0].stored_filename);
      try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }
    }
    return res.json({ message: "Image deleted" });
  } catch (err) {
    console.error("[reservations/service-image/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// Customer routes — project-scoped CRUD
// ===========================================================================
router.get("/customers", async (req, res, next) => {
  try {
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && scopedIds.length === 0) {
      return res.status(403).json({ errorMessage: "No accessible projects" });
    }
    const projectId = parseInt(req.query.projectId, 10);
    const rawQueries = req.query.queries;
    const queries = Array.isArray(rawQueries)
      ? rawQueries
      : rawQueries
        ? [rawQueries]
        : [];
    // Live search text from typing (not a chip) — merge into queries
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search && !queries.includes(search)) {
      queries.push(search);
    }
    const filterType = req.query.filterType === "all" ? "all" : "any";
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? "20", 10) || 20));

    const conditions = [];
    const params = [];
    let pi = 1;
    if (scopedIds !== null) {
      conditions.push(`rc.project_id = ANY($${pi++}::bigint[])`);
      params.push(scopedIds);
    }
    if (projectId && Number.isFinite(projectId)) {
      conditions.push(`rc.project_id = $${pi++}`);
      params.push(projectId);
    }
    const searchTerms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
    if (searchTerms.length > 0) {
      const conj = filterType === "all" ? " AND " : " OR ";
      const termClauses = searchTerms.map((term) => {
        const clause = `(rc.first_name ILIKE $${pi} OR rc.last_name ILIKE $${pi} OR rc.email ILIKE $${pi} OR rc.phone ILIKE $${pi})`;
        params.push(`%${term}%`);
        pi++;
        return clause;
      });
      conditions.push(`(${termClauses.join(conj)})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM reservation_customers rc ${where}`, params);
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / size));

    params.push(size, page * size);
    const result = await pool.query(
      `SELECT rc.*, p.name AS project_name
       FROM reservation_customers rc
       LEFT JOIN projects p ON p.id = rc.project_id
       ${where}
       ORDER BY rc.last_name, rc.first_name
       LIMIT $${pi++} OFFSET $${pi}`,
      params,
    );

    const content = result.rows.map(rowToReservationCustomerDTO);

    return res.json({
      content,
      totalElements: total,
      totalPages,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset: page * size,
        sort: { sorted: false, unsorted: true, empty: false },
      },
      numberOfElements: content.length,
      size,
      number: page,
      sort: { sorted: false, unsorted: true, empty: false },
      first: page === 0,
      last: page >= totalPages - 1,
      empty: content.length === 0,
    });
  } catch (err) {
    console.error("[reservations/customers/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.get("/customers/:customerId", async (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid customer id" });
    }
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && scopedIds.length === 0) {
      return res.status(403).json({ errorMessage: "No accessible projects" });
    }
    let query = `SELECT * FROM reservation_customers WHERE id = $1`;
    const params = [customerId];
    if (scopedIds !== null) {
      query += ` AND project_id = ANY($2::bigint[])`;
      params.push(scopedIds);
    }
    const result = await pool.query(query, params);
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Customer not found" });
    return res.json(rowToReservationCustomerDTO(result.rows[0]));
  } catch (err) {
    console.error("[reservations/customers/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.post("/customers", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const contactResult = validateReservationContact(body);
    if (!contactResult.ok) return res.status(400).json({ errorMessage: contactResult.error });
    const projectId = parseInt(body.projectId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "projectId is required" });
    }
    // Scope check: endusers may only create customers in assigned projects
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && !scopedIds.includes(projectId)) {
      return res.status(404).json({ errorMessage: "Customer not found" });
    }
    const customer = await upsertReservationCustomer({ db: pool, projectId, contact: contactResult.value });
    return res.status(201).json(rowToReservationCustomerDTO(customer));
  } catch (err) {
    console.error("[reservations/customers/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.put("/customers/:customerId", async (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid customer id" });
    }
    // Scope check: load customer and verify it belongs to an accessible project
    const scopedIds = await getScopedProjectIds(req);
    const existing = await pool.query(`SELECT * FROM reservation_customers WHERE id = $1`, [customerId]);
    if (existing.rowCount === 0) return res.status(404).json({ errorMessage: "Customer not found" });
    if (scopedIds !== null && !scopedIds.includes(Number(existing.rows[0].project_id))) {
      return res.status(404).json({ errorMessage: "Customer not found" });
    }
    const body = req.body ?? {};
    const sets = [];
    const params = [];
    let pi = 1;
    if (body.firstName !== undefined) { sets.push(`first_name = $${pi++}`); params.push(body.firstName); }
    if (body.lastName !== undefined) { sets.push(`last_name = $${pi++}`); params.push(body.lastName); }
    if (body.email !== undefined) { sets.push(`email = $${pi++}`); params.push(body.email.toLowerCase()); }
    if (body.phone !== undefined) { sets.push(`phone = $${pi++}`); params.push(body.phone); }
    if (body.status !== undefined) { sets.push(`status = $${pi++}`); params.push(body.status); }
    if (sets.length === 0) return res.status(400).json({ errorMessage: "No fields to update" });
    params.push(customerId);
    await pool.query(`UPDATE reservation_customers SET ${sets.join(", ")} WHERE id = $${pi}`, params);
    const result = await pool.query(`SELECT * FROM reservation_customers WHERE id = $1`, [customerId]);
    return res.json(rowToReservationCustomerDTO(result.rows[0]));
  } catch (err) {
    console.error("[reservations/customers/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.delete("/customers/:customerId", async (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid customer id" });
    }
    // Scope check
    const scopedIds = await getScopedProjectIds(req);
    const existing = await pool.query(`SELECT id, project_id FROM reservation_customers WHERE id = $1`, [customerId]);
    if (existing.rowCount === 0) return res.status(404).json({ errorMessage: "Customer not found" });
    if (scopedIds !== null && !scopedIds.includes(Number(existing.rows[0].project_id))) {
      return res.status(404).json({ errorMessage: "Customer not found" });
    }
    await pool.query(`DELETE FROM reservation_customers WHERE id = $1`, [customerId]);
    // FK ON DELETE SET NULL preserves all reservation_bookings rows
    return res.status(204).end();
  } catch (err) {
    console.error("[reservations/customers/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.get("/customers/:customerId/bookings", async (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid customer id" });
    }
    const scopedIds = await getScopedProjectIds(req);
    if (scopedIds !== null && scopedIds.length === 0) {
      return res.status(403).json({ errorMessage: "No accessible projects" });
    }
    // Verify customer belongs to an accessible project
    let custQuery = `SELECT id FROM reservation_customers WHERE id = $1`;
    const custParams = [customerId];
    if (scopedIds !== null) {
      custQuery += ` AND project_id = ANY($2::bigint[])`;
      custParams.push(scopedIds);
    }
    const custCheck = await pool.query(custQuery, custParams);
    if (custCheck.rowCount === 0) return res.status(404).json({ errorMessage: "Customer not found" });

    const result = await pool.query(
      `SELECT rb.*,
              COALESCE(rst.name, rb.service_name_snapshot) AS service_name,
              r.name AS reservation_name,
              p.name AS project_name,
              u.first_name AS worker_first_name, u.last_name AS worker_last_name
       FROM reservation_bookings rb
       LEFT JOIN reservation_service_translations rst ON rst.service_id = rb.service_id AND rst.locale = 'hu'
       LEFT JOIN reservations r ON r.id = rb.reservation_id
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN users u ON u.id = rb.worker_user_id
       WHERE rb.customer_id = $1
       ORDER BY rb.starts_at DESC`,
      [customerId],
    );
    return res.json(result.rows.map(rowToReservationBookingDTO));
  } catch (err) {
    console.error("[reservations/customers/bookings]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// Admin service availability — returns available slots for a service on a date
// ===========================================================================
router.get("/:reservationId/services/:serviceId/availability", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.reservationId, 10);
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid service id" });
    }
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ errorMessage: "from and to query parameters are required (YYYY-MM-DD)" });
    }
    const result = await getServiceAvailability({
      reservationId,
      serviceId,
      fromDate: String(from),
      toDate: String(to),
    });
    if (!result) {
      return res.status(404).json({ errorMessage: "Service not found" });
    }
    return res.json(result);
  } catch (err) {
    console.error("[reservations/service-availability]", err.code, err.message);
    next(err);
  }
});

// ===========================================================================
// Service availability schedule routes — mirrors reservation schedule routes
// ===========================================================================
router.get("/:reservationId/services/:serviceId/availability-schedules", async (req, res, next) => {
  try {
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid service id" });
    }
    const result = await pool.query(
      `SELECT * FROM reservation_service_availability_schedules WHERE service_id = $1 ORDER BY frequency, day_of_week, day_of_month, start_time`,
      [serviceId],
    );
    return res.json(result.rows.map(rowToServiceScheduleDTO));
  } catch (err) {
    console.error("[reservations/service-schedules/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.post("/:reservationId/services/:serviceId/availability-schedules", async (req, res, next) => {
  try {
    const serviceId = parseInt(req.params.serviceId, 10);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid service id" });
    }
    const body = req.body ?? {};
    const { frequency, dayOfWeek, dayOfMonth, startTime, endTime } = body;
    if (!FREQUENCY_VALUES.has(frequency)) return res.status(400).json({ errorMessage: "Invalid frequency" });
    if (!startTime || !endTime) return res.status(400).json({ errorMessage: "startTime and endTime are required" });
    if (frequency === "weekly" && (dayOfWeek === undefined || dayOfWeek === null)) return res.status(400).json({ errorMessage: "dayOfWeek required for weekly" });
    if (frequency === "monthly" && (dayOfMonth === undefined || dayOfMonth === null)) return res.status(400).json({ errorMessage: "dayOfMonth required for monthly" });

    const result = await pool.query(
      `INSERT INTO reservation_service_availability_schedules (service_id, frequency, day_of_week, day_of_month, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [serviceId, frequency, dayOfWeek || null, dayOfMonth || null, startTime, endTime],
    );
    return res.status(201).json(rowToServiceScheduleDTO(result.rows[0]));
  } catch (err) {
    console.error("[reservations/service-schedules/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.delete("/:reservationId/services/:serviceId/availability-schedules/:scheduleId", async (req, res, next) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId, 10);
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid schedule id" });
    }
    await pool.query(`DELETE FROM reservation_service_availability_schedules WHERE id = $1`, [scheduleId]);
    return res.json({ message: "Schedule deleted" });
  } catch (err) {
    console.error("[reservations/service-schedules/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

router.put("/:reservationId/services/:serviceId/availability-schedules/:scheduleId", async (req, res, next) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId, 10);
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid schedule id" });
    }
    const body = req.body ?? {};
    const { frequency, dayOfWeek, dayOfMonth, startTime, endTime } = body;
    const sets = [];
    const params = [];
    let pi = 1;
    if (frequency !== undefined) { sets.push(`frequency = $${pi++}`); params.push(frequency); }
    if (dayOfWeek !== undefined) { sets.push(`day_of_week = $${pi++}`); params.push(dayOfWeek); }
    if (dayOfMonth !== undefined) { sets.push(`day_of_month = $${pi++}`); params.push(dayOfMonth); }
    if (startTime !== undefined) { sets.push(`start_time = $${pi++}`); params.push(startTime); }
    if (endTime !== undefined) { sets.push(`end_time = $${pi++}`); params.push(endTime); }
    if (sets.length > 0) {
      params.push(scheduleId);
      await pool.query(`UPDATE reservation_service_availability_schedules SET ${sets.join(", ")} WHERE id = $${pi}`, params);
    }
    const result = await pool.query(`SELECT * FROM reservation_service_availability_schedules WHERE id = $1`, [scheduleId]);
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Schedule not found" });
    return res.json(rowToServiceScheduleDTO(result.rows[0]));
  } catch (err) {
    console.error("[reservations/service-schedules/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// Service schedule DTO helper
// ===========================================================================
function rowToServiceScheduleDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    serviceId: row.service_id,
    frequency: row.frequency,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    startTime: typeof row.start_time === "string" ? row.start_time.slice(0, 5) : row.start_time,
    endTime: typeof row.end_time === "string" ? row.end_time.slice(0, 5) : row.end_time,
    createdAt: row.created_at,
  };
}

// ===========================================================================
// Service DTO helper
// ===========================================================================
function rowToServiceDTO(row) {
  if (!row) return null;
  const imageUrl = row.image_stored_filename
    ? `/api/public/reservations/assets/${row.image_stored_filename}`
    : null;
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    status: row.status,
    sortOrder: row.sort_order,
    durationMinutes: row.duration_minutes,
    priceAmount: row.price_amount != null ? Number(row.price_amount) : 0,
    currency: row.currency,
    capacity: row.capacity,
    granularity: row.granularity || "hour",
    slotDurationMinutes: row.slot_duration_minutes ?? null,
    leadTimeMinutes: row.lead_time_minutes ?? 60,
    maxAdvanceDays: row.max_advance_days ?? 90,
    workerUserId: row.worker_user_id != null ? Number(row.worker_user_id) : null,
    workerFirstName: row.worker_first_name || null,
    workerLastName: row.worker_last_name || null,
    name: row.name || null,
    description: row.description || null,
    imageUrl,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Disable settings — service-scoped holiday policy + range management.
//
// GET    /:id/disable-settings               — read services + ranges
// PUT    /:id/disable-settings/holidays       — set auto-disable-holiday per service
//
// Registered BEFORE /:id catch-all routes so Express matches them first.
// ---------------------------------------------------------------------------

// ---- GET /api/reservations/:id/disable-settings ----
router.get("/:id/disable-settings", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1", [reservationId]);
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id)) : false;
      if (!allowed) return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    // Load services with worker info
    const servicesResult = await pool.query(
      `SELECT rs.id, rs.worker_user_id,
              COALESCE(rst.name, 'Untitled') AS name,
              u.first_name AS worker_first_name, u.last_name AS worker_last_name
       FROM reservation_services rs
       LEFT JOIN reservation_service_translations rst
         ON rst.service_id = rs.id AND rst.locale = (
           SELECT default_locale FROM reservations WHERE id = rs.reservation_id)
       LEFT JOIN users u ON u.id = rs.worker_user_id
       WHERE rs.reservation_id = $1 AND rs.status = 'active'
       ORDER BY rs.sort_order, rs.id`,
      [reservationId]);
    // Load holiday rules per service
    const rulesResult = await pool.query(
      `SELECT hr.service_id, hr.holiday_key, hr.enabled
       FROM reservation_service_holiday_rules hr
       JOIN reservation_services rs ON rs.id = hr.service_id
       WHERE rs.reservation_id = $1`,
      [reservationId]);
    const holidayRulesByService = Object.create(null);
    for (const row of rulesResult.rows) {
      if (!holidayRulesByService[row.service_id]) holidayRulesByService[row.service_id] = [];
      holidayRulesByService[row.service_id].push({ key: row.holiday_key, enabled: !!row.enabled });
    }
    // Load manual ranges with service associations
    const rangesResult = await pool.query(
      `SELECT dr.id, dr.starts_at, dr.ends_at, dr.reason, dr.source, dr.enabled, dr.created_at,
              COALESCE(
                (SELECT ARRAY_AGG(drs.service_id ORDER BY drs.service_id)
                 FROM reservation_disabled_range_services drs
                 WHERE drs.disabled_range_id = dr.id),
                '{}'
              ) AS service_ids
       FROM reservation_disabled_ranges dr
       WHERE dr.reservation_id = $1 AND dr.source = 'manual'
       ORDER BY dr.starts_at ASC`,
      [reservationId]);
    const services = servicesResult.rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      workerUserId: row.worker_user_id != null ? Number(row.worker_user_id) : null,
      workerFirstName: row.worker_first_name || null,
      workerLastName: row.worker_last_name || null,
      holidayRules: holidayRulesByService[row.id] || [],
    }));
    const disabledRanges = rangesResult.rows.map(row => ({
      id: Number(row.id),
      reservationId,
      startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : row.starts_at,
      endsAt: row.ends_at instanceof Date ? row.ends_at.toISOString() : row.ends_at,
      reason: row.reason ?? null,
      source: row.source ?? "manual",
      enabled: row.enabled !== false,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      serviceIds: row.service_ids || [],
    }));
    return res.json({ services, disabledRanges });
  } catch (err) {
    console.error("[reservations/disable-settings/get]", err.code, err.message);
    next(err);
  }
});

// ---- PUT /api/reservations/:id/disable-settings/holidays ----
// Body: { serviceId: number, rules: Array<{ key: string, enabled: boolean }> }
router.put("/:id/disable-settings/holidays", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1", [reservationId]);
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id)) : false;
      if (!allowed) return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    const body = req.body ?? {};
    const { serviceId, rules } = body;
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ errorMessage: "serviceId must be a positive integer" });
    }
    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({ errorMessage: "rules must be a non-empty array" });
    }
    // Validate service belongs to this reservation
    const svcCheck = await pool.query(
      `SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2`,
      [serviceId, reservationId]);
    if (svcCheck.rowCount === 0) {
      return res.status(400).json({ errorMessage: "Invalid service ID for this reservation" });
    }
    // Upsert each rule
    for (const rule of rules) {
      if (typeof rule.key !== "string" || !rule.key || typeof rule.enabled !== "boolean") continue;
      await pool.query(
        `INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (service_id, holiday_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [serviceId, rule.key, rule.enabled]);
    }
    // Return updated rules
    const updated = await pool.query(
      `SELECT holiday_key, enabled FROM reservation_service_holiday_rules
       WHERE service_id = $1 ORDER BY holiday_key`,
      [serviceId]);
    return res.json({ serviceId, rules: updated.rows.map(r => ({ key: r.holiday_key, enabled: r.enabled })) });
  } catch (err) {
    console.error("[reservations/disable-settings/holidays]", err.code, err.message);
    next(err);
  }
});

// ---- GET /api/reservations/:id ----
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    // We need the project_id of this reservation to check membership.
    // One cheap SELECT ahead of the JOINed SELECT keeps the main query
    // simple.
    const pre = await pool.query(
      `SELECT project_id FROM reservations WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name,
              r.name, r.slug, r.secret_token, r.allowed_origins,
              r.status,
              r.extra_fields_enabled, r.disable_hungarian_holidays,
              r.embed_title, r.brand_color, r.iframe_width, r.iframe_height,
              r.privacy_policy_url, r.cookie_policy_url,
              r.timezone,
              r.created_at, r.updated_at
       FROM reservations r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1`
      , [id],
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
    // Create or reuse the project_module registry row for this project's reservation.
    const { rows: pmRows } = await pool.query(
      `INSERT INTO project_modules (project_id, module_type)
       VALUES ($1, 'reservation')
       ON CONFLICT (project_id, module_type) DO NOTHING
       RETURNING id`,
      [v.project_id],
    );
    let moduleId;
    if (pmRows.length > 0) {
      moduleId = pmRows[0].id;
    } else {
      const { rows: existing } = await pool.query(
        `SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'reservation'`,
        [v.project_id],
      );
      moduleId = existing[0].id;
    }

    const insertResult = await pool.query(
      `INSERT INTO reservations
        (project_id, module_id, name, slug, secret_token, allowed_origins, status,
         extra_fields_enabled, embed_title,
         brand_color, iframe_width, iframe_height,
         privacy_policy_url, cookie_policy_url, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        v.project_id,
        moduleId,
        v.name,
        v.slug,
        secretToken,
        Array.isArray(v.allowed_origins) ? v.allowed_origins : [],
        v.status ?? "active",
        !!v.extra_fields_enabled,
        v.embed_title ?? "Időpont foglalás",
        v.brand_color ?? "#0A2540",
        v.iframe_width ?? "100%",
        v.iframe_height ?? "760px",
        v.privacy_policy_url || null,
        v.cookie_policy_url || null,
        v.timezone || "UTC",
      ],
    );
    const newId = Number(insertResult.rows[0].id);
    // Re-read with the project name joined so the DTO shape is identical
    // to GET /:id. Without the join the row would have project_name=null.
    const { rows: joined } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name,
              r.name, r.slug, r.secret_token, r.allowed_origins,
              r.status,
              r.extra_fields_enabled, r.disable_hungarian_holidays,
              r.embed_title, r.brand_color, r.iframe_width, r.iframe_height,
              r.privacy_policy_url, r.cookie_policy_url,
              r.timezone,
              r.created_at, r.updated_at
       FROM reservations r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1`
      , [newId],
    );
    return res.status(201).json(rowToReservationDTO(joined[0]));
  } catch (err) {
    // 23505 = unique_violation. For slug, return 409 with the user-facing
    // message; for module_id (one reservation per project), return PROJECT_MODULE_EXISTS.
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("slug")) {
        return res.status(409).json({ errorMessage: "Slug already in use" });
      }
      if (constraint.includes("module_id")) {
        return res.status(409).json({
          errorMessage: "A module of this type already exists for this project",
          errorCode: "PROJECT_MODULE_EXISTS",
        });
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
              r.status,
              r.extra_fields_enabled, r.disable_hungarian_holidays,
              r.embed_title, r.brand_color, r.iframe_width, r.iframe_height,
              r.privacy_policy_url, r.cookie_policy_url,
              r.timezone,
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
    const { rows } = await pool.query(
      `DELETE FROM reservations WHERE id = $1 RETURNING module_id`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    // Clean up the registry row (one-per-project, so always safe to remove).
    const moduleId = rows[0].module_id;
    if (moduleId) {
      await pool.query(`DELETE FROM project_modules WHERE id = $1`, [moduleId]);
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
      `SELECT name, secret_token, allowed_origins, iframe_width, iframe_height
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
    const embedUrl = `${origin}/embed/reservations/${r.secret_token}`;
    const iframeWidth = r.iframe_width || "100%";
    const iframeHeight = r.iframe_height || "760px";
    const snippet = `<!-- CMS Reservation "${r.name}" -->
<iframe src="${embedUrl}" title="${r.name}" loading="lazy" style="width:${iframeWidth};min-height:${iframeHeight};border:0" allow="clipboard-write"></iframe>`;
    return res.json({
      html: snippet,
      embedUrl,
      secretToken: r.secret_token,
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
  "serviceName",
  "customerName",
  "workerFirstName",
  "status",
]);
const BOOKING_SORT_COLUMN_MAP = {
  startsAt: "starts_at",
  endsAt: "ends_at",
  bookedAt: "booked_at",
  serviceName: "COALESCE(rst.name, b.service_name_snapshot)",
  customerName: "COALESCE(COALESCE(rc.last_name, b.last_name) || ' ' || COALESCE(rc.first_name, b.first_name), '')",
  workerFirstName: "COALESCE(COALESCE(wb.last_name, ws.last_name) || ' ' || COALESCE(wb.first_name, ws.first_name), '')",
  status: "b.status",
};

// ---------------------------------------------------------------------------
// Date/time matching for bookings search.
//
// Tries every plausible user input format and returns SQL conditions +
// params when matched, or null when the term isn't recognisable as a
// date/time pattern.  Each returned condition is wrapped in parens so it
// composes cleanly with the text-ILIKE clause via AND.
//
// Supported patterns (case-insensitive, leading/trailing whitespace ok):
//   17                → day of month (any month)
//   08.17 / 08-17     → month.day  (US style)
//   17.08 / 17-08     → day.month  (EU style)
//   17. / .17         → day of month
//   08.2026 / 08/2026 → month.year
//   17:00             → exact hour:minute
//   17-18 / 17..18    → hour range (inclusive, wraps midnight)
//   14:00-15:00       → time range (inclusive, wraps midnight)
//   aug / august      → month name
//   jan-dec           → month name
// ---------------------------------------------------------------------------
const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// All EXTRACTs use AT TIME ZONE 'Europe/Budapest' so the user sees local
// time, matching what the UI displays.  DB stores UTC timestamps.
const TZ = "'Europe/Budapest'";
const startsLocal = `b.starts_at AT TIME ZONE ${TZ}`;
const hExpr = `EXTRACT(HOUR FROM ${startsLocal})`;
const mExpr = `EXTRACT(MINUTE FROM ${startsLocal})`;
const dayExpr = `EXTRACT(DAY FROM ${startsLocal})`;
const monthExpr = `EXTRACT(MONTH FROM ${startsLocal})`;
const yearExpr = `EXTRACT(YEAR FROM ${startsLocal})`;
const minuteOfDay = `${hExpr}*60+${mExpr}`;

function buildBookingsDateConditions(term, pos) {
  const t = term.trim().toLowerCase();

  // --- Month name → match any day in that month ---
  const mName = MONTH_NAMES[t];
  if (mName !== undefined) {
    return {
      sql: `(${monthExpr} = $${pos})`,
      params: [mName],
    };
  }

  // --- Time range: HH:MM-HH:MM  or  HH:MM..HH:MM ---
  const tr = t.match(/^(\d{1,2}):(\d{2})\s*(?:[-]{1,2}|[.]{2})\s*(\d{1,2}):(\d{2})$/);
  if (tr) {
    const sh = +tr[1], sm = +tr[2], eh = +tr[3], em = +tr[4];
    if (sh >= 0 && sh < 24 && eh >= 0 && eh < 24 && sm >= 0 && sm < 60 && em >= 0 && em < 60) {
      if (sh <= eh) {
        return {
          sql: `(${minuteOfDay} >= $${pos} AND ${minuteOfDay} <= $${pos + 1})`,
          params: [sh * 60 + sm, eh * 60 + em],
        };
      } else {
        // wraps midnight: 22:00-06:00
        return {
          sql: `(${minuteOfDay} >= $${pos} OR ${minuteOfDay} <= $${pos + 1})`,
          params: [sh * 60 + sm, eh * 60 + em],
        };
      }
    }
  }

  // --- Hour range: HH-HH  or  HH..HH ---
  const hr = t.match(/^(\d{1,2})\s*(?:[-]{1,2}|[.]{2})\s*(\d{1,2})$/);
  if (hr) {
    const sh = +hr[1], eh = +hr[2];
    if (sh >= 0 && sh < 24 && eh >= 0 && eh < 24 && sh !== eh) {
      if (sh < eh) {
        return {
          sql: `(${hExpr} >= $${pos} AND ${hExpr} < $${pos + 1})`,
          params: [sh, eh],
        };
      } else {
        // wraps midnight: 22-6
        return {
          sql: `(${hExpr} >= $${pos} OR ${hExpr} < $${pos + 1})`,
          params: [sh, eh],
        };
      }
    }
  }

  // --- Time: HH:MM ---
  const tm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (tm) {
    const h = +tm[1], m = +tm[2];
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return {
        sql: `(${hExpr} = $${pos} AND ${mExpr} = $${pos + 1})`,
        params: [h, m],
      };
    }
  }

  // --- Month/year: MM.YYYY  or  MM-YYYY  or  MM/YYYY ---
  const my = t.match(/^(\d{1,2})\s*[.\-/]\s*(\d{4})$/);
  if (my) {
    const m = +my[1], y = +my[2];
    if (m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
      return {
        sql: `(${monthExpr} = $${pos} AND ${yearExpr} = $${pos + 1})`,
        params: [m, y],
      };
    }
  }

  // --- Month/day: MM.DD / MM-DD  (US) ---
  const md = t.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})$/);
  if (md) {
    const m = +md[1], d = +md[2];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return {
        sql: `(${monthExpr} = $${pos} AND ${dayExpr} = $${pos + 1})`,
        params: [m, d],
      };
    }
  }

  // --- Day/month: DD.MM / DD-MM  (EU) ---
  const dm = t.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})$/);
  if (dm) {
    const d = +dm[1], m = +dm[2];
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return {
        sql: `(${dayExpr} = $${pos} AND ${monthExpr} = $${pos + 1})`,
        params: [d, m],
      };
    }
  }

  // --- Day with dot/slash: 17. or .17 ---
  const dd = t.match(/^\.?(\d{1,2})\.?$/);
  if (dd) {
    const d = +dd[1];
    if (d >= 1 && d <= 31) {
      return {
        sql: `(${dayExpr} = $${pos})`,
        params: [d],
      };
    }
  }

  return null;
}

function buildBookingsWhere({ queries = [], filterType = "any" }, baseIndex = 2) {
  const terms = queries.filter((q) => typeof q === "string" && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const clauses = [];
  const params = [];
  let paramOffset = 0;
  for (let i = 0; i < terms.length; i++) {
    const pos = baseIndex + paramOffset;
    // Try date/time pattern matching first
    const dateCond = buildBookingsDateConditions(terms[i], pos);
    if (dateCond) {
      clauses.push(dateCond.sql);
      params.push(...dateCond.params);
      paramOffset += dateCond.params.length;
    } else {
      // Fallback: text ILIKE across service name, customer name, email, phone, worker name, and data blob.
      const pattern = `%${terms[i].replace(/[%_]/g, (m) => "\\" + m)}%`;
      clauses.push(
        "(COALESCE(rst.name, b.service_name_snapshot) ILIKE $" + pos +
        " OR b.first_name ILIKE $" + pos +
        " OR b.last_name ILIKE $" + pos +
        " OR b.email ILIKE $" + pos +
        " OR b.phone ILIKE $" + pos +
        " OR COALESCE(wb.first_name, ws.first_name) ILIKE $" + pos +
        " OR COALESCE(wb.last_name, ws.last_name) ILIKE $" + pos +
        " OR b.data::text ILIKE $" + pos + ")",
      );
      params.push(pattern);
      paramOffset += 1;
    }
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

// ===========================================================================
// Reservation calendar helpers — month summary + lazy day details
// ===========================================================================

// ---- GET /api/reservations/:reservationId/calendar?month=YYYY-MM ----
router.get("/:reservationId/calendar", async (req, res, next) => {
  try {
    const reservationId = parseReservationIdParam(req.params.reservationId);
    if (reservationId === null) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    const month = typeof req.query.month === "string" ? req.query.month.trim() : "";
    if (!month || !MONTH_RE.test(month)) {
      return res.status(400).json({ errorMessage: "month query parameter is required in YYYY-MM format" });
    }

    const preCheck = await pool.query(
      `SELECT id, project_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (preCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(preCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const result = await getCalendarMonthSlots({ reservationId, monthKey: month });
    if (!result) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }

    let slots = result.slots.map(rowToCalendarSlotSummary);

    // Filter: hide empty slots (seatsTaken === 0)
    if (req.query.hideEmpty === "true") {
      slots = slots.filter((slot) => slot.seatsTaken > 0);
    }

    // Filter: only show slots for a specific worker
    const workerIdParam = parseInt(req.query.workerId, 10);
    if (Number.isFinite(workerIdParam) && workerIdParam > 0) {
      slots = slots.filter((slot) => slot.workerUserId === workerIdParam);
    }

    return res.json({
      month: result.month,
      slots,
    });
  } catch (err) {
    console.error("[reservations/calendar/month]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/reservations/:reservationId/calendar/:date ----
router.get("/:reservationId/calendar/:date", async (req, res, next) => {
  try {
    const reservationId = parseReservationIdParam(req.params.reservationId);
    if (reservationId === null) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    const dateStr = typeof req.params.date === "string" ? req.params.date.trim() : "";
    if (!dateStr || !ISO_DATE_RE.test(dateStr)) {
      return res.status(400).json({ errorMessage: "date path parameter must be YYYY-MM-DD" });
    }

    const preCheck = await pool.query(
      `SELECT id, project_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (preCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(preCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const result = await getCalendarDayDetails({ reservationId, dateStr });
    if (!result) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }

    return res.json(result);
  } catch (err) {
    console.error("[reservations/calendar/day]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

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
    // Live search text from typing (not a chip) — merge into queries
    const searchText = typeof req.query.searchText === "string" && req.query.searchText.trim()
      ? req.query.searchText.trim()
      : null;
    if (searchText && !queries.includes(searchText)) {
      queries.push(searchText);
    }
    const filterType = req.query.filterType === "all" ? "all" : "any";

    // Verify the reservation exists so we 404 instead of returning [].
    // Enduser scope: refuse upfront if the reservation is on a project
    // the user isn't assigned to. The 404 is fine here — it doesn't
    // reveal whether the reservation exists for someone else.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const where = buildBookingsWhere({ queries, filterType }, 2);
    const col = BOOKING_SORT_COLUMN_MAP[sortField] ?? "booked_at";
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    const orderSql = `ORDER BY ${col} ${dir}, id DESC`;

    const dataParams = [reservationId, ...where.params, size, page * size];
    const limitParam = dataParams.length - 1;
    const offsetParam = dataParams.length;

    const dataSql = `SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
                            b.ip_address, b.user_agent, b.referer, b.data, b.locale,
                            b.service_id, b.first_name, b.last_name, b.email, b.phone, b.comment,
                            b.customer_id, b.created_by_user_id, b.worker_user_id,
                            b.service_name_snapshot, b.duration_minutes_snapshot,
                            b.price_amount_snapshot, b.currency_snapshot, b.timezone,
                            b.status, b.source,
                            b.cancelled_at, b.cancelled_by_user_id, b.cancellation_reason,
                            COALESCE(rst.name, b.service_name_snapshot) AS service_name,
                            rc.first_name AS customer_first_name, rc.last_name AS customer_last_name,
                            rc.email AS customer_email, rc.phone AS customer_phone,
                            COALESCE(wb.first_name, ws.first_name) AS worker_first_name,
                            COALESCE(wb.last_name, ws.last_name) AS worker_last_name
                     FROM reservation_bookings b
                     LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu'
                     LEFT JOIN reservation_customers rc ON rc.id = b.customer_id
                     LEFT JOIN users wb ON wb.id = b.worker_user_id
                     LEFT JOIN reservation_services svc ON svc.id = b.service_id
                     LEFT JOIN users ws ON ws.id = svc.worker_user_id
                     WHERE b.reservation_id = $1${where.sql}
                     ${orderSql}
                     LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, dataParams);

    const countSql = `SELECT COUNT(*)::bigint AS total
                      FROM reservation_bookings b
                      LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu'
                      LEFT JOIN users wb ON wb.id = b.worker_user_id
                      LEFT JOIN reservation_services svc ON svc.id = b.service_id
                      LEFT JOIN users ws ON ws.id = svc.worker_user_id
                      WHERE b.reservation_id = $1${where.sql}`;
    const countResult = await pool.query(countSql, [reservationId, ...where.params]);
    const totalElements = Number(countResult.rows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalElements / size));

    const content = dataResult.rows.map(rowToReservationBookingDTO);
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
    // Enduser scope: check the parent reservation's project, not the
    // booking row. The 404 must be identical to "booking not found" so
    // an enduser can't probe existence of bookings on unassigned
    // reservations.
    if (isEnduser(req)) {
      const pre = await pool.query(
        `SELECT r.project_id FROM reservations r WHERE r.id = $1`,
        [reservationId],
      );
      if (pre.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }
    }
    const { rows, rowCount } = await pool.query(
      `SELECT b.id, b.reservation_id, b.starts_at, b.ends_at, b.booked_at,
              b.ip_address, b.user_agent, b.referer, b.data, b.locale,
              b.service_id, b.first_name, b.last_name, b.email, b.phone, b.comment,
              b.customer_id, b.created_by_user_id, b.worker_user_id,
              b.service_name_snapshot, b.duration_minutes_snapshot,
              b.price_amount_snapshot, b.currency_snapshot, b.timezone,
              b.status, b.source,
              b.cancelled_at, b.cancelled_by_user_id, b.cancellation_reason,
              COALESCE(rst.name, b.service_name_snapshot) AS service_name,
              rc.first_name AS customer_first_name, rc.last_name AS customer_last_name,
              rc.email AS customer_email, rc.phone AS customer_phone,
              COALESCE(wb.first_name, ws.first_name) AS worker_first_name,
              COALESCE(wb.last_name, ws.last_name) AS worker_last_name
       FROM reservation_bookings b
       LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu'
       LEFT JOIN reservation_customers rc ON rc.id = b.customer_id
       LEFT JOIN users wb ON wb.id = b.worker_user_id
       LEFT JOIN reservation_services svc ON svc.id = b.service_id
       LEFT JOIN users ws ON ws.id = svc.worker_user_id
       WHERE b.reservation_id = $1 AND b.id = $2`,
      [reservationId, bookingId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Booking not found" });
    }
    return res.json(rowToReservationBookingDTO(rows[0]));
  } catch (err) {
    console.error("[reservations/bookings/get]", err.code, err.message);
    next(err);
  }
});

// ---- PATCH /api/reservations/:id/bookings/:bookingId — status update ----
router.patch("/:id/bookings/:bookingId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const bookingId = parseInt(req.params.bookingId, 10);
    if (!Number.isFinite(reservationId) || !Number.isFinite(bookingId)) {
      return res.status(400).json({ errorMessage: "Invalid ids" });
    }
    const body = req.body ?? {};
    const VALID_STATUSES = new Set(["confirmed", "cancelled", "completed", "no_show", "attended"]);
    if (!body.status || !VALID_STATUSES.has(body.status)) {
      return res.status(400).json({ errorMessage: "Invalid status" });
    }

    // Load booking
    const bookingResult = await pool.query(
      `SELECT rb.*, rs.worker_user_id AS svc_worker_user_id
       FROM reservation_bookings rb
       LEFT JOIN reservation_services rs ON rs.id = rb.service_id
       WHERE rb.reservation_id = $1 AND rb.id = $2`,
      [reservationId, bookingId],
    );
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Booking not found" });
    }
    const booking = bookingResult.rows[0];

    // Enduser scope check
    if (isEnduser(req)) {
      const pre = await pool.query(`SELECT project_id FROM reservations WHERE id = $1`, [reservationId]);
      if (pre.rowCount === 0 || !req.user.projectIds?.includes(Number(pre.rows[0].project_id))) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }
    }

    const sets = [`status = $1`];
    const params = [body.status];
    let pi = 2;
    if (body.status === "cancelled") {
      sets.push(`cancelled_at = NOW()`);
      sets.push(`cancelled_by_user_id = $${pi++}`);
      params.push(req.user?.id || null);
      if (body.cancellationReason) {
        sets.push(`cancellation_reason = $${pi++}`);
        params.push(body.cancellationReason);
      }
    }
    params.push(bookingId);
    await pool.query(`UPDATE reservation_bookings SET ${sets.join(", ")} WHERE id = $${pi}`, params);

    const updated = await pool.query(
      `SELECT * FROM reservation_bookings WHERE id = $1`, [bookingId]);
    return res.json(rowToReservationBookingDTO(updated.rows[0]));
  } catch (err) {
    console.error("[reservations/bookings/status]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/reservations/:id/bookings/:bookingId — hard delete ----
router.delete("/:id/bookings/:bookingId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const bookingId = parseInt(req.params.bookingId, 10);
    if (!Number.isFinite(reservationId) || !Number.isFinite(bookingId)) {
      return res.status(400).json({ errorMessage: "Invalid ids" });
    }

    // Load booking with reservation/project ownership
    const bookingResult = await pool.query(
      `SELECT rb.*, r.project_id
       FROM reservation_bookings rb
       JOIN reservations r ON r.id = rb.reservation_id
       WHERE rb.reservation_id = $1 AND rb.id = $2`,
      [reservationId, bookingId],
    );
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Booking not found" });
    }
    const booking = bookingResult.rows[0];

    // Enduser scope check
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(booking.project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }
    }

    // Load pre-delete snapshot for customer email (service name, customer, dates)
    const snapshotResult = await pool.query(
      `SELECT b.id, b.starts_at, b.ends_at, b.locale,
              b.service_name_snapshot,
              COALESCE(rst.name, b.service_name_snapshot) AS service_name,
              rc.first_name AS customer_first_name, rc.last_name AS customer_last_name,
              rc.email AS customer_email, rc.phone AS customer_phone,
              b.customer_id, b.service_id
       FROM reservation_bookings b
       LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu'
       LEFT JOIN reservation_customers rc ON rc.id = b.customer_id
       WHERE b.reservation_id = $1 AND b.id = $2`,
      [reservationId, bookingId],
    );
    const snapshot = snapshotResult.rows[0];

    // Delete the booking
    await pool.query(
      `DELETE FROM reservation_bookings WHERE reservation_id = $1 AND id = $2`,
      [reservationId, bookingId],
    );

    // Send deletion notification email to customer (fire-and-forget).
    // Reuses notifySubmitter so project resolution, branding, and
    // fromName handling match the booking-creation email path exactly.
    if (snapshot && snapshot.customer_email) {
      notifySubmitter({
        kind: "reservation_deleted",
        projectId: booking.project_id,
        formName: snapshot.service_name || "Reservation",
        data: null,
        locale: snapshot.locale || "hu",
        startsAt: snapshot.starts_at,
        endsAt: snapshot.ends_at,
        bookingId: snapshot.id,
        serviceName: snapshot.service_name,
        email: snapshot.customer_email,
        timezone: snapshot.timezone || "UTC",
      }).catch(() => {});
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[reservations/bookings/delete]", err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/reservations/:id/bookings — admin-only booking creation.
//
// Skips lead_time / max_advance_days (operator can book past or far-future
// slots), but still enforces: shape, slot alignment, availability schedules
// + disabled ranges, overlap (via DB EXCLUDE), and (when present) the
// bounded `data` bag.
//
// The full validation lives in lib/booking-validation.js, shared with the
// public embed submission path.
// ---------------------------------------------------------------------------
router.post("/:id/bookings", async (req, res, next) => {
  try {

    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    const reservationResult = await pool.query(
      `SELECT id, project_id, status, granularity, slot_duration_minutes,
              extra_fields_enabled, default_locale, timezone, secret_token
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

    const body = req.body ?? {};

    // Resolve service: explicit serviceId or default service
    let serviceId = parseInt(body.serviceId, 10);
    let serviceRow;
    if (serviceId && Number.isFinite(serviceId)) {
      const svcResult = await pool.query(
        `SELECT rs.id, rst.name, rs.duration_minutes, rs.price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status,
                rs.granularity, rs.slot_duration_minutes
         FROM reservation_services rs
         LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = 'hu'
         WHERE rs.id = $1 AND rs.reservation_id = $2`,
        [serviceId, reservationId],
      );
      if (svcResult.rowCount === 0 || svcResult.rows[0].status !== "active") {
        return res.status(400).json({ errorMessage: "Invalid or inactive service" });
      }
      serviceRow = svcResult.rows[0];
    } else {
      const defaultSvc = await pool.query(
        `SELECT rs.id, rst.name, rs.duration_minutes, rs.price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status,
                rs.granularity, rs.slot_duration_minutes
         FROM reservation_services rs
         LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = 'hu'
         WHERE rs.reservation_id = $1 AND rs.status = 'active' ORDER BY rs.sort_order, rs.id LIMIT 1`,
        [reservationId],
      );
      if (defaultSvc.rowCount === 0) {
        return res.status(400).json({ errorMessage: "No active service found for this reservation" });
      }
      serviceRow = defaultSvc.rows[0];
      serviceId = serviceRow.id;
    }

    // Validate contact
    const contactResult = validateReservationContact(body);
    if (!contactResult.ok) return res.status(400).json({ errorMessage: contactResult.error });

    // Validate custom fields
    const fieldDefs = await pool.query(
      `SELECT field_key, field_type, required FROM reservation_service_fields WHERE service_id = $1`,
      [serviceId],
    );
    if (body.fields) {
      const fieldsResult = validateReservationServiceFields(fieldDefs.rows, body.fields);
      if (!fieldsResult.ok) return res.status(400).json({ errorMessage: fieldsResult.error });
    }

    // Slot alignment validation
    const v = await validateBookingItem({
      body,
      reservation,
      service: serviceRow,
      checkAvailability: checkSlotAvailability,
    });
    if (!v.ok) return res.status(400).json({ errorMessage: v.error });

    const source = isEnduser(req) ? "portal" : "admin";

    // Create booking via transaction with capacity enforcement
    const result = await createReservationBooking({
      reservation,
      service: serviceRow,
      startsAtIso: v.startsAtIso,
      endsAtIso: v.endsAtIso,
      contact: contactResult.value,
      customerId: body.customerId || null,
      customData: body.fields || null,
      locale: body.locale || reservation.default_locale || "hu",
      createdByUserId: req.user?.id || null,
      source,
      workerUserId: null,
    });

    if (result.error) {
      return res.status(result.code === "SLOT_FULL" || result.code === "DUPLICATE_BOOKING" ? 409 : 400).json({ errorMessage: result.error });
    }

    // Fire-and-forget notifications
    const customerName = `${contactResult.value.lastName} ${contactResult.value.firstName}`;

    // Resolve worker info if assigned
    let workerEmail = null;
    let workerName = null;
    if (serviceRow.worker_user_id) {
      try {
        const workerResult = await pool.query(
          `SELECT first_name, last_name, email FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true`,
          [serviceRow.worker_user_id],
        );
        if (workerResult.rowCount > 0) {
          const w = workerResult.rows[0];
          if (w.email) workerEmail = w.email.trim();
          const parts = [w.last_name, w.first_name].filter(Boolean);
          if (parts.length > 0) workerName = parts.join(" ");
        }
      } catch { /* ignore */ }
    }

    // Customer confirmation — footer "write to" = project contact email, sign-off = worker name
    notifySubmitter({
      kind: "reservation", projectId: reservation.project_id,
      formName: serviceRow.name || "Reservation", data: null,
      locale: body.locale || "hu", startsAt: v.startsAtIso, endsAt: v.endsAtIso,
      bookingId: result.booking.id, serviceName: serviceRow.name,
      email: contactResult.value.email,
      signerName: workerName || undefined,
      bookingToken: result.booking.booking_token,
      secretToken: reservation.secret_token,
      timezone: reservation.timezone || "UTC",
    }).catch(() => {});

    // Worker notification — Nexus branding, customer details, no reply hint, no sign-off
    if (workerEmail) {
      notifySubmitter({
        kind: "reservation", projectId: reservation.project_id,
        formName: serviceRow.name || "Reservation", data: null,
        locale: body.locale || "hu", startsAt: v.startsAtIso, endsAt: v.endsAtIso,
        bookingId: result.booking.id, serviceName: serviceRow.name,
        to: workerEmail,
        useBrandDefaults: true,
        customerName,
        customerEmail: contactResult.value.email,
        customerPhone: contactResult.value.phone,
        comment: contactResult.value.comment || null,
        timezone: reservation.timezone || "UTC",
      }).catch(() => {});
    }

    return res.status(201).json(rowToReservationBookingDTO(result.booking));
  } catch (err) {
    if (err.code === "23P01") {
      return res.status(409).json({ errorMessage: "Slot already booked" });
    }
    console.error("[reservations/bookings/admin-create]", err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Disabled ranges — operator-declared date/time blackouts.
//
// GET    /:id/disabled-ranges           — list (admin + enduser, scoped)
// POST   /:id/disabled-ranges           — create (admin only)
// DELETE /:id/disabled-ranges/:rangeId  — delete (admin only)
// ---------------------------------------------------------------------------

// Snake_case DB row → camelCase DTO.
const rowToDisabledRangeDTO = (row) => ({
  id: Number(row.id),
  reservationId: Number(row.reservation_id),
  startsAt: row.starts_at instanceof Date
    ? row.starts_at.toISOString()
    : row.starts_at,
  endsAt: row.ends_at instanceof Date
    ? row.ends_at.toISOString()
    : row.ends_at,
  reason: row.reason ?? null,
  source: row.source ?? "manual",
  enabled: row.enabled !== false,
  createdAt: row.created_at instanceof Date
    ? row.created_at.toISOString()
    : row.created_at,
  serviceIds: row.service_ids || [],
});

// ---- GET /api/reservations/:id/disabled-ranges ----
router.get("/:id/disabled-ranges", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    // Verify reservation exists + enduser scope.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const { rows } = await pool.query(
      `SELECT dr.id, dr.reservation_id, dr.starts_at, dr.ends_at, dr.reason, dr.source, dr.enabled, dr.created_at,
              COALESCE(
                (SELECT ARRAY_AGG(drs.service_id ORDER BY drs.service_id)
                 FROM reservation_disabled_range_services drs
                 WHERE drs.disabled_range_id = dr.id),
                '{}'
              ) AS service_ids
       FROM reservation_disabled_ranges dr
       WHERE dr.reservation_id = $1
       ORDER BY dr.source DESC, dr.starts_at ASC`,
      [reservationId],
    );

    return res.json(rows.map(rowToDisabledRangeDTO));
  } catch (err) {
    console.error("[reservations/disabled-ranges/list]", err.code, err.message);
    next(err);
  }
});

// ---- POST /api/reservations/:id/disabled-ranges ----
router.post("/:id/disabled-ranges", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    // Verify reservation exists + enduser scope.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    // Enduser scope: can only manage disabled ranges for assigned projects.
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const body = req.body ?? {};
    const startsAt = parseStrictIso(body.startsAt);
    const endsAt = parseStrictIso(body.endsAt);
    if (!startsAt || !endsAt) {
      return res.status(400).json({ errorMessage: "startsAt and endsAt must be ISO 8601 UTC" });
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      return res.status(400).json({ errorMessage: "endsAt must be after startsAt" });
    }

    let reason = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== "string") {
        return res.status(400).json({ errorMessage: "reason must be a string" });
      }
      const trimmed = body.reason.trim();
      if (trimmed.length > 500) {
        return res.status(400).json({ errorMessage: "reason must be ≤ 500 chars" });
      }
      if (trimmed.length > 0) reason = trimmed;
    }

    // Check per-service overlap if serviceIds provided
    const incomingServiceIds = Array.isArray(body.serviceIds)
      ? [...new Set(body.serviceIds.filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b)
      : null;
    if (incomingServiceIds && incomingServiceIds.length > 0) {
      const overlapCheck = await pool.query(
        `SELECT drs.service_id
         FROM reservation_disabled_ranges dr
         JOIN reservation_disabled_range_services drs ON drs.disabled_range_id = dr.id
         WHERE dr.reservation_id = $1
           AND dr.enabled = true
           AND drs.service_id = ANY($2::bigint[])
           AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange($3, $4, '[)')
         LIMIT 1`,
        [reservationId, incomingServiceIds, startsAt.toISOString(), endsAt.toISOString()]);
      if (overlapCheck.rowCount > 0) {
        return res.status(409).json({ errorMessage: "This range overlaps with an existing disabled range for one or more selected services" });
      }
    }

    const insertResult = await pool.query(
      `INSERT INTO reservation_disabled_ranges
         (reservation_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, reservation_id, starts_at, ends_at, reason, source, enabled, created_at`,
      [reservationId, startsAt.toISOString(), endsAt.toISOString(), reason],
    );
    const newRange = insertResult.rows[0];

    // Link to services: if serviceIds provided, link those; otherwise link ALL services (backward compat)
    let linkIds = incomingServiceIds;
    if (!linkIds || linkIds.length === 0) {
      const allSvc = await pool.query(
        `SELECT id FROM reservation_services WHERE reservation_id = $1 AND status = 'active' ORDER BY id`,
        [reservationId],
      );
      linkIds = allSvc.rows.map(r => r.id);
    }
    if (linkIds.length > 0) {
      const values = linkIds.map((sid, i) => `($1, $${i + 2})`).join(", ");
      await pool.query(
        `INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES ${values}`,
        [newRange.id, ...linkIds],
      );
    }

    return res.status(201).json(rowToDisabledRangeDTO({ ...newRange, service_ids: linkIds }));
  } catch (err) {
    // 23P01 = exclusion_violation → overlapping disabled range.
    if (err.code === "23P01") {
      return res.status(409).json({ errorMessage: "This range overlaps with an existing disabled range" });
    }
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid date range" });
    }
    console.error("[reservations/disabled-ranges/create]", err.code, err.message);
    next(err);
  }
});

// ---- DELETE /api/reservations/:id/disabled-ranges/:rangeId ----
router.delete("/:id/disabled-ranges/:rangeId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const rangeId = parseInt(req.params.rangeId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(rangeId) || rangeId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid range id" });
    }

    // Enduser scope: can only delete disabled ranges for assigned projects.
    if (isEnduser(req)) {
      const pre = await pool.query(
        "SELECT project_id FROM reservations WHERE id = $1",
        [reservationId],
      );
      if (pre.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Disabled range not found" });
      }
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Disabled range not found" });
      }
    }

    const { rowCount } = await pool.query(
      `DELETE FROM reservation_disabled_ranges
       WHERE id = $1 AND reservation_id = $2`,
      [rangeId, reservationId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Disabled range not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[reservations/disabled-ranges/delete]", err.code, err.message);
    next(err);
  }
});

// ---- PUT /api/reservations/:id/disabled-ranges/:rangeId ----
// Edit a disabled range (manual only — auto-holiday dates are fixed).
router.put("/:id/disabled-ranges/:rangeId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const rangeId = parseInt(req.params.rangeId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(rangeId) || rangeId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid range id" });
    }

    // Enduser scope check
    const pre = await pool.query(
      "SELECT project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Disabled range not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Disabled range not found" });
      }
    }

    // Only manual ranges can be edited.
    const existing = await pool.query(
      "SELECT id, source FROM reservation_disabled_ranges WHERE id = $1 AND reservation_id = $2",
      [rangeId, reservationId],
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Disabled range not found" });
    }
    if (existing.rows[0].source !== "manual") {
      return res.status(400).json({ errorMessage: "Auto-generated holiday ranges cannot be edited" });
    }

    const body = req.body ?? {};
    const startsAt = parseStrictIso(body.startsAt);
    const endsAt = parseStrictIso(body.endsAt);
    if (!startsAt || !endsAt) {
      return res.status(400).json({ errorMessage: "startsAt and endsAt must be ISO 8601 UTC" });
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      return res.status(400).json({ errorMessage: "endsAt must be after startsAt" });
    }

    let reason = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== "string") {
        return res.status(400).json({ errorMessage: "reason must be a string" });
      }
      const trimmed = body.reason.trim();
      if (trimmed.length > 500) {
        return res.status(400).json({ errorMessage: "reason must be ≤ 500 chars" });
      }
      if (trimmed.length > 0) reason = trimmed;
    }

    // Check per-service overlap (excluding current range)
    const incomingServiceIds = Array.isArray(body.serviceIds)
      ? [...new Set(body.serviceIds.filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b)
      : null;
    if (incomingServiceIds && incomingServiceIds.length > 0) {
      const overlapCheck = await pool.query(
        `SELECT drs.service_id
         FROM reservation_disabled_ranges dr
         JOIN reservation_disabled_range_services drs ON drs.disabled_range_id = dr.id
         WHERE dr.reservation_id = $1
           AND dr.id != $2
           AND dr.enabled = true
           AND drs.service_id = ANY($3::bigint[])
           AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange($4, $5, '[)')
         LIMIT 1`,
        [reservationId, rangeId, incomingServiceIds, startsAt.toISOString(), endsAt.toISOString()]);
      if (overlapCheck.rowCount > 0) {
        return res.status(409).json({ errorMessage: "This range overlaps with an existing disabled range for one or more selected services" });
      }
    }

    const updateResult = await pool.query(
      `UPDATE reservation_disabled_ranges
       SET starts_at = $1, ends_at = $2, reason = $3
       WHERE id = $4 AND reservation_id = $5
       RETURNING id, reservation_id, starts_at, ends_at, reason, source, enabled, created_at`,
      [startsAt.toISOString(), endsAt.toISOString(), reason, rangeId, reservationId],
    );
    if (updateResult.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Disabled range not found" });
    }

    // Replace service associations if serviceIds provided
    let linkIds = incomingServiceIds;
    if (linkIds && linkIds.length > 0) {
      await pool.query(
        `DELETE FROM reservation_disabled_range_services WHERE disabled_range_id = $1`,
        [rangeId],
      );
      const values = linkIds.map((sid, i) => `($1, $${i + 2})`).join(", ");
      await pool.query(
        `INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES ${values}`,
        [rangeId, ...linkIds],
      );
    } else if (linkIds && linkIds.length === 0) {
      // Explicitly empty = unlink all
      await pool.query(
        `DELETE FROM reservation_disabled_range_services WHERE disabled_range_id = $1`,
        [rangeId],
      );
    }
    // If linkIds is null (not provided), leave existing associations untouched

    // Re-read service_ids for the DTO
    const svcResult = await pool.query(
      `SELECT COALESCE(
        (SELECT ARRAY_AGG(drs.service_id ORDER BY drs.service_id)
         FROM reservation_disabled_range_services drs
         WHERE drs.disabled_range_id = $1),
        '{}'
      ) AS service_ids`,
      [rangeId],
    );
    const serviceIds = svcResult.rows[0]?.service_ids || [];

    return res.json(rowToDisabledRangeDTO({ ...updateResult.rows[0], service_ids: serviceIds }));
  } catch (err) {
    if (err.code === "23P01") {
      return res.status(409).json({ errorMessage: "This range overlaps with an existing disabled range" });
    }
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid date range" });
    }
    console.error("[reservations/disabled-ranges/update]", err.code, err.message);
    next(err);
  }
});

// ---- PATCH /api/reservations/:id/disabled-ranges/:rangeId/toggle ----
// Toggle the `enabled` flag on a single disabled range (auto or manual).
// ---------------------------------------------------------------------------
// Availability schedules — recurring time-slot templates.
//
// GET    /:id/availability-schedules               — list (admin + enduser, scoped)
// POST   /:id/availability-schedules               — create (admin only)
// DELETE /:id/availability-schedules/:scheduleId    — delete (admin only)
// ---------------------------------------------------------------------------

// Snake_case DB row → camelCase DTO.
// PostgreSQL TIME columns come back as "HH:MM:SS" strings — trim to "HH:MM"
// for the FE so it matches <input type="time"> format.
const rowToAvailabilityScheduleDTO = (row) => {
  const trimTime = (t) => {
    if (typeof t === "string") return t.slice(0, 5); // "09:00:00" → "09:00"
    return t;
  };
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    frequency: row.frequency,
    dayOfWeek: row.day_of_week === null || row.day_of_week === undefined
      ? null
      : Number(row.day_of_week),
    dayOfMonth: row.day_of_month === null || row.day_of_month === undefined
      ? null
      : Number(row.day_of_month),
    startTime: trimTime(row.start_time),
    endTime: trimTime(row.end_time),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  };
};

const FREQUENCY_VALUES = new Set(["daily", "weekly", "monthly"]);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- GET /api/reservations/:id/availability-schedules ----
router.get("/:id/availability-schedules", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    // Verify reservation exists + enduser scope.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const { rows } = await pool.query(
      `SELECT id, reservation_id, frequency, day_of_week, day_of_month,
              start_time, end_time, created_at
       FROM reservation_availability_schedules
       WHERE reservation_id = $1
       ORDER BY frequency, day_of_week, day_of_month, start_time ASC`,
      [reservationId],
    );

    return res.json(rows.map(rowToAvailabilityScheduleDTO));
  } catch (err) {
    console.error("[reservations/availability-schedules/list]", err.code, err.message);
    next(err);
  }
});

// ---- POST /api/reservations/:id/availability-schedules ----
router.post("/:id/availability-schedules", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }

    // Verify reservation exists + enduser scope.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    // Enduser scope: can only manage schedules for assigned projects.
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
    }

    const body = req.body ?? {};

    // Validate frequency.
    if (typeof body.frequency !== "string" || !FREQUENCY_VALUES.has(body.frequency)) {
      return res.status(400).json({
        errorMessage: `frequency must be one of ${[...FREQUENCY_VALUES].join(", ")}`,
      });
    }
    const frequency = body.frequency;

    // Validate day fields based on frequency.
    let dayOfWeek = null;
    let dayOfMonth = null;

    if (frequency === "weekly") {
      if (body.dayOfWeek === undefined || body.dayOfWeek === null) {
        return res.status(400).json({ errorMessage: "dayOfWeek is required for weekly frequency" });
      }
      const dow = typeof body.dayOfWeek === "number" ? body.dayOfWeek : parseInt(body.dayOfWeek, 10);
      if (!Number.isFinite(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ errorMessage: "dayOfWeek must be 0 (Sunday) to 6 (Saturday)" });
      }
      dayOfWeek = dow;
    } else if (frequency === "monthly") {
      if (body.dayOfMonth === undefined || body.dayOfMonth === null) {
        return res.status(400).json({ errorMessage: "dayOfMonth is required for monthly frequency" });
      }
      const dom = typeof body.dayOfMonth === "number" ? body.dayOfMonth : parseInt(body.dayOfMonth, 10);
      if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
        return res.status(400).json({ errorMessage: "dayOfMonth must be 1 to 31" });
      }
      dayOfMonth = dom;
    }
    // For daily: both stay null.

    // Validate start_time and end_time (HH:MM or HH:MM:SS format).
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
    if (typeof body.startTime !== "string" || !TIME_RE.test(body.startTime)) {
      return res.status(400).json({ errorMessage: "startTime must be HH:MM format (00:00–23:59)" });
    }
    if (typeof body.endTime !== "string" || !TIME_RE.test(body.endTime)) {
      return res.status(400).json({ errorMessage: "endTime must be HH:MM format (00:00–23:59)" });
    }
    // Normalize to HH:MM:SS for PostgreSQL TIME type.
    const normalizeTime = (t) => t.length === 5 ? `${t}:00` : t;
    const startTime = normalizeTime(body.startTime);
    const endTime = normalizeTime(body.endTime);

    if (endTime <= startTime) {
      return res.status(400).json({ errorMessage: "endTime must be after startTime" });
    }

    const insertResult = await pool.query(
      `INSERT INTO reservation_availability_schedules
         (reservation_id, frequency, day_of_week, day_of_month, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, reservation_id, frequency, day_of_week, day_of_month,
                 start_time, end_time, created_at`,
      [reservationId, frequency, dayOfWeek, dayOfMonth, startTime, endTime],
    );

    return res.status(201).json(rowToAvailabilityScheduleDTO(insertResult.rows[0]));
  } catch (err) {
    // 23514 = check_violation (e.g. end_time > start_time, frequency-day constraints).
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid schedule data" });
    }
    console.error("[reservations/availability-schedules/create]", err.code, err.message);
    next(err);
  }
});

// ---- DELETE /api/reservations/:id/availability-schedules/:scheduleId ----
router.delete("/:id/availability-schedules/:scheduleId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const scheduleId = parseInt(req.params.scheduleId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid schedule id" });
    }

    // Enduser scope: can only delete schedules for assigned projects.
    if (isEnduser(req)) {
      const pre = await pool.query(
        "SELECT project_id FROM reservations WHERE id = $1",
        [reservationId],
      );
      if (pre.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Schedule not found" });
      }
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Schedule not found" });
      }
    }

    const { rowCount } = await pool.query(
      `DELETE FROM reservation_availability_schedules
       WHERE id = $1 AND reservation_id = $2`,
      [scheduleId, reservationId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Schedule not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[reservations/availability-schedules/delete]", err.code, err.message);
    next(err);
  }
});

// ---- PUT /api/reservations/:id/availability-schedules/:scheduleId ----
router.put("/:id/availability-schedules/:scheduleId", async (req, res, next) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const scheduleId = parseInt(req.params.scheduleId, 10);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid reservation id" });
    }
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid schedule id" });
    }

    // Verify reservation exists + enduser scope.
    const reservationCheck = await pool.query(
      "SELECT id, project_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    if (reservationCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Reservation not found" });
    }
    if (isEnduser(req)) {
      const allowed = Array.isArray(req.user.projectIds)
        ? req.user.projectIds.includes(Number(reservationCheck.rows[0].project_id))
        : false;
      if (!allowed) {
        return res.status(404).json({ errorMessage: "Schedule not found" });
      }
    }

    const body = req.body ?? {};

    // Validate frequency.
    if (typeof body.frequency !== "string" || !FREQUENCY_VALUES.has(body.frequency)) {
      return res.status(400).json({
        errorMessage: `frequency must be one of ${[...FREQUENCY_VALUES].join(", ")}`,
      });
    }
    const frequency = body.frequency;

    // Validate day fields based on frequency.
    let dayOfWeek = null;
    let dayOfMonth = null;

    if (frequency === "weekly") {
      if (body.dayOfWeek === undefined || body.dayOfWeek === null) {
        return res.status(400).json({ errorMessage: "dayOfWeek is required for weekly frequency" });
      }
      const dow = typeof body.dayOfWeek === "number" ? body.dayOfWeek : parseInt(body.dayOfWeek, 10);
      if (!Number.isFinite(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ errorMessage: "dayOfWeek must be 0 (Sunday) to 6 (Saturday)" });
      }
      dayOfWeek = dow;
    } else if (frequency === "monthly") {
      if (body.dayOfMonth === undefined || body.dayOfMonth === null) {
        return res.status(400).json({ errorMessage: "dayOfMonth is required for monthly frequency" });
      }
      const dom = typeof body.dayOfMonth === "number" ? body.dayOfMonth : parseInt(body.dayOfMonth, 10);
      if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
        return res.status(400).json({ errorMessage: "dayOfMonth must be 1 to 31" });
      }
      dayOfMonth = dom;
    }

    // Validate start_time and end_time.
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
    if (typeof body.startTime !== "string" || !TIME_RE.test(body.startTime)) {
      return res.status(400).json({ errorMessage: "startTime must be HH:MM format (00:00–23:59)" });
    }
    if (typeof body.endTime !== "string" || !TIME_RE.test(body.endTime)) {
      return res.status(400).json({ errorMessage: "endTime must be HH:MM format (00:00–23:59)" });
    }
    const normalizeTime = (t) => t.length === 5 ? `${t}:00` : t;
    const startTime = normalizeTime(body.startTime);
    const endTime = normalizeTime(body.endTime);

    if (endTime <= startTime) {
      return res.status(400).json({ errorMessage: "endTime must be after startTime" });
    }

    const updateResult = await pool.query(
      `UPDATE reservation_availability_schedules
       SET frequency = $1, day_of_week = $2, day_of_month = $3,
           start_time = $4, end_time = $5
       WHERE id = $6 AND reservation_id = $7
       RETURNING id, reservation_id, frequency, day_of_week, day_of_month,
                 start_time, end_time, created_at`,
      [frequency, dayOfWeek, dayOfMonth, startTime, endTime, scheduleId, reservationId],
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Schedule not found" });
    }

    return res.json(rowToAvailabilityScheduleDTO(updateResult.rows[0]));
  } catch (err) {
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid schedule data" });
    }
    console.error("[reservations/availability-schedules/update]", err.code, err.message);
    next(err);
  }
});
