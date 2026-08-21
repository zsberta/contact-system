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
 * granularity, slot_duration_minutes, extra_fields_enabled).
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
  service,
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
  // When a service is provided, pass its id for service-level checks.
  const avail = await Promise.resolve(
    checkAvailability(
      reservation.id,
      service?.id || null,
      startsAtIso,
      endsAtIso,
    ),
  );
  if (!avail.available) {
    return { ok: false, error: avail.reason };
  }

  // Existing-bookings overlap check. Only triggered when the caller passes
  // `pool` + `checkExistingBookings: true` (the dry-run + import flow).
  // When a service is provided, scope the overlap check to that service
  // (capacity is per-service, not reservation-wide).
  if (checkExistingBookings && pool) {
    const serviceId = service?.id;
    const overlapResult = await pool.query(
      `SELECT 1
       FROM reservation_bookings
       WHERE service_id = $1
         AND status = 'confirmed'
         AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
       LIMIT 1`,
      [serviceId, startsAtIso, endsAtIso],
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

// ---------------------------------------------------------------------------
// validateReservationContact — validates the five fixed contact fields
// required for every new booking. Always required: firstName, lastName,
// email, phone. Optional: comment.
//
// Returns { ok: true, value: { firstName, lastName, email, phone, comment } }
// or     { ok: false, error: string }
// ---------------------------------------------------------------------------

const CONTACT_NAME_MAX = 100;
const CONTACT_PHONE_MAX = 30;
const CONTACT_COMMENT_MAX = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateReservationContact(raw, { requireComment = false } = {}) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Contact data is required" };
  }

  const firstName = typeof raw.firstName === "string" ? raw.firstName.trim() : "";
  const lastName = typeof raw.lastName === "string" ? raw.lastName.trim() : "";
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const comment = typeof raw.comment === "string" ? raw.comment.trim() : "";

  if (!firstName) return { ok: false, error: "firstName is required" };
  if (firstName.length > CONTACT_NAME_MAX) return { ok: false, error: `firstName exceeds ${CONTACT_NAME_MAX} characters` };

  if (!lastName) return { ok: false, error: "lastName is required" };
  if (lastName.length > CONTACT_NAME_MAX) return { ok: false, error: `lastName exceeds ${CONTACT_NAME_MAX} characters` };

  if (!email) return { ok: false, error: "email is required" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "email is invalid" };

  if (!phone) return { ok: false, error: "phone is required" };
  if (phone.length > CONTACT_PHONE_MAX) return { ok: false, error: `phone exceeds ${CONTACT_PHONE_MAX} characters` };

  if (requireComment && !comment) return { ok: false, error: "comment is required" };
  if (comment.length > CONTACT_COMMENT_MAX) return { ok: false, error: `comment exceeds ${CONTACT_COMMENT_MAX} characters` };

  return {
    ok: true,
    value: { firstName, lastName, email, phone, comment: comment || null },
  };
}

// ---------------------------------------------------------------------------
// validateReservationServiceFields — validates declared custom field values
// against the service's field definitions. Rejects unknown keys, invalid
// select values, missing required fields, and oversized values.
//
// `fieldDefinitions` is the array from reservation_service_fields + translations.
// `values` is the raw key/value object from the booking request.
//
// Returns { ok: true, value: { key: sanitizedValue, ... } }
// or     { ok: false, error: string }
// ---------------------------------------------------------------------------

const FIELD_VALUE_MAX = 500;

export function validateReservationServiceFields(fieldDefinitions, values) {
  if (!fieldDefinitions || fieldDefinitions.length === 0) {
    return { ok: true, value: {} };
  }

  if (!values || typeof values !== "object" || Array.isArray(values)) {
    // Check if any fields are required
    const requiredFields = fieldDefinitions.filter((f) => f.required);
    if (requiredFields.length > 0) {
      return { ok: false, error: `Missing required field: ${requiredFields[0].field_key}` };
    }
    return { ok: true, value: {} };
  }

  const allowedKeys = new Set(fieldDefinitions.map((f) => f.field_key));
  const result = {};

  // Check for unknown keys
  for (const key of Object.keys(values)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }

  // Validate each defined field
  for (const def of fieldDefinitions) {
    const val = values[def.field_key];

    if (val === undefined || val === null || val === "") {
      if (def.required) {
        return { ok: false, error: `Missing required field: ${def.field_key}` };
      }
      continue;
    }

    // Type-specific validation
    if (def.field_type === "checkbox") {
      if (typeof val !== "boolean" && val !== "true" && val !== "false") {
        return { ok: false, error: `Field ${def.field_key} must be a boolean` };
      }
      result[def.field_key] = val === true || val === "true";
      continue;
    }

    if (def.field_type === "select") {
      const strVal = String(val);
      if (def.options && Array.isArray(def.options)) {
        if (!def.options.includes(strVal)) {
          return { ok: false, error: `Field ${def.field_key} has invalid option: ${strVal}` };
        }
      }
      result[def.field_key] = strVal;
      continue;
    }

    // text / textarea
    const strVal = String(val).trim();
    if (strVal.length > FIELD_VALUE_MAX) {
      return { ok: false, error: `Field ${def.field_key} exceeds ${FIELD_VALUE_MAX} characters` };
    }
    result[def.field_key] = strVal;
  }

  return { ok: true, value: result };
}
