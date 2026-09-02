// Public embed endpoints for the Reservations module.
//
// Behaviour (mirrors routes/form-embed.js with two additions):
//   - Public, no auth/CSRF (the /api/public/* prefix is CSRF-exempt per
//     middleware/csrf.js; the secret_token is the capability).
//   - Two rate-limited chains:
//       reservationBurstLimiter       for POST bookings
//       reservationAvailabilityBurst  for GET availability
//       reservationSustainedLimiter   hard daily cap shared across both
//   - Origin must match the reservation's allowed_origins list (or the
//     list must be empty) — wildcard/exact semantics keyed against
//     `req.headers.origin` directly (same impl as forms).
//   - POST body validation:
//       startsAt, endsAt              ISO 8601 strings
//       granularity-allowed values    enforced server-side
//       slot_duration_minutes         when reservation declares one,
//                                      startsAt / endsAt must align to the grid
//       lead_time_minutes             booking start must be at least that
//                                      many minutes from now
//       max_advance_days              booking start must be within the
//                                      configured future window
//       data (optional JSONB)         only accepted when
//                                      reservation.extra_fields_enabled
//                                      is true; bounded-bag validation
//                                      identical to form submissions
//   - GET availability:
//       from, to (optional ISO 8601)  defaults to [now, now+max_advance_days]
//       Returns { reservationId, windowStart, windowEnd, granularity,
//                 slotDurationMinutes, leadTimeMinutes, maxAdvanceDays,
//                 booked: [{ startsAt, endsAt }, ...] }
//       Booked ranges only — calendar rendering is the FE's job.
//   - 404 if the secret_token is unknown OR the reservation is disabled
//     OR the origin doesn't match the (non-empty) allowlist —
//     indistinguishable so we don't leak existence.
//   - 201 + { id, startsAt, endsAt, bookedAt } on POST success.
//   - 409 + "Slot already booked" on EXCLUDE constraint violation.

import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { pool } from "../db/pool.js";
import { notifySubmitter } from "../lib/email.js";
import { checkSlotAvailability, getServiceAvailability } from "../lib/reservation-availability.js";
import { createReservationBooking, upsertReservationCustomer, rowToReservationBookingDTO } from "../lib/reservation-booking.js";
import { validateReservationContact, validateReservationServiceFields } from "../lib/booking-validation.js";
import {
  isValidReservationCustomerProfileToken,
  resolveReservationCustomerProfiles,
  upsertReservationCustomerProfile,
} from "../lib/reservation-customer-profiles.js";

export const router = express.Router();

// Generous enough for E2E + load tests; tune per env via the
// *BURST_LIMIT / *SUSTAINED_LIMIT env vars. Default is thousands+ so
// automated tests don't hit walls.
const reservationBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_RESERVATION_BOOKING_BURST_LIMIT || "10000", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many bookings, please try again later" },
  keyGenerator: (req) => `reservation-burst:${req.ip}`,
});

const reservationAvailabilityBurst = rateLimit({
  // Generous on availability — the FE will typically poll at every date
  // picker open. Still bounded.
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_RESERVATION_AVAILABILITY_BURST_LIMIT || "20000", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many availability checks, please try again later" },
  keyGenerator: (req) => `reservation-avail-burst:${req.ip}`,
});

const reservationSustainedLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: parseInt(process.env.PUBLIC_RESERVATION_SUSTAINED_LIMIT || "100000", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests, please try again later" },
  keyGenerator: (req) => `reservation-sustained:${req.ip}`,
});

// Validation constants + parseStrictIso + measureBag — imported from
// the shared lib so the public endpoint and admin create run identical checks.
import {
  parseStrictIso,
  DATA_MAX_KEYS_PER_LEVEL,
  DATA_MAX_DEPTH,
  DATA_MAX_BYTES,
  measureBag,
  SLOT_GRID_MAX_MINUTES,
} from "../lib/booking-validation.js";

const LOCALE_MAX_LEN = 10;

// isOriginAllowed — same wildcard/exact match semantics as form-embed.js /
// origin-allowlist.ts. Keep all three in sync.
function isOriginAllowed(requestOrigin, allowedOrigins) {
  if (typeof requestOrigin !== "string" || requestOrigin.length === 0) {
    return false;
  }
  const hasScheme = /^https?:\/\//i.test(requestOrigin);
  const urlish = hasScheme ? requestOrigin : `http://${requestOrigin}`;
  let req;
  try {
    const u = new URL(urlish);
    req = u.host.toLowerCase();
  } catch {
    req = requestOrigin.replace(/\/$/, "").replace(/^https?:\/\//i, "").toLowerCase();
  }
  for (let i = 0; i < allowedOrigins.length; i++) {
    const entry = allowedOrigins[i];
    if (typeof entry !== "string") return false;
    const e = entry.replace(/\/$/, "").toLowerCase();
    const entryHasScheme = /^https?:\/\//i.test(e);
    const eUrlish = entryHasScheme ? e : `http://${e}`;
    let entryHost;
    try {
      const eu = new URL(eUrlish);
      entryHost = eu.host.toLowerCase();
    } catch {
      entryHost = e.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
    if (entryHost === req) return true;
    if (e.indexOf("*.") !== -1) {
      const starIdx = e.indexOf("*.");
      const suffix = e.slice(starIdx + 2);
      const suffixHost = suffix.replace(/^https?:\/\//i, "").split(":")[0];
      const reqHost = req.split(":")[0];
      if (reqHost === suffixHost) continue;
      if (reqHost.length > suffixHost.length && reqHost.endsWith("." + suffixHost)) {
        return true;
      }
    }
  }
  return false;
}

function normaliseAllowedOrigins(raw) {
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw.filter((d) => typeof d === "string");
  } else if (typeof raw === "string" && raw.length > 0) {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  return Array.isArray(arr) ? arr.filter((d) => typeof d === "string") : [];
}

// ---------------------------------------------------------------------------
// Budapest time helpers — all customer-facing time logic uses Europe/Budapest.
// ---------------------------------------------------------------------------
const BUDAPEST_TZ = "Europe/Budapest";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/** Get UTC offset in ms for a timezone at a given date (handles DST). */
function getTzOffsetMs(timezone, date) {
  const d = date instanceof Date ? date : new Date(date);
  const tzStr = d.toLocaleString("en-US", { timeZone: timezone, hour12: false });
  const utcStr = d.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

/** Check if a booking's starts_at is within 12 hours (Budapest time). */
function isWithin12Hours(startsAt) {
  const nowMs = Date.now();
  const bookingMs = new Date(startsAt).getTime();
  const offsetMs = getTzOffsetMs(BUDAPEST_TZ, new Date(startsAt));
  const currentOffsetMs = getTzOffsetMs(BUDAPEST_TZ, new Date());
  // Add positive offset to convert UTC → local for east-of-UTC zones
  return (bookingMs + offsetMs) - (nowMs + currentOffsetMs) < TWELVE_HOURS_MS;
}

// ---------------------------------------------------------------------------
// Reservation configurator — fetch by secret_token, returning every field
// the public endpoints need in one round-trip. Returns null when the token
// is unknown OR the reservation is disabled (indistinguishable from the
// caller's perspective).
// ---------------------------------------------------------------------------

async function loadReservationByToken(secretToken) {
  const { rows } = await pool.query(
    `SELECT id, project_id, name, status, allowed_origins, granularity,
            slot_duration_minutes, lead_time_minutes, max_advance_days,
            extra_fields_enabled, disable_hungarian_holidays,
            embed_title, brand_color, iframe_width, iframe_height,
            privacy_policy_url, cookie_policy_url,
            default_locale, timezone
     FROM reservations
     WHERE trim(secret_token) = $1`,
    [secretToken],
  );
  if (rows.length === 0 || rows[0].status !== "active") return null;
  return rows[0];
}

// ---------------------------------------------------------------------------
// GET /api/public/reservations/:secret_token/availability
// ---------------------------------------------------------------------------
router.get(
  "/:secret_token/availability",
  reservationAvailabilityBurst,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }

    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }

      // Origin allowlist enforcement. Same indistinguishability as forms.
      const allowedOrigins = normaliseAllowedOrigins(reservation.allowed_origins);
      if (allowedOrigins.length > 0) {
        const requestOrigin = req.headers.origin;
        if (
          typeof requestOrigin !== "string" ||
          requestOrigin.length === 0 ||
          !isOriginAllowed(requestOrigin, allowedOrigins)
        ) {
          return res.status(404).json({ errorMessage: "Reservation not found" });
        }
      }

      // Resolve the [from, to] window. Defaults: now → now + max_advance_days.
      const now = new Date();
      const defaultTo = new Date(now.getTime() + reservation.max_advance_days * 24 * 60 * 60 * 1000);

      let from = null;
      if (typeof req.query.from === "string" && req.query.from.length > 0) {
        from = parseStrictIso(req.query.from);
        if (!from) {
          return res.status(400).json({ errorMessage: "from must be ISO 8601 UTC" });
        }
      } else {
        from = now;
      }
      let to = null;
      if (typeof req.query.to === "string" && req.query.to.length > 0) {
        to = parseStrictIso(req.query.to);
        if (!to) {
          return res.status(400).json({ errorMessage: "to must be ISO 8601 UTC" });
        }
      } else {
        to = defaultTo;
      }
      if (from.getTime() > to.getTime()) {
        return res.status(400).json({ errorMessage: "from must be <= to" });
      }
      // Cap the window at the configured max_advance_days in case the FE
      // asked for a much wider range. Without this we'd happily scan a
      // year's worth of bookings when max_advance_days = 30.
      const windowMs = reservation.max_advance_days * 24 * 60 * 60 * 1000;
      const maxTo = new Date(from.getTime() + windowMs);
      const effectiveTo = to.getTime() > maxTo.getTime() ? maxTo : to;

      // SELECT only what's needed — start/end instants, no metadata.
      // The GiST index on (reservation_id, tstzrange(starts_at, ends_at))
      // lets the planner use an index-only scan on this range filter.
      const bookingsResult = await pool.query(
        `SELECT starts_at, ends_at
         FROM reservation_bookings
         WHERE reservation_id = $1
           AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
         ORDER BY starts_at ASC`,
        [reservation.id, from.toISOString(), effectiveTo.toISOString()],
      );

      const booked = bookingsResult.rows.map((row) => ({
        startsAt: row.starts_at instanceof Date
          ? row.starts_at.toISOString()
          : row.starts_at,
        endsAt: row.ends_at instanceof Date
          ? row.ends_at.toISOString()
          : row.ends_at,
      }));

      // Also fetch disabled ranges that overlap the window.
      // Filter: manual ranges are always included; auto_holiday ranges
      // are only included when disable_hungarian_holidays is ON AND the
      // individual range is enabled.
      const disabledResult = await pool.query(
        `SELECT starts_at, ends_at
         FROM reservation_disabled_ranges
         WHERE reservation_id = $1
           AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
           AND (
             (source = 'manual' AND enabled = true)
             OR
             (source = 'auto_holiday' AND enabled = true AND $4 = true)
           )
         ORDER BY starts_at ASC`,
        [reservation.id, from.toISOString(), effectiveTo.toISOString(), reservation.disable_hungarian_holidays],
      );

      const disabled = disabledResult.rows.map((row) => ({
        startsAt: row.starts_at instanceof Date
          ? row.starts_at.toISOString()
          : row.starts_at,
        endsAt: row.ends_at instanceof Date
          ? row.ends_at.toISOString()
          : row.ends_at,
      }));

      // Fetch availability schedules (recurring time-slot templates).
      // These define WHEN the reservation is open — the positive counterpart
      // to disabled ranges which block specific windows.
      const schedulesResult = await pool.query(
        `SELECT frequency, day_of_week, day_of_month, start_time, end_time
         FROM reservation_availability_schedules
         WHERE reservation_id = $1
         ORDER BY frequency, day_of_week, day_of_month, start_time ASC`,
        [reservation.id],
      );

      const trimTime = (t) => typeof t === "string" ? t.slice(0, 5) : t;
      const schedules = schedulesResult.rows.map((row) => ({
        frequency: row.frequency,
        dayOfWeek: row.day_of_week === null || row.day_of_week === undefined
          ? null
          : Number(row.day_of_week),
        dayOfMonth: row.day_of_month === null || row.day_of_month === undefined
          ? null
          : Number(row.day_of_month),
        startTime: trimTime(row.start_time),
        endTime: trimTime(row.end_time),
      }));

      return res.json({
        reservationId: Number(reservation.id),
        windowStart: from.toISOString(),
        windowEnd: effectiveTo.toISOString(),
        granularity: reservation.granularity,
        slotDurationMinutes: reservation.slot_duration_minutes === null || reservation.slot_duration_minutes === undefined
          ? null
          : Number(reservation.slot_duration_minutes),
        leadTimeMinutes: Number(reservation.lead_time_minutes),
        maxAdvanceDays: Number(reservation.max_advance_days),
        booked,
        disabled,
        schedules,
      });
    } catch (err) {
      console.error("[reservations/public/availability]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/public/reservations/:secret_token/customer-profiles/resolve
// Resolve opaque browser tokens to current customer data.
// ===========================================================================
router.post(
  "/:secret_token/customer-profiles/resolve",
  reservationAvailabilityBurst,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }

    const body = req.body ?? {};
    if (!Array.isArray(body.profileTokens)) {
      return res.status(400).json({ errorMessage: "profileTokens must be an array" });
    }

    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }

      // Origin allowlist enforcement.
      const allowedOrigins = normaliseAllowedOrigins(reservation.allowed_origins);
      if (allowedOrigins.length > 0) {
        const requestOrigin = req.headers.origin;
        if (
          typeof requestOrigin !== "string" ||
          requestOrigin.length === 0 ||
          !isOriginAllowed(requestOrigin, allowedOrigins)
        ) {
          return res.status(404).json({ errorMessage: "Reservation not found" });
        }
      }

      const profiles = await resolveReservationCustomerProfiles({
        reservationId: Number(reservation.id),
        profileTokens: body.profileTokens,
      });

      return res.json({ profiles });
    } catch (err) {
      console.error("[reservations/public/profiles]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/public/reservations/:secret_token/bookings
// ---------------------------------------------------------------------------
router.post(
  "/:secret_token/bookings",
  reservationBurstLimiter,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    const body = req.body ?? {};

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

    let locale = null;
    if (typeof body.locale === "string" && body.locale.length > 0) {
      if (body.locale.length > LOCALE_MAX_LEN) {
        return res.status(400).json({ errorMessage: `locale must be ≤ ${LOCALE_MAX_LEN} chars` });
      }
      locale = body.locale;
    }

    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        // Indistinguishable 404 — don't leak existence.
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }
      const reservationId = Number(reservation.id);

      // Origin allowlist enforcement.
      const allowedOrigins = normaliseAllowedOrigins(reservation.allowed_origins);
      if (allowedOrigins.length > 0) {
        const requestOrigin = req.headers.origin;
        if (
          typeof requestOrigin !== "string" ||
          requestOrigin.length === 0 ||
          !isOriginAllowed(requestOrigin, allowedOrigins)
        ) {
          return res.status(404).json({ errorMessage: "Reservation not found" });
        }
      }

      // Resolve service: explicit serviceId or default service
      let serviceId = parseInt(body.serviceId, 10);
      let serviceRow;
      if (serviceId && Number.isFinite(serviceId)) {
        const svcResult = await pool.query(
          `SELECT rs.id, rs.duration_minutes, rs.price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status,
                  rs.granularity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days,
                  rst.name
           FROM reservation_services rs
           LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id)
           WHERE rs.id = $1 AND rs.reservation_id = $2`,
          [serviceId, reservationId],
        );
        if (svcResult.rowCount === 0 || svcResult.rows[0].status !== "active") {
          return res.status(400).json({ errorMessage: "Invalid or inactive service" });
        }
        serviceRow = svcResult.rows[0];
      } else {
        const defaultSvc = await pool.query(
          `SELECT rs.id, rs.duration_minutes, rs.price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status,
                  rs.granularity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days,
                  rst.name
           FROM reservation_services rs
           LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id)
           WHERE rs.reservation_id = $1 AND rs.status = 'active' ORDER BY rs.sort_order, rs.id LIMIT 1`,
          [reservationId],
        );
        if (defaultSvc.rowCount === 0) {
          return res.status(400).json({ errorMessage: "No active service found" });
        }
        serviceRow = defaultSvc.rows[0];
        serviceId = serviceRow.id;
      }

      // Window enforcement: lead time + max advance (per-service config).
      const nowMs = Date.now();
      const startsMs = new Date(startsAtIso).getTime();
      const leadMs = (serviceRow.lead_time_minutes || 0) * 60 * 1000;
      if (startsMs - nowMs < leadMs) {
        return res.status(400).json({
          errorMessage: `Booking must start at least ${serviceRow.lead_time_minutes || 0} minute(s) from now`,
        });
      }
      const maxAdvanceMs = (serviceRow.max_advance_days || 90) * 24 * 60 * 60 * 1000;
      if (startsMs - nowMs > maxAdvanceMs) {
        return res.status(400).json({
          errorMessage: `Booking cannot start more than ${serviceRow.max_advance_days || 90} day(s) from now`,
        });
      }

      // Granularity alignment: when slot_duration_minutes is configured
      // AND granularity is hour / minute, requires startsAt (and endsAt)
      // to fall exactly on a slot boundary relative to a sensible anchor.
      if (
        serviceRow.slot_duration_minutes !== null &&
        serviceRow.slot_duration_minutes !== undefined &&
        serviceRow.granularity !== "day"
      ) {
        const slot = serviceRow.slot_duration_minutes;
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

      // Server-side availability check: service-scoped disabled ranges + schedules.
      // This closes the race window where CRM data changes between the
      // customer loading the form and submitting.
      const avail = await checkSlotAvailability(
        reservationId,
        serviceId,
        startsAtIso,
        endsAtIso,
      );
      if (!avail.available) {
        return res.status(400).json({ errorMessage: avail.reason });
      }

      // Optional `data` bag. Only accepted when the reservation permits it;
      // bounded-bag validation matches form submissions.
      let dataJson = null;
      if (body.data !== undefined && body.data !== null) {
        if (!reservation.extra_fields_enabled) {
          return res.status(400).json({
            errorMessage: "extra fields are not enabled for this reservation",
          });
        }
        const data = body.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return res.status(400).json({ errorMessage: "data must be an object" });
        }
        const measurements = measureBag(data);
        if (measurements.depth > DATA_MAX_DEPTH) {
          return res.status(400).json({
            errorMessage: `data exceeds max depth ${DATA_MAX_DEPTH}`,
          });
        }
        if (measurements.keys > DATA_MAX_KEYS_PER_LEVEL) {
          return res.status(400).json({
            errorMessage: `data exceeds max ${DATA_MAX_KEYS_PER_LEVEL} keys per level`,
          });
        }
        try {
          dataJson = JSON.stringify(data);
        } catch {
          return res.status(400).json({ errorMessage: "data is not serialisable" });
        }
        if (Buffer.byteLength(dataJson, "utf8") > DATA_MAX_BYTES) {
          return res.status(400).json({
            errorMessage: `data exceeds max ${DATA_MAX_BYTES} bytes`,
          });
        }
      }

      // Validate contact fields
      const contactResult = validateReservationContact(body);
      if (!contactResult.ok) {
        return res.status(400).json({ errorMessage: contactResult.error });
      }

      // Validate custom fields if provided
      if (body.fields) {
        const fieldDefs = await pool.query(
          `SELECT field_key, field_type, required FROM reservation_service_fields WHERE service_id = $1`,
          [serviceId],
        );
        const fieldsResult = validateReservationServiceFields(fieldDefs.rows, body.fields);
        if (!fieldsResult.ok) {
          return res.status(400).json({ errorMessage: fieldsResult.error });
        }
      }

      // Create booking via transaction with capacity enforcement
      const result = await createReservationBooking({
        reservation,
        service: serviceRow,
        startsAtIso,
        endsAtIso,
        contact: contactResult.value,
        customerId: null,
        customData: body.fields ? { ...(dataJson ? JSON.parse(dataJson || "{}") : {}), ...body.fields } : (dataJson ? JSON.parse(dataJson || "{}") : null),
        locale: locale || reservation.default_locale || "hu",
        createdByUserId: null,
        source: "public",
        workerUserId: null,
      });

      if (result.error) {
        return res.status(result.code === "SLOT_FULL" || result.code === "DUPLICATE_BOOKING" ? 409 : 400).json({ errorMessage: result.error });
      }

      const booking = result.booking;
      const bookingId = Number(booking.id);
      const startsAt = booking.starts_at instanceof Date ? booking.starts_at.toISOString() : booking.starts_at;
      const endsAt = booking.ends_at instanceof Date ? booking.ends_at.toISOString() : booking.ends_at;
      const bookedAt = booking.booked_at instanceof Date ? booking.booked_at.toISOString() : booking.booked_at;

      // Fire-and-forget emails
      const customerName = `${contactResult.value.lastName} ${contactResult.value.firstName}`;

      // Resolve worker info if the service has an assigned worker
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

      // Customer confirmation — project-branded booking email
      // Footer "write to" = project contact email, sign-off = worker name
      notifySubmitter({
        kind: "reservation", projectId: reservation.project_id,
        formName: serviceRow.name || reservation.name, data: null,
        locale: locale || "hu", startsAt, endsAt,
        bookingId, serviceName: serviceRow.name,
        email: contactResult.value.email,
        signerName: workerName || undefined,
        bookingToken: booking.booking_token,
        secretToken,
        timezone: reservation.timezone || "UTC",
      }).catch(() => {});

      // Worker notification — Nexus branding, customer details, no reply hint, no sign-off
      if (workerEmail) {
        notifySubmitter({
          kind: "reservation", projectId: reservation.project_id,
          formName: serviceRow.name || reservation.name, data: null,
          locale: locale || "hu", startsAt, endsAt,
          bookingId, serviceName: serviceRow.name,
          to: workerEmail,
          useBrandDefaults: true,
          customerName,
          customerEmail: contactResult.value.email,
          customerPhone: contactResult.value.phone,
          comment: contactResult.value.comment || null,
          timezone: reservation.timezone || "UTC",
        }).catch(() => {});
      }

      // Optional profile association — "remember me" feature.
      // Only runs when the visitor opted in with a valid token.
      // Best-effort: association failure must not break the booking.
      let customerProfile = null;
      if (
        body.rememberCustomer === true &&
        result.customer &&
        isValidReservationCustomerProfileToken(body.customerProfileToken)
      ) {
        try {
          customerProfile = await upsertReservationCustomerProfile({
            reservationId,
            customerId: result.customer.id,
            profileToken: body.customerProfileToken,
          });
        } catch { /* best-effort: log and continue */ }
      }

      return res.status(201).json({
        id: bookingId,
        startsAt,
        endsAt,
        bookedAt,
        bookingToken: booking.booking_token,
        ...(customerProfile ? { customerProfile } : {}),
      });
    } catch (err) {
      // 23P01 = exclusion_violation — the EXCLUDE constraint fired.
      if (err.code === "23P01") {
        return res.status(409).json({ errorMessage: "Slot already booked" });
      }
      // 23514 — CHECK on (ends_at > starts_at) fired. Pathological: the
      // constraint check was already done above; this only fires if our
      // validation drifts from the DB.
      if (err.code === "23514") {
        return res.status(400).json({ errorMessage: "Invalid date range" });
      }
      console.error("[reservations/public/book]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/public/reservations/:secret_token/catalog
// Public service catalog — returns active services with localized content.
// ===========================================================================
router.get(
  "/:secret_token/catalog",
  reservationAvailabilityBurst,
  reservationSustainedLimiter,
  async (req, res) => {
    try {
      const { secret_token } = req.params;
      const reservation = await loadReservationByToken(secret_token);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Not found" });
      }
      // Origin check
      const requestOrigin = req.headers["x-reservation-parent-origin"] || req.headers.origin || "";
      if (requestOrigin && reservation.allowed_origins && reservation.allowed_origins.length > 0) {
        if (!isOriginAllowed(requestOrigin, normaliseAllowedOrigins(reservation.allowed_origins))) {
          return res.status(404).json({ errorMessage: "Not found" });
        }
      }

      const locale = typeof req.query.locale === "string" ? req.query.locale.trim() : reservation.default_locale || "hu";

      // Load active services with translations, image, worker
      const servicesResult = await pool.query(
        `SELECT rs.*,
                rst_default.name AS default_name, rst_default.description AS default_description,
                rst_requested.name AS requested_name, rst_requested.description AS requested_description,
                u.first_name AS worker_first_name, u.last_name AS worker_last_name,
                rsa.stored_filename AS image_stored_filename
         FROM reservation_services rs
         LEFT JOIN reservation_service_translations rst_default
           ON rst_default.service_id = rs.id AND rst_default.locale = $2
         LEFT JOIN reservation_service_translations rst_requested
           ON rst_requested.service_id = rs.id AND rst_requested.locale = $3
         LEFT JOIN users u ON u.id = rs.worker_user_id
         LEFT JOIN reservation_service_attachments rsa ON rsa.service_id = rs.id AND rsa.purpose = 'cover'
         WHERE rs.reservation_id = $1 AND rs.status = 'active'
         ORDER BY rs.sort_order, rs.id`,
        [reservation.id, reservation.default_locale || "hu", locale],
      );

      // Load public field definitions for each service
      const serviceIds = servicesResult.rows.map((r) => r.id);
      let fieldsMap = {};
      if (serviceIds.length > 0) {
        const fieldsResult = await pool.query(
          `SELECT rsf.id, rsf.service_id, rsf.field_key, rsf.field_type, rsf.required, rsf.sort_order, rsf.options,
                  rfft.label, rfft.placeholder
           FROM reservation_service_fields rsf
           LEFT JOIN reservation_service_field_translations rfft ON rfft.field_id = rsf.id AND rfft.locale = $2
           WHERE rsf.service_id = ANY($1::bigint[])`,
          [serviceIds, locale],
        );
        for (const f of fieldsResult.rows) {
          if (!fieldsMap[f.service_id]) fieldsMap[f.service_id] = [];
          fieldsMap[f.service_id].push({
            fieldKey: f.field_key, fieldType: f.field_type,
            required: f.required, sortOrder: f.sort_order,
            options: f.options, label: f.label || f.field_key,
            placeholder: f.placeholder || null,
          });
        }
      }

      const services = servicesResult.rows.map((s) => ({
        id: s.id,
        name: s.requested_name || s.default_name || "",
        description: s.requested_description || s.default_description || null,
        durationMinutes: s.duration_minutes,
        priceAmount: Number(s.price_amount),
        currency: s.currency,
        capacity: s.capacity,
        workerName: (s.worker_first_name || s.worker_last_name)
          ? (locale === "hu"
              ? `${s.worker_last_name || ""} ${s.worker_first_name || ""}`.trim()
              : `${s.worker_first_name || ""} ${s.worker_last_name || ""}`.trim())
          : null,
        imageUrl: s.image_stored_filename
          ? `/api/public/reservations/assets/${s.image_stored_filename}`
          : null,
        fields: fieldsMap[s.id] || [],
      }));

      return res.json({
        reservation: {
          id: reservation.id,
          title: reservation.name,
          embedTitle: reservation.embed_title || "Időpont foglalás",
          brandColor: reservation.brand_color || "#0A2540",
          iframeWidth: reservation.iframe_width || "100%",
          iframeHeight: reservation.iframe_height || "760px",
          privacyPolicyUrl: reservation.privacy_policy_url || null,
          cookiePolicyUrl: reservation.cookie_policy_url || null,
          defaultLocale: reservation.default_locale || "hu",
          timezone: reservation.timezone || "UTC",
        },
        services,
      });
    } catch (err) {
      console.error("[reservations/public/catalog]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/public/reservations/:secret_token/services/:serviceId/availability
// Service-specific availability — returns slots with remaining seats.
// ===========================================================================
router.get(
  "/:secret_token/services/:serviceId/availability",
  reservationAvailabilityBurst,
  reservationSustainedLimiter,
  async (req, res) => {
    try {
      const { secret_token, serviceId } = req.params;
      const reservation = await loadReservationByToken(secret_token);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Not found" });
      }
      // Origin check
      const requestOrigin = req.headers["x-reservation-parent-origin"] || req.headers.origin || "";
      if (requestOrigin && reservation.allowed_origins && reservation.allowed_origins.length > 0) {
        if (!isOriginAllowed(requestOrigin, normaliseAllowedOrigins(reservation.allowed_origins))) {
          return res.status(404).json({ errorMessage: "Not found" });
        }
      }

      const svcId = parseInt(serviceId, 10);
      if (!Number.isFinite(svcId) || svcId <= 0) {
        return res.status(400).json({ errorMessage: "Invalid service id" });
      }

      // Validate date range
      const from = typeof req.query.from === "string" ? req.query.from.trim() : null;
      const to = typeof req.query.to === "string" ? req.query.to.trim() : null;
      if (!from || !to) {
        return res.status(400).json({ errorMessage: "from and to query params are required (YYYY-MM-DD)" });
      }

      const availability = await getServiceAvailability({
        reservationId: reservation.id,
        serviceId: svcId,
        fromDate: from,
        toDate: to,
      });

      if (!availability) {
        return res.status(404).json({ errorMessage: "Service not found or invalid date range" });
      }

      return res.json(availability);
    } catch (err) {
      console.error("[reservations/public/service-availability]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/public/reservations/assets/:filename
// Public asset serving for service images — mirrors blog-public.js pattern.
// ===========================================================================
const UPLOAD_ROOT_PUBLIC = process.env.UPLOADS_DIR || "/app/uploads";
const FILENAME_RE = /^[a-f0-9-]{36}\.(webp|png|jpg|jpeg|avif)$/i;

router.get("/assets/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    if (!FILENAME_RE.test(filename)) {
      return res.status(404).json({ errorMessage: "Not found" });
    }

    // DB lookup to verify the asset exists and is a reservation service attachment
    const result = await pool.query(
      `SELECT rsa.id FROM reservation_service_attachments rsa WHERE rsa.stored_filename = $1`,
      [filename],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Not found" });
    }

    // Safe path construction — filename is UUID-validated, no traversal possible
    const filePath = path.join(UPLOAD_ROOT_PUBLIC, "reservation-services", filename);

    // Try to find the file in service-specific subdirectories
    let resolvedPath = filePath;
    if (!fs.existsSync(resolvedPath)) {
      // Search in service subdirectories
      const servicesDir = path.join(UPLOAD_ROOT_PUBLIC, "reservation-services");
      if (fs.existsSync(servicesDir)) {
        const entries = fs.readdirSync(servicesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const candidate = path.join(servicesDir, entry.name, filename);
            if (fs.existsSync(candidate)) {
              resolvedPath = candidate;
              break;
            }
          }
        }
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ errorMessage: "File not found" });
    }

    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      ".webp": "image/webp",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".avif": "image/avif",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (err) {
    console.error("[reservations/public/asset]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ===========================================================================
// GET /api/public/reservations/:secret_token/bookings/by-token/:bookingToken
// Public booking lookup — returns booking details for the customer
// self-service manage page. Only returns bookings belonging to the
// reservation identified by secret_token.
// ===========================================================================
router.get(
  "/:secret_token/bookings/by-token/:bookingToken",
  reservationAvailabilityBurst,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken, bookingToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    if (typeof bookingToken !== "string" || bookingToken.length === 0) {
      return res.status(400).json({ errorMessage: "Invalid booking token" });
    }

    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }

      const result = await pool.query(
        `SELECT rb.id, rb.starts_at, rb.ends_at, rb.status,
                rb.first_name, rb.last_name, rb.email, rb.phone, rb.comment,
                rb.service_id, rb.service_name_snapshot,
                rb.duration_minutes_snapshot, rb.price_amount_snapshot,
                rb.currency_snapshot, rb.locale,
                COALESCE(rst.name, rb.service_name_snapshot) AS service_name
         FROM reservation_bookings rb
         LEFT JOIN reservation_service_translations rst
           ON rst.service_id = rb.service_id
           AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id)
         WHERE rb.reservation_id = $1
           AND rb.booking_token = $2`,
        [Number(reservation.id), bookingToken],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }

      const booking = result.rows[0];

      if (booking.status === "cancelled") {
        return res.status(410).json({ errorMessage: "Booking has been cancelled" });
      }

      return res.json({
        id: Number(booking.id),
        startsAt: booking.starts_at instanceof Date ? booking.starts_at.toISOString() : booking.starts_at,
        endsAt: booking.ends_at instanceof Date ? booking.ends_at.toISOString() : booking.ends_at,
        status: booking.status,
        firstName: booking.first_name,
        lastName: booking.last_name,
        email: booking.email,
        phone: booking.phone,
        comment: booking.comment,
        serviceId: Number(booking.service_id),
        serviceName: booking.service_name,
        durationMinutes: booking.duration_minutes_snapshot,
        priceAmount: Number(booking.price_amount_snapshot),
        currency: booking.currency_snapshot,
        locale: booking.locale,
        timezone: reservation.timezone || "UTC",
      });
    } catch (err) {
      console.error("[reservations/public/booking-by-token]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// DELETE /api/public/reservations/:secret_token/bookings/by-token/:bookingToken
// Public booking cancellation — soft-deletes (sets status to cancelled)
// and sends a deletion notification email to the customer.
// ===========================================================================
router.delete(
  "/:secret_token/bookings/by-token/:bookingToken",
  reservationBurstLimiter,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken, bookingToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    if (typeof bookingToken !== "string" || bookingToken.length === 0) {
      return res.status(400).json({ errorMessage: "Invalid booking token" });
    }

    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }

      // Load booking snapshot for email before updating
      const snapshotResult = await pool.query(
        `SELECT rb.id, rb.starts_at, rb.ends_at, rb.locale, rb.status,
                rb.service_name_snapshot, rb.email, rb.customer_id,
                rb.service_id,
                COALESCE(rst.name, rb.service_name_snapshot) AS service_name
         FROM reservation_bookings rb
         LEFT JOIN reservation_service_translations rst
           ON rst.service_id = rb.service_id
           AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id)
         WHERE rb.reservation_id = $1
           AND rb.booking_token = $2`,
        [Number(reservation.id), bookingToken],
      );

      if (snapshotResult.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }

      const booking = snapshotResult.rows[0];

      if (booking.status === "cancelled") {
        return res.status(410).json({ errorMessage: "Booking has been cancelled" });
      }

      // 12-hour guard: prevent cancellation within 12 hours of start
      if (isWithin12Hours(booking.starts_at)) {
        return res.status(400).json({
          errorMessage: "A foglalás kezdete előtt 12 órán belül nem lehetséges a lemondás.",
        });
      }

      // Accept optional cancellation reason from request body
      let cancelReason = "Cancelled by customer";
      try {
        const body = req.body ?? {};
        if (typeof body.reason === "string" && body.reason.trim().length > 0) {
          cancelReason = body.reason.trim().slice(0, 500);
        }
      } catch { /* ignore parse errors */ }

      // Soft-delete: set status to cancelled
      await pool.query(
        `UPDATE reservation_bookings
         SET status = 'cancelled',
             cancelled_at = NOW(),
             cancellation_reason = $3
         WHERE reservation_id = $1
           AND booking_token = $2`,
        [Number(reservation.id), bookingToken, cancelReason],
      );

      // Send deletion notification email (fire-and-forget)
      if (booking.email) {
        notifySubmitter({
          kind: "reservation_deleted",
          projectId: reservation.project_id,
          formName: booking.service_name || "Reservation",
          data: null,
          locale: booking.locale || "hu",
          startsAt: booking.starts_at,
          endsAt: booking.ends_at,
          bookingId: booking.id,
          serviceName: booking.service_name,
          email: booking.email,
          timezone: reservation.timezone || "UTC",
        }).catch(() => {});
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[reservations/public/booking-delete]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ===========================================================================
// PATCH /api/public/reservations/:secret_token/bookings/by-token/:bookingToken/reschedule
// Public booking reschedule — cancels the old booking and creates a new
// one in the requested slot. Uses a transaction with advisory lock to
// prevent races. Returns the new booking ID on success.
// ===========================================================================
router.patch(
  "/:secret_token/bookings/by-token/:bookingToken/reschedule",
  reservationBurstLimiter,
  reservationSustainedLimiter,
  async (req, res) => {
    const { secret_token: secretToken, bookingToken } = req.params;
    if (typeof secretToken !== "string" || secretToken.length !== 22) {
      return res.status(400).json({ errorMessage: "Invalid secret token" });
    }
    if (typeof bookingToken !== "string" || bookingToken.length === 0) {
      return res.status(400).json({ errorMessage: "Invalid booking token" });
    }

    const body = req.body ?? {};

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

    const client = await pool.connect();
    try {
      const reservation = await loadReservationByToken(secretToken);
      if (!reservation) {
        return res.status(404).json({ errorMessage: "Reservation not found" });
      }

      // Load existing booking
      const existingResult = await client.query(
        `SELECT rb.*, rst.name AS service_name
         FROM reservation_bookings rb
         LEFT JOIN reservation_service_translations rst
           ON rst.service_id = rb.service_id
           AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rb.reservation_id)
         WHERE rb.reservation_id = $1
           AND rb.booking_token = $2`,
        [Number(reservation.id), bookingToken],
      );

      if (existingResult.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Booking not found" });
      }

      const existing = existingResult.rows[0];

      if (existing.status === "cancelled") {
        return res.status(410).json({ errorMessage: "Booking has been cancelled" });
      }

      // 12-hour guard: prevent reschedule within 12 hours of start
      if (isWithin12Hours(existing.starts_at)) {
        return res.status(400).json({
          errorMessage: "A foglalás kezdete előtt 12 órán belül nem lehetséges a módosítás.",
        });
      }

      // Load service for window/alignment/capacity checks. Runs BEFORE the
      // old booking is cancelled so invalid requests never mutate state.
      const svcResult = await client.query(
        `SELECT id, status, duration_minutes, capacity, worker_user_id,
                granularity, slot_duration_minutes, lead_time_minutes, max_advance_days
         FROM reservation_services
         WHERE id = $1 AND reservation_id = $2`,
        [existing.service_id, Number(reservation.id)],
      );
      if (svcResult.rowCount === 0 || svcResult.rows[0].status !== "active") {
        return res.status(400).json({ errorMessage: "Service is no longer available" });
      }
      const serviceRow = svcResult.rows[0];

      // Window enforcement: lead time + max advance (per-service config).
      // Without this a customer could reschedule into the past or beyond
      // the booking horizon via a crafted request.
      const nowMs = Date.now();
      const startsMs = new Date(startsAtIso).getTime();
      const leadMs = (serviceRow.lead_time_minutes || 0) * 60 * 1000;
      if (startsMs - nowMs < leadMs) {
        return res.status(400).json({
          errorMessage: `Booking must start at least ${serviceRow.lead_time_minutes || 0} minute(s) from now`,
        });
      }
      const maxAdvanceMs = (serviceRow.max_advance_days || 90) * 24 * 60 * 60 * 1000;
      if (startsMs - nowMs > maxAdvanceMs) {
        return res.status(400).json({
          errorMessage: `Booking cannot start more than ${serviceRow.max_advance_days || 90} day(s) from now`,
        });
      }

      // Slot alignment — same rule as POST /bookings.
      if (
        serviceRow.slot_duration_minutes !== null &&
        serviceRow.slot_duration_minutes !== undefined &&
        serviceRow.granularity !== "day"
      ) {
        const slot = serviceRow.slot_duration_minutes;
        const startDate = new Date(startsAtIso);
        const startDayAnchor = Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
          0, 0, 0, 0,
        );
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

      // Cancel old booking
      await client.query(
        `UPDATE reservation_bookings
         SET status = 'cancelled',
             cancelled_at = NOW(),
             cancellation_reason = 'Rescheduled by customer'
         WHERE id = $1`,
        [existing.id],
      );

      // Check availability for new slot
      const avail = await checkSlotAvailability(
        Number(reservation.id),
        existing.service_id,
        startsAtIso,
        endsAtIso,
        client,
      );
      if (!avail.available) {
        // Restore old booking before returning error
        await client.query(
          `UPDATE reservation_bookings
           SET status = 'confirmed', cancelled_at = NULL, cancellation_reason = NULL
           WHERE id = $1`,
          [existing.id],
        );
        return res.status(409).json({ errorMessage: "Selected time slot is no longer available" });
      }

      // Count overlapping confirmed bookings (capacity check)
      const overlapResult = await client.query(
        `SELECT COUNT(*)::int AS cnt
         FROM reservation_bookings
         WHERE service_id = $1
           AND status = 'confirmed'
           AND id != $4
           AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')`,
        [existing.service_id, startsAtIso, endsAtIso, existing.id],
      );
      const overlapCount = overlapResult.rows[0]?.cnt || 0;
      if (overlapCount >= serviceRow.capacity) {
        // Restore old booking
        await client.query(
          `UPDATE reservation_bookings
           SET status = 'confirmed', cancelled_at = NULL, cancellation_reason = NULL
           WHERE id = $1`,
          [existing.id],
        );
        return res.status(409).json({ errorMessage: "Selected time slot is no longer available" });
      }

      // Create new booking (reuse createReservationBooking with the client)
      const result = await createReservationBooking({
        db: client,
        reservation,
        service: { ...serviceRow, name: existing.service_name, price_amount: existing.price_amount_snapshot, currency: existing.currency_snapshot },
        startsAtIso,
        endsAtIso,
        contact: {
          firstName: existing.first_name,
          lastName: existing.last_name,
          email: existing.email,
          phone: existing.phone,
          comment: existing.comment,
        },
        customerId: existing.customer_id,
        customData: existing.data,
        locale: existing.locale,
        createdByUserId: null,
        source: "public",
        workerUserId: existing.worker_user_id,
      });

      if (result.error) {
        // Restore old booking
        await client.query(
          `UPDATE reservation_bookings
           SET status = 'confirmed', cancelled_at = NULL, cancellation_reason = NULL
           WHERE id = $1`,
          [existing.id],
        );
        return res.status(409).json({ errorMessage: result.error });
      }

      const newBooking = result.booking;

      // Send cancellation email for old booking (fire-and-forget)
      if (existing.email) {
        notifySubmitter({
          kind: "reservation_deleted",
          projectId: reservation.project_id,
          formName: existing.service_name || "Reservation",
          data: null,
          locale: existing.locale || "hu",
          startsAt: existing.starts_at,
          endsAt: existing.ends_at,
          bookingId: existing.id,
          serviceName: existing.service_name,
          email: existing.email,
          timezone: reservation.timezone || "UTC",
        }).catch(() => {});
      }

      // Send confirmation email for new booking (fire-and-forget)
      if (existing.email) {
        notifySubmitter({
          kind: "reservation",
          projectId: reservation.project_id,
          formName: existing.service_name || "Reservation",
          data: null,
          locale: existing.locale || "hu",
          startsAt: newBooking.starts_at,
          endsAt: newBooking.ends_at,
          bookingId: Number(newBooking.id),
          serviceName: existing.service_name,
          email: existing.email,
          bookingToken: newBooking.booking_token,
          secretToken,
        }).catch(() => {});
      }

      return res.status(200).json({
        id: Number(newBooking.id),
        bookingToken: newBooking.booking_token,
        startsAt: newBooking.starts_at instanceof Date ? newBooking.starts_at.toISOString() : newBooking.starts_at,
        endsAt: newBooking.ends_at instanceof Date ? newBooking.ends_at.toISOString() : newBooking.ends_at,
        bookedAt: newBooking.booked_at instanceof Date ? newBooking.booked_at.toISOString() : newBooking.booked_at,
      });
    } catch (err) {
      console.error("[reservations/public/booking-reschedule]", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    } finally {
      client.release();
    }
  },
);
