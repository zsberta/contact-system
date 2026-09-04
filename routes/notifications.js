import express from "express";
import { pool } from "../db/pool.js";

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
// POST /api/notifications/subscribe — save a push subscription
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
       ON CONFLICT (endpoint) DO UPDATE
         SET keys_p256dh = EXCLUDED.keys_p256dh,
             keys_auth = EXCLUDED.keys_auth,
             device_name = EXCLUDED.device_name,
             user_id = EXCLUDED.user_id,
             updated_at = NOW()`,
      [userId, endpoint, keys.p256dh, keys.auth, deviceName || "Unknown Device"],
    );

    res.status(201).json({ status: "subscribed" });
  } catch (err) {
    console.error("[notifications/subscribe]", err.message);
    res.status(500).json({ errorMessage: "Failed to save subscription" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications/unsubscribe — remove a push subscription
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

    res.json({ status: "unsubscribed" });
  } catch (err) {
    console.error("[notifications/unsubscribe]", err.message);
    res.status(500).json({ errorMessage: "Failed to remove subscription" });
  }
});
