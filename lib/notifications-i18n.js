// Lightweight translation helper for backend notification text.
// Only covers notification-specific strings — not a full i18n system.

const translations = {
  hu: {
    new_booking: "Új foglalás",
    booking_message: "{customerName} foglalt: {serviceName} — {date}",
    push_title: "Új foglalás — {customerName}",
    push_body: "{serviceName} — {date}",
  },
  en: {
    new_booking: "New Booking",
    booking_message: "{customerName} booked {serviceName} — {date}",
    push_title: "New Booking — {customerName}",
    push_body: "{serviceName} — {date}",
  },
};

function resolveLocale(locale) {
  return locale === "en" ? "en" : "hu";
}

export function t(locale, key, vars = {}) {
  const lang = resolveLocale(locale);
  let text = translations[lang]?.[key] || translations.hu[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, v ?? "");
  }
  return text;
}

/**
 * Format a date string in the given locale and timezone.
 * @param {string} isoDate - ISO date string
 * @param {string} locale - "hu" or "en"
 * @param {string} timezone - IANA timezone (e.g. "Europe/Budapest")
 * @returns {string} formatted date
 */
export function formatDate(isoDate, locale, timezone) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  const loc = resolveLocale(locale);
  return d.toLocaleString(loc === "en" ? "en-GB" : "hu-HU", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
