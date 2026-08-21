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
 * @param {number|null}  serviceId        optional; when provided, checks
 *                                        service-specific schedules first
 * @param {string}  startsAtIso          ISO 8601 UTC
 * @param {string}  endsAtIso            ISO 8601 UTC
 * @param {boolean} disableHungarianHolidays  reservation-level toggle
 * @param {object}  [db=pool]            optional pg pool/client override
 * @returns {Promise<{ available: boolean, reason?: string }>}
 */
export async function checkSlotAvailability(
  reservationId,
  serviceId,
  startsAtIso,
  endsAtIso,
  disableHungarianHolidays,
  db = pool,
) {
  // 1. Disabled ranges overlap check (manual + auto_holiday per toggle).
  //    Disabled ranges are reservation-wide — they block all services.
  const disabledResult = await db.query(
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

  // 2. Availability schedules check — service-level overrides take
  //    precedence; if a service has at least one schedule, use those.
  //    Otherwise inherit the parent reservation schedules.
  //    No schedules at all = open 24/7 (subject to disabled ranges only).
  let schedulesResult;
  if (serviceId) {
    schedulesResult = await db.query(
      `SELECT frequency, day_of_week, day_of_month, start_time, end_time
       FROM reservation_service_availability_schedules
       WHERE service_id = $1`,
      [serviceId],
    );
  }

  // Fall back to parent reservation schedules if no service schedules
  if (!schedulesResult || schedulesResult.rowCount === 0) {
    schedulesResult = await db.query(
      `SELECT frequency, day_of_week, day_of_month, start_time, end_time
       FROM reservation_availability_schedules
       WHERE reservation_id = $1`,
      [reservationId],
    );
  }

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

// ---------------------------------------------------------------------------
// getServiceAvailability — generate available time slots for a service
// within a date range. Used by the public catalog/availability endpoint
// and the admin booking calendar.
//
// Returns:
//   {
//     timezone: string,
//     days: [{ date: 'YYYY-MM-DD', available: boolean }],
//     slots: [{ startsAt, endsAt, date, startTime, endTime, capacity, remainingSeats }]
//   }
//
// `fromDate` and `toDate` are inclusive YYYY-MM-DD strings in the service's
// reservation timezone. Max 31-day range.
// ---------------------------------------------------------------------------

const MAX_AVAILABILITY_DAYS = 31;

export async function getServiceAvailability({
  reservationId,
  serviceId,
  fromDate,
  toDate,
  db = pool,
}) {
  // 1. Load the reservation for timezone and config
  const reservationResult = await db.query(
    `SELECT id, timezone, disable_hungarian_holidays, lead_time_minutes,
            max_advance_days, slot_duration_minutes, granularity
     FROM reservations
     WHERE id = $1`,
    [reservationId],
  );
  if (reservationResult.rowCount === 0) {
    return null;
  }
  const reservation = reservationResult.rows[0];
  const tz = reservation.timezone || "UTC";

  // 2. Load the service for duration, capacity, and scheduling config
  const serviceResult = await db.query(
    `SELECT id, duration_minutes, capacity, status,
            granularity, slot_duration_minutes, lead_time_minutes, max_advance_days
     FROM reservation_services
     WHERE id = $1 AND reservation_id = $2`,
    [serviceId, reservationId],
  );
  if (serviceResult.rowCount === 0 || serviceResult.rows[0].status !== "active") {
    return null;
  }
  const service = serviceResult.rows[0];

  // 3. Validate date range
  if (!fromDate || !toDate) {
    return null;
  }
  const from = new Date(fromDate + "T00:00:00");
  const to = new Date(toDate + "T00:00:00");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return null;
  }
  const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
  if (diffDays < 0 || diffDays >= MAX_AVAILABILITY_DAYS) {
    return null;
  }

  // 4. Load effective schedules (service-level first, then reservation-level)
  let schedulesResult = await db.query(
    `SELECT frequency, day_of_week, day_of_month, start_time, end_time
     FROM reservation_service_availability_schedules
     WHERE service_id = $1`,
    [serviceId],
  );
  if (schedulesResult.rowCount === 0) {
    schedulesResult = await db.query(
      `SELECT frequency, day_of_week, day_of_month, start_time, end_time
       FROM reservation_availability_schedules
       WHERE reservation_id = $1`,
      [reservationId],
    );
  }
  const schedules = schedulesResult.rows;

  // 5. Load disabled ranges for the date window
  const disabledResult = await db.query(
    `SELECT starts_at, ends_at, source, enabled
     FROM reservation_disabled_ranges
     WHERE reservation_id = $1
       AND tstzrange(starts_at, ends_at, '[)') &&
           tstzrange($2::timestamptz, ($3::date + interval '1 day')::timestamptz, '[)')
       AND (
         (source = 'manual' AND enabled = true)
         OR
         (source = 'auto_holiday' AND enabled = true AND $4 = true)
       )`,
    [reservationId, fromDate, toDate, reservation.disable_hungarian_holidays],
  );
  const disabledRanges = disabledResult.rows;

  // 6. Load existing confirmed bookings for the service in this range
  const bookingsResult = await db.query(
    `SELECT starts_at, ends_at
     FROM reservation_bookings
     WHERE service_id = $1
       AND status = 'confirmed'
       AND tstzrange(starts_at, ends_at, '[)') &&
           tstzrange($2::timestamptz, ($3::date + interval '1 day')::timestamptz, '[)')`,
    [serviceId, fromDate, toDate],
  );
  const existingBookings = bookingsResult.rows;

  // 7. Generate slots for each day
  const durationMin = service.duration_minutes;
  const capacity = service.capacity;
  const days = [];
  const slots = [];

  // Helper: format a Date in the reservation timezone as HH:MM
  function formatTimeInTz(date, timezone) {
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    });
  }

  // Helper: format a Date in the reservation timezone as YYYY-MM-DD
  function formatDateInTz(date, timezone) {
    return date.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    });
  }

  // Iterate each day in the range
  const currentDay = new Date(from);
  for (let d = 0; d <= diffDays; d++) {
    const dayStr = formatDateInTz(currentDay, tz);
    const dayOfWeek = currentDay.getDay(); // 0=Sun..6=Sat
    const dayOfMonth = currentDay.getDate();

    // Check if this day has any matching schedule
    let hasSchedule = false;
    if (schedules.length === 0) {
      // No schedules = open 24/7 (within duration constraints)
      hasSchedule = true;
    } else {
      for (const s of schedules) {
        let dayMatches = false;
        if (s.frequency === "daily") {
          dayMatches = true;
        } else if (s.frequency === "weekly") {
          dayMatches = Number(s.day_of_week) === dayOfWeek;
        } else if (s.frequency === "monthly") {
          dayMatches = Number(s.day_of_month) === dayOfMonth;
        }
        if (dayMatches) {
          hasSchedule = true;
          break;
        }
      }
    }

    if (!hasSchedule) {
      days.push({ date: dayStr, available: false });
      currentDay.setDate(currentDay.getDate() + 1);
      continue;
    }

    // Generate time slots for this day based on schedules
    let dayHasAvailableSlot = false;
    const scheduleWindows = schedules.length === 0
      ? [{ start_time: "00:00", end_time: "24:00" }]
      : schedules.filter((s) => {
          if (s.frequency === "daily") return true;
          if (s.frequency === "weekly") return Number(s.day_of_week) === dayOfWeek;
          if (s.frequency === "monthly") return Number(s.day_of_month) === dayOfMonth;
          return false;
        });

    for (const window of scheduleWindows) {
      const winStart = typeof window.start_time === "string" ? window.start_time.slice(0, 5) : window.start_time;
      const winEnd = typeof window.end_time === "string" ? window.end_time.slice(0, 5) : window.end_time;

      // Parse window start/end as minutes from midnight
      const [wsH, wsM] = winStart.split(":").map(Number);
      const [weH, weM] = winEnd.split(":").map(Number);
      const winStartMin = wsH * 60 + wsM;
      const winEndMin = weH * 60 + weM;

      // Generate slots at the service's granularity interval
      const interval = service.slot_duration_minutes || durationMin;
      for (let min = winStartMin; min + durationMin <= winEndMin; min += interval) {
        const slotStartH = Math.floor(min / 60);
        const slotStartM = min % 60;
        const slotEndMin = min + durationMin;
        const slotEndH = Math.floor(slotEndMin / 60);
        const slotEndM = slotEndMin % 60;

        const startTime = `${String(slotStartH).padStart(2, "0")}:${String(slotStartM).padStart(2, "0")}`;
        const endTime = `${String(slotEndH).padStart(2, "0")}:${String(slotEndM).padStart(2, "0")}`;

        // Convert local time to ISO UTC using the reservation timezone
        // Build a date string and parse it in the target timezone
        const localDateTimeStr = `${dayStr}T${startTime}:00`;
        const startsAtDate = new Date(localDateTimeStr);
        // Adjust for timezone offset: get the UTC time that corresponds to
        // this local time in the reservation timezone
        const tzOffset = getUtcOffsetMinutes(localDateTimeStr, tz);
        const startsAt = new Date(startsAtDate.getTime() - tzOffset * 60000);
        const endsAt = new Date(startsAt.getTime() + durationMin * 60000);

        const startsAtIso = startsAt.toISOString();
        const endsAtIso = endsAt.toISOString();

        // Skip if in the past (lead time check)
        const now = new Date();
        const leadTimeMs = (service.lead_time_minutes || 0) * 60000;
        if (startsAt.getTime() < now.getTime() + leadTimeMs) {
          continue;
        }

        // Skip if max advance exceeded
        if (service.max_advance_days) {
          const maxAdvanceMs = service.max_advance_days * 24 * 60 * 60 * 1000;
          if (startsAt.getTime() > now.getTime() + maxAdvanceMs) {
            continue;
          }
        }

        // Skip if overlaps a disabled range
        const overlapsDisabled = disabledRanges.some((dr) => {
          const drStart = new Date(dr.starts_at).getTime();
          const drEnd = new Date(dr.ends_at).getTime();
          return startsAt.getTime() < drEnd && drStart < endsAt.getTime();
        });
        if (overlapsDisabled) continue;

        // Skip if already fully booked
        const overlapCount = existingBookings.filter((b) => {
          const bStart = new Date(b.starts_at).getTime();
          const bEnd = new Date(b.ends_at).getTime();
          return startsAt.getTime() < bEnd && bStart < endsAt.getTime();
        }).length;

        const remainingSeats = capacity - overlapCount;
        if (remainingSeats > 0) {
          dayHasAvailableSlot = true;
        }
        slots.push({
          startsAt: startsAtIso,
          endsAt: endsAtIso,
          date: dayStr,
          startTime,
          endTime,
          capacity,
          remainingSeats,
        });
      }
    }

    days.push({ date: dayStr, available: dayHasAvailableSlot });
    currentDay.setDate(currentDay.getDate() + 1);
  }

  return { timezone: tz, days, slots };
}

// ---------------------------------------------------------------------------
// getUtcOffsetMinutes — compute the UTC offset in minutes for a local
// datetime string in a given IANA timezone. Uses Intl.DateTimeFormat
// for DST-safe calculation.
// ---------------------------------------------------------------------------
function getUtcOffsetMinutes(localDateTimeStr, timezone) {
  // Parse the components
  const match = localDateTimeStr.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match.map(Number);

  // Create a formatter for the target timezone
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

  // Find the UTC offset by comparing the timezone time to UTC
  // Create a date in UTC
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  // Format it in the target timezone to get the local time components
  const parts = formatter.formatToParts(utcDate);
  const tzValues = {};
  for (const p of parts) {
    tzValues[p.type] = parseInt(p.value, 10);
  }
  // The UTC offset is the difference between UTC and the timezone representation
  const tzAsUTC = Date.UTC(
    tzValues.year, tzValues.month - 1, tzValues.day,
    tzValues.hour === 24 ? 0 : tzValues.hour,
    tzValues.minute, tzValues.second || 0,
  );
  return (utcDate.getTime() - tzAsUTC) / 60000;
}
