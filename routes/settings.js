import express from "express";
import { pool } from "../db/pool.js";

export const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/settings — return all system settings (admin only)
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ errorMessage: "Admin access required" });
    }

    const { rows } = await pool.query("SELECT key, value FROM system_settings");
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    res.json({ settings });
  } catch (err) {
    console.error("[settings/get]", err.message);
    res.status(500).json({ errorMessage: "Failed to fetch settings" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/settings — update system settings (admin only)
// Body: { settings: { key: value, ... } }
// ---------------------------------------------------------------------------
router.put("/", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ errorMessage: "Admin access required" });
    }

    const { settings } = req.body;
    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ errorMessage: "Missing settings object" });
    }

    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[settings/update]", err.message);
    res.status(500).json({ errorMessage: "Failed to update settings" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/settings/vapid-public-key — return VAPID public key (any auth user)
// ---------------------------------------------------------------------------
router.get("/vapid-public-key", async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ errorMessage: "Unauthorized" });

    const publicKey = process.env.VAPID_PUBLIC_KEY || "";
    res.json({ publicKey });
  } catch (err) {
    console.error("[settings/vapid-key]", err.message);
    res.status(500).json({ errorMessage: "Failed to fetch VAPID key" });
  }
});
