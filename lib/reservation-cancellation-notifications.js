import { notifySubmitter } from "./email.js";
import { createNotification, sendPushToUser } from "./push.js";
import { t, formatDate } from "./notifications-i18n.js";
import { pool } from "../db/pool.js";

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Deliver the complete cancellation notification set exactly once per
 * recipient. Routes own the booking state change; this module owns delivery.
 */
export async function notifyBookingCancelled({ reservation, booking, db = pool }) {
  const projectId = reservation.project_id ?? reservation.projectId;
  const timezone = reservation.timezone || booking.timezone || "UTC";
  const locale = booking.locale || reservation.default_locale || "hu";
  const serviceName = booking.service_name || booking.service_name_snapshot || "Reservation";
  const customerEmail = booking.customer_email || booking.email || "";
  const customerName = [
    booking.customer_first_name ?? booking.first_name,
    booking.customer_last_name ?? booking.last_name,
  ].filter(Boolean).join(" ") || customerEmail;
  const workerId = booking.svc_worker_user_id ?? booking.worker_user_id;

  let workerEmail = "";
  let workerName = "";
  if (workerId) {
    try {
      const result = await db.query(
        `SELECT first_name, last_name, email FROM users
         WHERE id = $1 AND role = 'enduser' AND enabled = true`,
        [workerId],
      );
      const worker = result.rows[0];
      workerEmail = worker?.email?.trim() || "";
      if (worker) {
        workerName = locale === "hu"
          ? [worker.last_name, worker.first_name].filter(Boolean).join(" ")
          : [worker.first_name, worker.last_name].filter(Boolean).join(" ");
      }
    } catch (err) {
      console.error("[notifications/cancel] worker lookup failed:", err.message);
    }
  }

  let workerEmailEnabled = true;
  let workerPushEnabled = true;
  try {
    const settings = await db.query(
      "SELECT key, value FROM system_settings WHERE key IN ('worker_email_notifications', 'worker_push_notifications')",
    );
    for (const row of settings.rows) {
      if (row.key === "worker_email_notifications") workerEmailEnabled = row.value !== false;
      if (row.key === "worker_push_notifications") workerPushEnabled = row.value !== false;
    }
  } catch (err) {
    console.error("[notifications/cancel] settings lookup failed:", err.message);
  }

  const startsAt = booking.starts_at;
  const endsAt = booking.ends_at;
  const bookingId = booking.id;
  const sameRecipient = normalizedEmail(customerEmail) !== ""
    && normalizedEmail(customerEmail) === normalizedEmail(workerEmail);

  // Customer receives one project-branded cancellation email. If the worker
  // address is identical, the worker email below is the one copy sent.
  if (customerEmail && !sameRecipient) {
    notifySubmitter({
      kind: "reservation",
      projectId,
      formName: serviceName,
      data: null,
      locale,
      startsAt,
      endsAt,
      bookingId,
      serviceName,
      email: customerEmail,
      signerName: workerName || undefined,
      cancelled: true,
      timezone,
    }).catch((err) => console.error("[notifications/cancel] customer email failed:", err.message));
  }

  if (workerId && workerEmail && workerEmailEnabled) {
    notifySubmitter({
      kind: "reservation",
      projectId,
      formName: serviceName,
      data: null,
      locale,
      startsAt,
      endsAt,
      bookingId,
      serviceName,
      to: workerEmail,
      useBrandDefaults: true,
      cancelled: true,
      customerName,
      customerEmail,
      timezone,
    }).catch((err) => console.error("[notifications/cancel] worker email failed:", err.message));
  }

  if (!workerId) return;

  const date = formatDate(startsAt, locale, timezone);
  try {
    await createNotification({
      userId: workerId,
      type: "BOOKING_CANCELLED",
      title: t(locale, "booking_cancelled"),
      message: t(locale, "booking_cancelled_message", { customerName, serviceName, date }),
      entityType: "booking",
      entityId: bookingId,
      metadata: { serviceName, customerName, startsAt, endsAt, locale, timezone },
    });
  } catch (err) {
    console.error("[notifications/cancel] in-app notification failed:", err.message);
  }

  if (workerPushEnabled) {
    try {
      await sendPushToUser(workerId, {
        title: t(locale, "push_cancelled_title", { customerName }),
        body: t(locale, "push_cancelled_body", { serviceName, date }),
        url: "/",
      });
    } catch (err) {
      console.error("[notifications/cancel] push notification failed:", err.message);
    }
  }
}
