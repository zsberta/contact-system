// ----------------------------------------------------------------------------
// booking-validation — shared validators used by the public reservation
// submission route (routes/reservation-embed.js) and the admin booking-creation
// route (routes/reservations.js). Extracted so the import feature can run
// the EXACT same checks via a dry-run endpoint, without inserting the row.
// ----------------------------------------------------------------------------

// Maximum grid size enforced at the route layer (defence — admin route caps this).
export const SLOT_GRID_MAX_MINUTES = 24 * 60;

// Same bounds on the optional `data` bag as the public endpoint.
export const DATA_MAX_KEYS_PER_LEVEL = 50;
export const DATA_MAX_DEPTH = 5;
export const DATA_MAX_BYTES = 50 * 1024;

// Strict ISO 8601 parse — accepts Z or explicit ±HH:MM offset; rejects
// loose formats the JS Date parser would silently accept.
export function parseStrictIso(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s,
    )
  ) {
    return null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 19) !== s.slice(0, 19)) return null;
  return d;
}

// Recursively measure the keys in any nested plain object + nesting depth.
// Implementation note: when the recursion would cross DATA_MAX_DEPTH, we
// stop early but record `results.depth = DATA_MAX_DEPTH + 1`. Combined
// with the `> DATA_MAX_DEPTH` check at the call site, this guarantees
// that any payload whose deepest leaf is at depth >= DATA_MAX_DEPTH + 1
// is rejected — including pathological cases the old logic let through
// (it stopped recursing while `currentDepth < DATA_MAX_DEPTH`, so
// deep-nested objects were silently accepted as long as their topmost
// `DATA_MAX_DEPTH` levels were plain objects). Fix: see
// 08-gotchas/reservations-public-data-depth-limit-not-enforced-2026-07-04.
export function measureBag(obj, currentDepth = 1, results = { keys: 0, depth: 1 }) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return results;
  const keys = Object.keys(obj).length;
  if (keys > results.keys) results.keys = keys;
  if (currentDepth > results.depth) results.depth = currentDepth;
  if (currentDepth > DATA_MAX_DEPTH) {
    results.depth = DATA_MAX_DEPTH + 1;
    return results;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      measureBag(v, currentDepth + 1, results);
    }
  }
  return results;
}

/**
 * Run the full booking-create validation for one item, without inserting.
 * The `reservation` row must already be loaded by the caller (id, status,
 * granularity, slot_duration_minutes, disable_hungarian_holidays,
 * extra_fields_enabled).
 *
 * `checkAvailability` is the project's checkSlotAvailability(...).
 *
 * `pool` (pg pool) is only used when `checkExistingBookings` is true —
 * passes through to validateBookingItem so it can do a dry-run-friendly
 * "is this slot already booked?" check. The public submission path does
 * NOT pass this; it relies on the EXCLUDE constraint firing at INSERT.
 * The dry-run + import flow DOES pass it so the user gets an accurate
 * preview (otherwise they'd see "6 valid" and then Save would 409 on
 * every row that already exists in the DB).
 *
 * Returns:
 *   { ok: true,  startsAtIso, endsAtIso, dataJson } — caller can proceed
 *                                                   with the INSERT.
 *   { ok: false, error } — caller should surface this to the user.
 *
 * Mirrors the validation sequence in routes/reservations.js
 * `POST /api/reservations/:id/bookings` (admin) so the dry-run result is a
 * faithful preview of what the create would do.
 */
export async function validateBookingItem({
  body,
  reservation,
  checkAvailability,
  pool,
  checkExistingBookings,
}) {
  const startsAt = parseStrictIso(body?.startsAt);
  const endsAt = parseStrictIso(body?.endsAt);
  if (!startsAt || !endsAt) {
    return { ok: false, error: "startsAt and endsAt must be ISO 8601 UTC" };
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    return { ok: false, error: "endsAt must be after startsAt" };
  }
  const startsAtIso = startsAt.toISOString();
  const endsAtIso = endsAt.toISOString();

  // Granularity / slot alignment — same as admin create.
  if (
    reservation.slot_duration_minutes !== null &&
    reservation.slot_duration_minutes !== undefined &&
    reservation.granularity !== "day"
  ) {
    const slot = reservation.slot_duration_minutes;
    if (slot > SLOT_GRID_MAX_MINUTES) {
      return { ok: false, error: "Server misconfiguration" };
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
      return {
        ok: false,
        error: `startsAt must align to ${slot}-minute slot boundary`,
      };
    }
    const endDate = new Date(endsAtIso);
    const endOffsetMin = Math.round(
      (endDate.getTime() - startDayAnchor) / 60000,
    );
    if (endOffsetMin <= 0 || (endOffsetMin % slot) !== 0) {
      return {
        ok: false,
        error: `endsAt must align to ${slot}-minute slot boundary`,
      };
    }
  }

  // Server-side availability (disabled ranges + schedules).
  const avail = await Promise.resolve(
    checkAvailability(
      reservation.id,
      startsAtIso,
      endsAtIso,
      reservation.disable_hungarian_holidays,
    ),
  );
  if (!avail.available) {
    return { ok: false, error: avail.reason };
  }

  // Existing-bookings overlap check. Only triggered when the caller passes
  // `pool` + `checkExistingBookings: true` (the dry-run + import flow).
  // We use the same range-overlap semantics as the EXCLUDE constraint so
  // the dry-run mirrors what the DB will reject at INSERT.
  if (checkExistingBookings && pool) {
    const overlapResult = await pool.query(
      `SELECT 1
       FROM reservation_bookings
       WHERE reservation_id = $1
         AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
       LIMIT 1`,
      [reservation.id, startsAtIso, endsAtIso],
    );
    if (overlapResult.rowCount > 0) {
      return { ok: false, error: "Slot already booked" };
    }
  }

  // Optional `data` bag — bounded-bag check matches the public endpoint.
    let dataJson = null;
    if (body?.data !== undefined && body?.data !== null) {
      if (!reservation.extra_fields_enabled) {
        return {
          ok: false,
          error: "extra fields are not enabled for this reservation",
        };
      }
      const data = body.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, error: "data must be an object" };
      }
      const measurements = measureBag(data);
      if (measurements.depth > DATA_MAX_DEPTH) {
        return {
          ok: false,
          error: `data exceeds max depth ${DATA_MAX_DEPTH}`,
        };
      }
      if (measurements.keys > DATA_MAX_KEYS_PER_LEVEL) {
        return {
          ok: false,
          error: `data exceeds max ${DATA_MAX_KEYS_PER_LEVEL} keys per level`,
        };
      }
      try {
        dataJson = JSON.stringify(data);
      } catch {
        return { ok: false, error: "data is not serialisable" };
      }
      if (Buffer.byteLength(dataJson, "utf8") > DATA_MAX_BYTES) {
        return {
          ok: false,
          error: `data exceeds max ${DATA_MAX_BYTES} bytes`,
        };
      }
    }

    return { ok: true, startsAtIso, endsAtIso, dataJson };
}
