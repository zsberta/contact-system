// ---------------------------------------------------------------------------
// Hungarian public holidays — hardcoded list for 2025–2027.
//
// Each entry: { key, month, day, nameHU, nameEN }
//   - key:     stable slug for dedup / toggle (e.g. "new_year")
//   - month:   1-based month
//   - day:     1-based day (for moveable holidays this is the ACTUAL date,
//              not an approximation — update yearly if needed)
//   - nameHU:  Hungarian display name
//   - nameEN:  English display name
//
// Easter-based holidays (Good Friday, Easter Monday) are computed dynamically
// via the anonymous Gregorian algorithm, so they stay correct without manual
// updates.
// ---------------------------------------------------------------------------

const FIXED_HOLIDAYS = [
  { key: "new_year",             month: 1,  day: 1,  nameHU: "Újév",                                  nameEN: "New Year's Day" },
  { key: "revolution_day",       month: 3,  day: 15, nameHU: "1848-as forradalom és szabadságharc napja", nameEN: "1848 Revolution Day" },
  { key: "labour_day",           month: 5,  day: 1,  nameHU: "A nap munkája, a nap kenyerée",          nameEN: "Labour Day" },
  { key: "state_foundation_day", month: 8,  day: 20, nameHU: "Szent István napja, az államalapítás ünnepe", nameEN: "State Foundation Day" },
  { key: "october_23",           month: 10, day: 23, nameHU: "1956-os forradalom és szabadságharc napja", nameEN: "1956 Revolution Day" },
  { key: "all_saints",           month: 11, day: 1,  nameHU: "Mindenszentek",                          nameEN: "All Saints' Day" },
  { key: "christmas_1",          month: 12, day: 25, nameHU: "Karácsony",                              nameEN: "Christmas Day" },
  { key: "christmas_2",          month: 12, day: 26, nameHU: "Karácsony másodnapja",                   nameEN: "Christmas Day (2nd)" },
];

// ---------------------------------------------------------------------------
// Easter computation (Gregorian, valid 1583–2299).
// Returns { month, day } for Easter Sunday in the given year.
// ---------------------------------------------------------------------------
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function addDays(month, day, n) {
  const d = new Date(2000, month - 1, day);
  d.setDate(d.getDate() + n);
  return { month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * Return all Hungarian public holidays for a given year.
 * @param {number} year
 * @returns {Array<{ key: string, startsAt: string, endsAt: string, nameHU: string, nameEN: string }>}
 *   startsAt/endsAt are ISO 8601 date strings (midnight UTC day spans).
 */
function getHolidaysForYear(year) {
  const holidays = [];

  // Fixed holidays
  for (const h of FIXED_HOLIDAYS) {
    const dateStr = `${year}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`;
    holidays.push({
      key: `${h.key}_${year}`,
      startsAt: `${dateStr}T00:00:00Z`,
      endsAt:   `${dateStr}T23:59:00Z`,
      nameHU: h.nameHU,
      nameEN: h.nameEN,
    });
  }

  // Easter-based holidays
  const easter = easterSunday(year);
  const goodFriday    = addDays(easter.month, easter.day, -2);
  const easterMonday  = addDays(easter.month, easter.day, +1);
  const whitMonday    = addDays(easter.month, easter.day, +50);

  const easterHolidays = [
    { key: "good_friday",   ...goodFriday,   nameHU: "Nagypéntek",   nameEN: "Good Friday" },
    { key: "easter_monday", ...easterMonday, nameHU: "Húsvét hétfő", nameEN: "Easter Monday" },
    { key: "whit_monday",   ...whitMonday,   nameHU: "Pünkösd hétfő", nameEN: "Whit Monday" },
  ];

  for (const h of easterHolidays) {
    const dateStr = `${year}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`;
    holidays.push({
      key: `${h.key}_${year}`,
      startsAt: `${dateStr}T00:00:00Z`,
      endsAt:   `${dateStr}T23:59:00Z`,
      nameHU: h.nameHU,
      nameEN: h.nameEN,
    });
  }

  return holidays;
}

/**
 * Generate holiday disabled-range rows for a reservation.
 * Returns an array of { starts_at, ends_at, reason, source, enabled } objects
 * ready for bulk INSERT.
 *
 * @param {number} year — the year to generate for
 * @returns {Array<{ starts_at: string, ends_at: string, reason: string, source: string, enabled: boolean }>}
 */
function generateHolidayRows(year) {
  return getHolidaysForYear(year).map((h) => ({
    starts_at: h.startsAt,
    ends_at:   h.endsAt,
    reason:    h.key,
    source:    "auto_holiday",
    enabled:   true,
  }));
}

export { getHolidaysForYear, generateHolidayRows };
