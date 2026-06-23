// Pure helpers for computing the next billing date for a project.
// Used by the cron (scripts/cron-projects-status.js) and by the manual
// "generate payment" route (POST /api/projects/:id/payments/generate).
// Keeping this logic in ONE place avoids drift between the two callers.

/**
 * Compute the next due date (UTC Date) for a project given its billing_period + fordulonap.
 * @param {string|null|undefined} billingPeriod - "monthly" | "yearly" | "one_off" | null
 * @param {string|null|undefined} fordulonap - period-dependent encoding (see below)
 * @param {Date} [today] - injectable for testing
 * @returns {Date|null}
 *
 * Encodings:
 *   monthly: "DD" (1-28) — day of month
 *   yearly:  "MM-DD"     — month + day, no year
 *   one_off: "YYYY-MM-DD"
 */
export function computeNextDue(billingPeriod, fordulonap, today = new Date()) {
  if (!billingPeriod || !fordulonap) return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();

  if (billingPeriod === "one_off") {
    const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fordulonap);
    if (!m1) return null;
    return new Date(Date.UTC(+m1[1], +m1[2] - 1, +m1[3]));
  }
  if (billingPeriod === "monthly") {
    const day = parseInt(fordulonap, 10);
    if (!Number.isFinite(day) || day < 1 || day > 28) return null;
    let next = new Date(Date.UTC(y, m, day));
    if (next <= today) next = new Date(Date.UTC(y, m + 1, day));
    return next;
  }
  if (billingPeriod === "yearly") {
    const m2 = /^(\d{2})-(\d{2})$/.exec(fordulonap);
    if (!m2) return null;
    const mm = +m2[1] - 1;
    const dd = +m2[2];
    let next = new Date(Date.UTC(y, mm, dd));
    if (next <= today) next = new Date(Date.UTC(y + 1, mm, dd));
    return next;
  }
  return null;
}

/**
 * Format a Date as YYYY-MM-DD (UTC).
 */
export function dateToYMD(date) {
  return date.toISOString().slice(0, 10);
}
