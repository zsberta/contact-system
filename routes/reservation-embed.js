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
import { pool } from "../db/pool.js";
import { notifyProjectOwner, notifySubmitter } from "../lib/email.js";
import { checkSlotAvailability } from "../lib/reservation-availability.js";

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
// the shared lib so the import feature can run the same checks via dry-run.
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
// Reservation configurator — fetch by secret_token, returning every field
// the public endpoints need in one round-trip. Returns null when the token
// is unknown OR the reservation is disabled (indistinguishable from the
// caller's perspective).
// ---------------------------------------------------------------------------

async function loadReservationByToken(secretToken) {
  const { rows } = await pool.query(
    `SELECT id, status, allowed_origins, granularity, slot_duration_minutes,
            lead_time_minutes, max_advance_days, extra_fields_enabled,
            disable_hungarian_holidays
     FROM reservations
     WHERE secret_token = $1`,
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

      // Window enforcement: lead time + max advance.
      const nowMs = Date.now();
      const startsMs = new Date(startsAtIso).getTime();
      const leadMs = reservation.lead_time_minutes * 60 * 1000;
      if (startsMs - nowMs < leadMs) {
        return res.status(400).json({
          errorMessage: `Booking must start at least ${reservation.lead_time_minutes} minute(s) from now`,
        });
      }
      const maxAdvanceMs = reservation.max_advance_days * 24 * 60 * 60 * 1000;
      if (startsMs - nowMs > maxAdvanceMs) {
        return res.status(400).json({
          errorMessage: `Booking cannot start more than ${reservation.max_advance_days} day(s) from now`,
        });
      }

      // Granularity alignment: when slot_duration_minutes is configured
      // AND granularity is hour / minute, requires startsAt (and endsAt)
      // to fall exactly on a slot boundary relative to a sensible anchor.
      // We use "00:00 of startsAt's UTC calendar day" as the anchor; any
      // other anchor would require the operator to declare one, which is
      // a future feature.
      if (
        reservation.slot_duration_minutes !== null &&
        reservation.slot_duration_minutes !== undefined &&
        reservation.granularity !== "day"
      ) {
        const slot = reservation.slot_duration_minutes;
        if (slot > SLOT_GRID_MAX_MINUTES) {
          // Defensive — admin route already caps this.
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
        // Also check endsAt alignment.
        const endDate = new Date(endsAtIso);
        const endOffsetMin = Math.round((endDate.getTime() - startDayAnchor) / 60000);
        if (endOffsetMin <= 0 || (endOffsetMin % slot) !== 0) {
          return res.status(400).json({
            errorMessage: `endsAt must align to ${slot}-minute slot boundary`,
          });
        }
      }

      // Server-side availability check: disabled ranges + schedules.
      // This closes the race window where CRM data changes between the
      // customer loading the form and submitting.
      const avail = await checkSlotAvailability(
        reservationId,
        startsAtIso,
        endsAtIso,
        reservation.disable_hungarian_holidays,
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

      // Capture metadata. Clamp user-agent / referer to safe upper bounds.
      const ipAddress = req.ip || req.socket?.remoteAddress || null;
      const userAgent = typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null;
      const referer = typeof req.headers.referer === "string"
        ? req.headers.referer.slice(0, 2000)
        : null;

      // Atomicity: EXCLUDE constraint on (reservation_id, tstzrange). Two
      // concurrent POSTs at the same slot — one wins, one fails with 23P01.
      const insertResult = await pool.query(
        `INSERT INTO reservation_bookings
          (reservation_id, starts_at, ends_at, ip_address, user_agent, referer, locale, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id, starts_at, ends_at, booked_at`,
        [
          reservationId,
          startsAtIso,
          endsAtIso,
          ipAddress,
          userAgent,
          referer,
          locale,
          dataJson,
        ],
      );

      const row = insertResult.rows[0];
      const startsAt = row.starts_at instanceof Date
        ? row.starts_at.toISOString()
        : row.starts_at;
      const endsAt = row.ends_at instanceof Date
        ? row.ends_at.toISOString()
        : row.ends_at;
      const bookedAt = row.booked_at instanceof Date
        ? row.booked_at.toISOString()
        : row.booked_at;
      const bookingId = Number(row.id);

      // Fire-and-forget emails. Same best-effort contract as the
      // form-submission path: the booking is already persisted; an email
      // failure MUST NOT fail the 201. Two parallel sends — operator
      // notification + submitter auto-reply.
      pool
        .query(`SELECT project_id, name FROM reservations WHERE id = $1`, [reservationId])
        .then((cfg) => {
          if (cfg.rowCount === 0) return;
          const projectId = Number(cfg.rows[0].project_id);
          const reservationName = cfg.rows[0].name;
          let parsedData = null;
          if (dataJson) {
            try { parsedData = JSON.parse(dataJson); } catch { /* keep null */ }
          }
          const notifyArgs = {
            kind: "reservation",
            projectId,
            formName: reservationName,
            data: parsedData,
            locale,
            startsAt,
            endsAt,
          };
          Promise.all([
            notifyProjectOwner(notifyArgs),
            notifySubmitter(notifyArgs),
          ]);
        })
        .catch((err) => {
          console.error("[reservations/public/notify]", err.code || "", err.message);
        });

      return res.status(201).json({
        id: bookingId,
        startsAt,
        endsAt,
        bookedAt,
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
