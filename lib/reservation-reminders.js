// lib/reservation-reminders.js
//
// Background scheduler that sends reminder emails X hours before each
// booking starts. Runs as an in-process setInterval tick wired from
// server.js. Uses atomic claim (UPDATE ... WHERE reminder_sent_at IS
// NULL) for idempotent, single-flight send.
//
// Follows the cron pattern from scripts/cron-projects-status.js:
// - export a startReminders() / runReminders() pair
// - env guard: DISABLE_REMINDERS=true skips startup

import { pool } from "../db/pool.js";
import { enqueueMail } from "./email-queue.js";
import {
  renderBookingReminder,
} from "./email-templates.js";

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// runReminders — query due bookings, claim, and enqueue emails.
// ---------------------------------------------------------------------------

export async function runReminders() {
  // Find bookings where:
  // - project has reminder_hours_before configured (> 0)
  // - booking is confirmed
  // - reminder not yet sent
  // - starts_at is within the reminder window but still in the future
  //   (we send the reminder before the booking starts, never after)
  const { rows: due } = await pool.query(
    `SELECT b.id AS booking_id,
            b.starts_at, b.ends_at,
            b.email, b.first_name, b.last_name,
            b.service_name_snapshot, b.timezone,
            b.locale, b.booking_token,
            r.id AS reservation_id,
            r.name AS reservation_name,
            r.secret_token,
            r.project_id,
            r.reminder_hours_before,
            p.name AS project_name,
            p.domain_address,
            p.customer_email
     FROM reservation_bookings b
     JOIN reservations r ON r.id = b.reservation_id
     JOIN projects p ON p.id = r.project_id
     WHERE b.reminder_sent_at IS NULL
       AND b.status = 'confirmed'
       AND r.reminder_hours_before IS NOT NULL
       AND r.reminder_hours_before > 0
       AND b.starts_at > now()
       AND b.starts_at <= now() + (r.reminder_hours_before || ' hours')::interval
     ORDER BY b.starts_at
     LIMIT $1`,
    [BATCH_SIZE],
  );

  if (due.length === 0) return 0;

  let sent = 0;
  for (const booking of due) {
    // Skip bookings without an email address
    if (!booking.email) {
      await pool.query(
        `UPDATE reservation_bookings SET reminder_sent_at = now() WHERE id = $1`,
        [booking.booking_id],
      );
      continue;
    }

    try {
      const { subject, html, text } = renderBookingReminder({
        projectName: booking.project_name,
        domainAddress: booking.domain_address,
        customerEmail: booking.customer_email,
        startsAt: booking.starts_at,
        endsAt: booking.ends_at,
        bookingId: booking.booking_id,
        serviceName: booking.service_name_snapshot,
        locale: booking.locale || "hu",
        timezone: booking.timezone || "UTC",
        bookingToken: booking.booking_token,
        embedBaseUrl: buildEmbedBaseUrl(booking.secret_token),
        hoursBefore: booking.reminder_hours_before,
      });

      enqueueMail({
        to: booking.email,
        subject,
        html,
        text,
        fromName: booking.project_name || undefined,
      });

      // Mark as sent — prevents duplicate sends on next tick.
      // If enqueueMail internally fails, the email-queue retries up
      // to MAX_ATTEMPTS; the reminder_sent_at is set eagerly because
      // the email is best-effort and a retry loop would be worse than
      // a single missed reminder.
      await pool.query(
        `UPDATE reservation_bookings SET reminder_sent_at = now() WHERE id = $1`,
        [booking.booking_id],
      );
      sent++;
    } catch (err) {
      console.error(
        `[reminder] failed booking=${booking.booking_id}:`,
        err.code || "",
        err.message,
      );
      // Leave reminder_sent_at NULL so next tick retries
    }
  }

  return sent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEmbedBaseUrl(secretToken) {
  const appUrl = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
  return (secretToken && appUrl)
    ? `${appUrl}/embed/reservations/${secretToken}`
    : null;
}

// ---------------------------------------------------------------------------
// Start / stop — wired from server.js
// ---------------------------------------------------------------------------

let interval = null;

export function startReminders() {
  if (process.env.DISABLE_REMINDERS === "true") {
    console.log("[reminders] disabled by DISABLE_REMINDERS=true");
    return;
  }

  const tick = () => {
    runReminders().catch((e) => {
      console.error("[reminders] tick rejected", e?.message);
    });
  };

  // Run immediately on startup, then every 60 seconds
  tick();
  interval = setInterval(tick, 60 * 1000);
  console.log("[reminders] started (every 60s)");

  const shutdown = () => {
    if (interval) clearInterval(interval);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
