// routes/ai-config-presets.js
// Admin CRUD for reusable AI config presets. Mount at /api/ai-config-presets.

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();
router.use(requireAuth);

const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduser = (req, res) => {
  if (isEnduser(req)) return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  return null;
};

function rowToPresetDTO(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    model: row.model,
    baseUrl: row.base_url,
    basePrompt: row.base_prompt,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// GET / — list presets for current user
router.get("/", async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const userId = req.user.id;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ai_config_presets WHERE user_id = $1`, [userId],
    );
    const totalElements = countResult.rows[0]?.total ?? 0;

    const result = await pool.query(
      `SELECT * FROM ai_config_presets WHERE user_id = $1 ORDER BY name ASC LIMIT $2 OFFSET $3`,
      [userId, size, page * size],
    );

    res.json({
      content: result.rows.map(rowToPresetDTO),
      totalElements, totalPages: Math.ceil(totalElements / size), page, size,
    });
  } catch (err) {
    console.error("[ai-config-presets] list error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// GET /:id
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(
      `SELECT * FROM ai_config_presets WHERE id = $1 AND user_id = $2`,
      [id, req.user.id],
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    res.json(rowToPresetDTO(result.rows[0]));
  } catch (err) {
    console.error("[ai-config-presets] get error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// POST / — create preset
router.post("/", async (req, res) => {
  if (forbidEnduser(req, res)) return;
  try {
    const { name, model, baseUrl, apiKey, basePrompt } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 1) {
      return res.status(400).json({ errorMessage: "Name is required" });
    }
    const result = await pool.query(
      `INSERT INTO ai_config_presets (user_id, name, model, base_url, api_key_enc, base_prompt)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.user.id,
        name.trim(),
        model || "gpt-4o",
        baseUrl || "https://api.openai.com/v1",
        apiKey || null,
        basePrompt || "You are a helpful assistant.",
      ],
    );
    res.status(201).json(rowToPresetDTO(result.rows[0]));
  } catch (err) {
    console.error("[ai-config-presets] create error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// PUT /:id
router.put("/:id", async (req, res) => {
  if (forbidEnduser(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });

    const { name, model, baseUrl, apiKey, basePrompt } = req.body;
    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(String(name).trim()); }
    if (model !== undefined) { sets.push(`model = $${idx++}`); params.push(String(model).trim()); }
    if (baseUrl !== undefined) { sets.push(`base_url = $${idx++}`); params.push(String(baseUrl).trim()); }
    if (apiKey !== undefined && apiKey !== "") { sets.push(`api_key_enc = $${idx++}`); params.push(String(apiKey)); }
    if (basePrompt !== undefined) { sets.push(`base_prompt = $${idx++}`); params.push(String(basePrompt)); }

    if (sets.length === 0) return res.status(400).json({ errorMessage: "No fields to update" });

    params.push(id, req.user.id);
    const result = await pool.query(
      `UPDATE ai_config_presets SET ${sets.join(", ")} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
      params,
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    res.json(rowToPresetDTO(result.rows[0]));
  } catch (err) {
    console.error("[ai-config-presets] update error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  if (forbidEnduser(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(
      `DELETE FROM ai_config_presets WHERE id = $1 AND user_id = $2`,
      [id, req.user.id],
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    res.status(204).end();
  } catch (err) {
    console.error("[ai-config-presets] delete error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});
