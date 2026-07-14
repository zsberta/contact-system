// ---------------------------------------------------------------------------
// Server-side slot availability check — shared between the public embed
// endpoint (reservation-embed.js) and the admin endpoint (reservations.js).
//
// Verifies the requested booking window doesn't overlap a disabled range
// AND (when schedules are configured) falls within at least one schedule
// window.  This closes the race window where the FE derived slots from
// availability data but the backend never re-validated at submit time.
// ---------------------------------------------------------------------------

import { pool } from "../db/pool.js";

/**
 * Check whether a [startsAt, endsAt) window is available for booking.
 *
 * @param {number}  reservationId
 * @param {string}  startsAtIso          ISO 8601 UTC
 * @param {string}  endsAtIso            ISO 8601 UTC
 * @param {boolean} disableHungarianHolidays  reservation-level toggle
 * @returns {Promise<{ available: boolean, reason?: string }>}
 */
export async function checkSlotAvailability(
  reservationId,
  startsAtIso,
  endsAtIso,
  disableHungarianHolidays,
) {
  // 1. Disabled ranges overlap check (manual + auto_holiday per toggle).
  const disabledResult = await pool.query(
    `SELECT 1
     FROM reservation_disabled_ranges
     WHERE reservation_id = $1
       AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
       AND (
         (source = 'manual' AND enabled = true)
         OR
         (source = 'auto_holiday' AND enabled = true AND $4 = true)
       )
     LIMIT 1`,
    [reservationId, startsAtIso, endsAtIso, disableHungarianHolidays],
  );

  if (disabledResult.rowCount > 0) {
    return { available: false, reason: "This time slot is not available" };
  }

  // 2. Availability schedules check — when at least one schedule is
  //    configured, the booking's start time must fall inside a window.
  //    No schedules = open 24/7 (subject to disabled ranges only).
  const schedulesResult = await pool.query(
    `SELECT frequency, day_of_week, day_of_month, start_time, end_time
     FROM reservation_availability_schedules
     WHERE reservation_id = $1`,
    [reservationId],
  );

  if (schedulesResult.rowCount === 0) {
    return { available: true };
  }

  // Extract UTC day-of-week (0=Sun..6=Sat), day-of-month (1..31),
  // and HH:MM time string from the booking start instant.
  const startDate = new Date(startsAtIso);
  const dow = startDate.getUTCDay();
  const dom = startDate.getUTCDate();
  const timeHHMM = `${String(startDate.getUTCHours()).padStart(2, "0")}:${String(startDate.getUTCMinutes()).padStart(2, "0")}`;

  for (const s of schedulesResult.rows) {
    let dayMatches = false;
    if (s.frequency === "daily") {
      dayMatches = true;
    } else if (s.frequency === "weekly") {
      dayMatches = Number(s.day_of_week) === dow;
    } else if (s.frequency === "monthly") {
      dayMatches = Number(s.day_of_month) === dom;
    }
    if (!dayMatches) continue;

    const schedStart = typeof s.start_time === "string" ? s.start_time.slice(0, 5) : s.start_time;
    const schedEnd   = typeof s.end_time   === "string" ? s.end_time.slice(0, 5)   : s.end_time;

    if (timeHHMM >= schedStart && timeHHMM < schedEnd) {
      return { available: true };
    }
  }

  return { available: false, reason: "This time slot is outside the configured availability hours" };
}
