import express from "express";
import { pool } from "../db/pool.js";
import { logActivity } from "../lib/activity-log.js";

export const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/notifications — list notifications for the authenticated user
// Cursor-based pagination. ?cursor=<timestamp:id>&limit=<n> (default 20, max 50).
// Cursor is composite: ISO timestamp + ":" + numeric id, URL-encoded.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

    // Parse composite cursor: "2026-09-04T07:00:00.000Z:619"
    let cursorCreatedAt = null;
    let cursorId = null;
    if (req.query.cursor) {
      const decoded = decodeURIComponent(req.query.cursor);
      const lastColon = decoded.lastIndexOf(":");
      if (lastColon > 0) {
        cursorCreatedAt = decoded.substring(0, lastColon);
        cursorId = parseInt(decoded.substring(lastColon + 1));
      }
    }

    let query, params;
    if (cursorCreatedAt && cursorId) {
      // Keyset pagination: (created_at, id) < (cursorCreatedAt, cursorId)
      query = `
        SELECT id, user_id, type, title, message, entity_type, entity_id, metadata, created_at
        FROM notifications
        WHERE user_id = $1
          AND (created_at, id) < ($2::timestamptz, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`;
      params = [userId, cursorCreatedAt, cursorId, limit + 1];
    } else {
      query = `
        SELECT id, user_id, type, title, message, entity_type, entity_id, metadata, created_at
        FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`;
      params = [userId, limit + 1];
    }

    const { rows } = await pool.query(query, params);
    const hasMore = rows.length > limit;
    const notifications = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = notifications[notifications.length - 1];
    const nextCursor = hasMore && lastRow
      ? `${lastRow.created_at instanceof Date ? lastRow.created_at.toISOString() : lastRow.created_at}:${lastRow.id}`
      : null;

    // Map snake_case DB columns to camelCase DTO
    const dto = notifications.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      type: r.type,
      title: r.title,
      message: r.message,
      entityType: r.entity_type || null,
      entityId: r.entity_id != null ? Number(r.entity_id) : null,
      metadata: r.metadata || {},
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));

    res.json({ notifications: dto, nextCursor });
  } catch (err) {
    console.error("[notifications/list]", err.message);
    res.status(500).json({ errorMessage: "Failed to fetch notifications" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/notifications/unread-count — count notifications newer than ?since
// ---------------------------------------------------------------------------
router.get("/unread-count", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    const since = req.query.since;
    if (!since) {
      // No timestamp stored yet — count all notifications
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1",
        [userId],
      );
      return res.json({ count: rows[0].count });
    }

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND created_at > $2",
      [userId, since],
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error("[notifications/unread-count]", err.message);
    res.status(500).json({ errorMessage: "Failed to fetch unread count" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications/opened — record that the user opened the window
// Returns the server timestamp so the client can store it locally.
// ---------------------------------------------------------------------------
router.post("/opened", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    res.json({ openedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[notifications/opened]", err.message);
    res.status(500).json({ errorMessage: "Failed to record open" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/notifications/push-status?endpoint=<url-encoded endpoint>
// Reports whether THIS user has push enabled for the given browser endpoint.
// The browser PushSubscription is per browser profile, but the server mapping
// is per (user, endpoint) — so after switching accounts the same browser can
// be subscribed for one account and not the other. The bell uses this to
// show per-account state instead of the browser-wide subscription.
// ---------------------------------------------------------------------------
router.get("/push-status", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    const { endpoint } = req.query;
    if (!endpoint) {
      return res.status(400).json({ errorMessage: "Missing endpoint" });
    }

    const { rows } = await pool.query(
      "SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
      [userId, endpoint],
    );
    res.json({ subscribed: rows.length > 0 });
  } catch (err) {
    console.error("[notifications/push-status]", err.message);
    res.status(500).json({ errorMessage: "Failed to check subscription" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications/subscribe — save a push subscription
// One browser endpoint may serve several accounts on the same browser
// profile: uniqueness is (user_id, endpoint), so subscribing as account B
// ADDS a mapping instead of stealing the endpoint from account A.
// Keys belong to the endpoint (not the user), so they are refreshed on all
// sibling rows sharing the endpoint (e.g. after a VAPID rotation).
// Idempotent — safe to call on every login to heal account switches.
// ---------------------------------------------------------------------------
router.post("/subscribe", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    const { endpoint, keys, deviceName } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ errorMessage: "Missing endpoint or keys" });
    }

    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, device_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint) DO UPDATE
         SET keys_p256dh = EXCLUDED.keys_p256dh,
             keys_auth = EXCLUDED.keys_auth,
             device_name = EXCLUDED.device_name,
             updated_at = NOW()`,
      [userId, endpoint, keys.p256dh, keys.auth, deviceName || "Unknown Device"],
    );

    // Same browser subscription, other accounts: keep their keys in sync.
    await pool.query(
      `UPDATE push_subscriptions
          SET keys_p256dh = $2, keys_auth = $3, updated_at = NOW()
        WHERE endpoint = $1 AND user_id <> $4`,
      [endpoint, keys.p256dh, keys.auth, userId],
    );

    logActivity({
      req,
      action: "push.subscribe",
      actionType: "CREATE",
      entityType: "push_subscription",
      entityId: null,
      entityLabel: deviceName || "Unknown Device",
      projectId: null,
      statusCode: 201,
      ok: true,
      metadata: { created: { deviceName: deviceName || "Unknown Device" } },
    });
    res.status(201).json({ status: "subscribed" });
  } catch (err) {
    console.error("[notifications/subscribe]", err.message);
    res.status(500).json({ errorMessage: "Failed to save subscription" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications/unsubscribe — remove a push subscription
// Removes only THIS user's mapping for the endpoint. The browser
// subscription itself is torn down by the client, and only when no other
// account still uses the endpoint (see `remaining` below) — otherwise
// disabling push for one account would silently kill it for the others.
// ---------------------------------------------------------------------------
router.post("/unsubscribe", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ errorMessage: "Unauthorized" });

    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ errorMessage: "Missing endpoint" });
    }

    await pool.query(
      "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
      [endpoint, userId],
    );

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS remaining FROM push_subscriptions WHERE endpoint = $1",
      [endpoint],
    );

    logActivity({
      req,
      action: "push.unsubscribe",
      actionType: "DELETE",
      entityType: "push_subscription",
      entityId: null,
      entityLabel: "push subscription",
      projectId: null,
      statusCode: 200,
      ok: true,
      metadata: { deleted: { id: null, label: "push subscription" } },
    });
    res.json({ status: "unsubscribed", remaining: rows[0]?.remaining ?? 0 });
  } catch (err) {
    console.error("[notifications/unsubscribe]", err.message);
    res.status(500).json({ errorMessage: "Failed to remove subscription" });
  }
});
