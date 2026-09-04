import webpush from "web-push";
import { pool } from "../db/pool.js";

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    "mailto:info@zsoltberta.hu",
    vapidPublicKey,
    vapidPrivateKey,
  );
}

/**
 * Send a push notification to all devices registered to a user.
 * Silently no-ops if VAPID keys are not configured.
 * Purges expired subscriptions (410/404) automatically.
 */
export async function sendPushToUser(userId, payload) {
  if (!vapidPublicKey || !vapidPrivateKey) return;

  const { rows: subscriptions } = await pool.query(
    "SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = $1",
    [userId],
  );

  if (subscriptions.length === 0) return;

  await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush
        .sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
          },
          JSON.stringify(payload),
        )
        .catch(async (err) => {
          // Expired or revoked subscription — purge from DB
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query(
              "DELETE FROM push_subscriptions WHERE endpoint = $1",
              [sub.endpoint],
            );
          } else {
            console.error("[push] send error:", err.statusCode, err.message);
          }
        }),
    ),
  );
}

/**
 * Create an in-app notification row for a user.
 */
export async function createNotification({
  userId,
  type,
  title,
  message,
  entityType,
  entityId,
  metadata,
}) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      type || "SYSTEM",
      title,
      message,
      entityType || null,
      entityId || null,
      metadata ? JSON.stringify(metadata) : "{}",
    ],
  );
}
