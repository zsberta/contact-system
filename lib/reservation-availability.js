// ---------------------------------------------------------------------------
// Server-side slot availability check — shared between the public embed
// endpoint (reservation-embed.js) and the admin endpoint (reservations.js).
//
// Verifies the requested booking window doesn't overlap a disabled range
// AND (when schedules are configured) falls within at least one schedule
// window.  This closes the race window where the FE derived slots from
// availability data but the backend never re-validated at submit time.
//
// Two blocking mechanisms (independent, can both apply):
//   1. Manual disabled ranges — linked to services via join table.
//   2. Holiday rules — per-service rules in reservation_service_holiday_rules.
//      Holidays are computed dynamically from the calendar, not from rows.
// ---------------------------------------------------------------------------

import { pool } from "../db/pool.js";
import { isHungarianHoliday } from "./hungarian-holidays.js";

/**
 * Check whether a [startsAt, endsAt) window is available for booking.
 *
 * Service-scoped: disabled ranges only block a service when:
 *   - manual range is linked to the service via reservation_disabled_range_services, OR
 *   - the slot falls on a holiday and the service has an enabled holiday rule.
 *   - When serviceId is null (legacy callers), blocked when ANY service is affected.
 *
 * @param {number}  reservationId
 * @param {number|null}  serviceId        optional; when provided, checks
 *                                        service-specific disabled ranges + schedules
 * @param {string}  startsAtIso          ISO 8601 UTC
 * @param {string}  endsAtIso            ISO 8601 UTC
 * @param {object}  [db=pool]            optional pg pool/client override
 * @returns {Promise<{ available: boolean, reason?: string }>}
 */
export async function checkSlotAvailability(
  reservationId,
  serviceId,
  startsAtIso,
  endsAtIso,
  db = pool,
) {
  // Reservation timezone — schedule windows and holiday keys are defined in
  // LOCAL wall-clock time, not UTC. A 00:00 Budapest slot starts at 22:00Z
  // on the previous UTC day, so the slot's UTC clock must never be compared
  // against local windows directly.
  const tzResult = await db.query(`SELECT timezone FROM reservations WHERE id = $1`, [reservationId]);
  const tz = tzResult.rows[0]?.timezone || "UTC";
  const startDate = new Date(startsAtIso);
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const localParts = Object.fromEntries(
    tzFormatter.formatToParts(startDate).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const localYear = Number(localParts.year);
  const localMonth = Number(localParts.month);
  const localDay = Number(localParts.day);
  const localHour = localParts.hour === "24" ? 0 : Number(localParts.hour);
  const localMinute = Number(localParts.minute);

  // 1. Manual disabled ranges overlap check — service-scoped.
  if (serviceId) {
    const manualResult = await db.query(
      `SELECT 1
       FROM reservation_disabled_ranges dr
       WHERE dr.reservation_id = $1
         AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange($2, $3, '[)')
         AND dr.enabled = true
         AND dr.source = 'manual'
         AND EXISTS (
           SELECT 1 FROM reservation_disabled_range_services drs
           WHERE drs.disabled_range_id = dr.id AND drs.service_id = $4
         )
       LIMIT 1`,
      [reservationId, startsAtIso, endsAtIso, serviceId],
    );
    if (manualResult.rowCount > 0) {
      return { available: false, reason: "This time slot is not available" };
    }
  } else {
    // Fallback: no service context — blocked when any service has a manual range.
    const manualResult = await db.query(
      `SELECT 1
       FROM reservation_disabled_ranges dr
       WHERE dr.reservation_id = $1
         AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange($2, $3, '[)')
         AND dr.enabled = true
         AND dr.source = 'manual'
         AND EXISTS (
           SELECT 1 FROM reservation_disabled_range_services drs
           WHERE drs.disabled_range_id = dr.id
         )
       LIMIT 1`,
      [reservationId, startsAtIso, endsAtIso],
    );
    if (manualResult.rowCount > 0) {
      return { available: false, reason: "This time slot is not available" };
    }
  }

  // 2. Holiday rules check — dynamic, per-service.
  //    Check if the slot's start date is a Hungarian holiday AND
  //    the service (or any service) has an enabled rule for it.
  const holidayKey = isHungarianHoliday(localYear, localMonth, localDay);
  if (holidayKey) {
    if (serviceId) {
      const ruleResult = await db.query(
        `SELECT 1 FROM reservation_service_holiday_rules
         WHERE service_id = $1 AND holiday_key = $2 AND enabled = true
         LIMIT 1`,
        [serviceId, holidayKey],
      );
      if (ruleResult.rowCount > 0) {
        return { available: false, reason: "This time slot is not available" };
      }
    } else {
      // No service context — blocked when any service has an enabled rule.
      const ruleResult = await db.query(
        `SELECT 1 FROM reservation_service_holiday_rules
         WHERE holiday_key = $1 AND enabled = true
         LIMIT 1`,
        [holidayKey],
      );
      if (ruleResult.rowCount > 0) {
        return { available: false, reason: "This time slot is not available" };
      }
    }
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

  // Local day-of-week (0=Sun..6=Sat), day-of-month (1..31), and HH:MM
  // wall-clock time of the slot start — windows are local, not UTC.
  const dow = new Date(Date.UTC(localYear, localMonth - 1, localDay)).getUTCDay();
  const dom = localDay;
  const timeHHMM = `${String(localHour).padStart(2, "0")}:${String(localMinute).padStart(2, "0")}`;

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

/**
 * Get the UTC offset in milliseconds for a timezone at a given point in time.
 * Handles DST correctly by checking whether the date falls in summer or winter.
 *
 * SIGN CONVENTION: Returns POSITIVE for east-of-UTC zones (e.g. +7200000 for
 * Budapest in summer). To convert UTC → local: `utcMs + offsetMs`.
 * This is the OPPOSITE of getUtcOffsetMinutes (which returns negative for
 * east-of-UTC).
 */
function getTzOffsetMs(timezone, date) {
  // Determine if the date is in DST for this timezone.
  // Summer (CEST): last Sunday of March → last Sunday of October (EU rules)
  const jan = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const jul = new Date(Date.UTC(date.getUTCFullYear(), 6, 1));
  // Use Intl to check the offset in January vs July
  const janOffset = getOffsetForMonth(date.getUTCFullYear(), 0, timezone);
  const julOffset = getOffsetForMonth(date.getUTCFullYear(), 6, timezone);
  const stdOffset = Math.min(janOffset, julOffset); // winter is the larger UTC offset
  const dstOffset = Math.max(janOffset, julOffset); // summer is the smaller UTC offset
  // Check if the date is in DST by comparing its offset to the std offset
  const dateOffset = getOffsetAtDate(date, timezone);
  return dateOffset;
}

function getOffsetForMonth(year, month, timezone) {
  const d = new Date(Date.UTC(year, month, 15, 12, 0, 0));
  return getOffsetAtDate(d, timezone);
}

function getOffsetAtDate(date, timezone) {
  // Format the date in the target timezone and in UTC, then diff
  const tzStr = date.toLocaleString("en-US", { timeZone: timezone, hour12: false });
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
  const tzDate = new Date(tzStr);
  const utcDate = new Date(utcStr);
  return tzDate.getTime() - utcDate.getTime();
}

export async function getServiceAvailability({
  reservationId,
  serviceId,
  fromDate,
  toDate,
  db = pool,
}) {
  // 1. Load the reservation for timezone and config
  const reservationResult = await db.query(
    `SELECT id, timezone, lead_time_minutes,
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

  // 5. Load manual disabled ranges for the date window — service-scoped.
  const disabledResult = await db.query(
    `SELECT dr.starts_at, dr.ends_at, dr.source, dr.enabled
     FROM reservation_disabled_ranges dr
     WHERE dr.reservation_id = $1
       AND tstzrange(dr.starts_at, dr.ends_at, '[)') &&
           tstzrange($2::timestamptz - interval '1 day', ($3::date + interval '2 day')::timestamptz, '[)')
       AND dr.enabled = true
       AND dr.source = 'manual'
       AND EXISTS (
         SELECT 1 FROM reservation_disabled_range_services drs
         WHERE drs.disabled_range_id = dr.id AND drs.service_id = $4
       )
       LIMIT 1`,
    [reservationId, fromDate, toDate, serviceId],
  );
  const disabledRanges = disabledResult.rows;

  // 5b. Load holiday rules for this service.
  const holidayRulesResult = await db.query(
    `SELECT holiday_key FROM reservation_service_holiday_rules
     WHERE service_id = $1 AND enabled = true`,
    [serviceId],
  );
  const enabledHolidays = new Set(holidayRulesResult.rows.map((r) => r.holiday_key));

  // 6. Load existing confirmed bookings for the service in this range
  const bookingsResult = await db.query(
    `SELECT starts_at, ends_at
     FROM reservation_bookings
     WHERE service_id = $1
       AND status = 'confirmed'
       AND tstzrange(starts_at, ends_at, '[)') &&
           tstzrange($2::timestamptz - interval '1 day', ($3::date + interval '2 day')::timestamptz, '[)')`,
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
    // Get day of week/month in the reservation's timezone (not UTC)
    const tzParts = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz,
    }).formatToParts(currentDay);
    const tzYYYY = tzParts.find((p) => p.type === "year").value;
    const tzMM = tzParts.find((p) => p.type === "month").value;
    const tzDD = tzParts.find((p) => p.type === "day").value;
    const dayOfWeek = new Date(Date.UTC(
      Number(tzYYYY), Number(tzMM) - 1, Number(tzDD),
    )).getUTCDay(); // 0=Sun..6=Sat
    const dayOfMonth = Number(tzDD);

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

        // Convert local time to ISO UTC using the reservation timezone.
        // Node.js parses "2026-08-26T12:00:00" as UTC (not local), so we
        // construct UTC from local components and subtract the tz offset.
        const localDateTimeStr = `${dayStr}T${startTime}:00`;
        const tzOffsetMin = getUtcOffsetMinutes(localDateTimeStr, tz);
        const localAsUtcMs = Date.UTC(
          Number(dayStr.slice(0, 4)), Number(dayStr.slice(5, 7)) - 1, Number(dayStr.slice(8, 10)),
          slotStartH, slotStartM, 0,
        );
        const startsAt = new Date(localAsUtcMs + tzOffsetMin * 60000);
        const endsAt = new Date(startsAt.getTime() + durationMin * 60000);

        const startsAtIso = startsAt.toISOString();
        const endsAtIso = endsAt.toISOString();

        // Skip if in the past or within lead time — compare in the reservation timezone.
        // Convert both "now" and "slot start" to local milliseconds for a fair comparison.
        const tzOffsetMs = getTzOffsetMs(tz, startsAt);
        const nowLocalMs = Date.now() + getTzOffsetMs(tz, new Date());
        const slotLocalMs = startsAt.getTime() + tzOffsetMs;
        const leadTimeMs = (service.lead_time_minutes || 0) * 60000;
        if (slotLocalMs < nowLocalMs + leadTimeMs) {
          continue;
        }

        // Skip if max advance exceeded
        if (service.max_advance_days) {
          const maxAdvanceMs = service.max_advance_days * 24 * 60 * 60 * 1000;
          if (slotLocalMs > nowLocalMs + maxAdvanceMs) {
            continue;
          }
        }

        // Skip if overlaps a manual disabled range
        const overlapsDisabled = disabledRanges.some((dr) => {
          const drStart = new Date(dr.starts_at).getTime();
          const drEnd = new Date(dr.ends_at).getTime();
          return startsAt.getTime() < drEnd && drStart < endsAt.getTime();
        });
        if (overlapsDisabled) continue;

        // Skip if falls on a holiday with an enabled rule
        const [holidayYear, holidayMonth, holidayDay] = dayStr.split("-").map(Number);
        const slotHolidayKey = isHungarianHoliday(holidayYear, holidayMonth, holidayDay);
        if (slotHolidayKey && enabledHolidays.has(slotHolidayKey)) continue;

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
/**
 * Compute the UTC offset in minutes for a local datetime string.
 *
 * SIGN CONVENTION: Returns NEGATIVE for east-of-UTC zones (e.g. -120 for
 * Budapest in summer). To convert local → UTC: `localMs - (offset * 60000)`.
 * This is the OPPOSITE of getTzOffsetMs (which returns positive for
 * east-of-UTC). Prefer getTzOffsetMs for new code.
 */
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
