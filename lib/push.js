import webpush from "web-push";
import { pool } from "../db/pool.js";
import { logActivity } from "./activity-log.js";

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
export async function sendPushToUser(userId, payload, audit = {}) {
  if (!vapidPublicKey || !vapidPrivateKey) return;

  const { rows: subscriptions } = await pool.query(
    "SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = $1",
    [userId],
  );

  if (subscriptions.length === 0) return;

  // ok=false only when NO device received the push. 410/404 purges are
  // housekeeping on a dead endpoint, counted as delivered, not failed.
  let delivered = 0;
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
        .then(() => {
          delivered += 1;
        })
        .catch(async (err) => {
          // Expired or revoked subscription — purge from DB
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query(
              "DELETE FROM push_subscriptions WHERE endpoint = $1",
              [sub.endpoint],
            );
            delivered += 1;
          } else {
            console.error("[push] send error:", err.statusCode, err.message);
          }
        }),
    ),
  );
  // One SEND row per delivery fan-out.
  logActivity({
    req: null,
    action: audit.action || "push.send",
    actionType: "SEND",
    entityType: audit.entityType || null,
    entityId: audit.entityId ?? null,
    entityLabel: audit.entityLabel || null,
    projectId: audit.projectId ?? null,
    statusCode: delivered > 0 ? 201 : 500,
    ok: delivered > 0,
    metadata: {
      userId: Number(userId) || null,
      title: payload?.title || null,
      devices: subscriptions.length,
      delivered,
    },
    actorOverride: audit.actor || { actor_type: "system" },
  });
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
  audit = {},
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
  logActivity({
    req: null,
    action: audit.action || "notification.create",
    actionType: "SEND",
    entityType: entityType || audit.entityType || null,
    entityId: entityId ?? audit.entityId ?? null,
    entityLabel: audit.entityLabel || null,
    projectId: audit.projectId ?? null,
    statusCode: 201,
    ok: true,
    metadata: { type: type || "SYSTEM", title, userId: Number(userId) || null },
    actorOverride: audit.actor || { actor_type: "system" },
  });
}
