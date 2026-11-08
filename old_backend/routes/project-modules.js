import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";

export const router = express.Router();
router.use(requireAuth);

// ---- GET /api/project-modules?projectId=<id> ----
// Returns authorized project modules as { id, projectId, kind, resourceId, label }[].
// resourceId is the source config ID for forms/reservations/analytics/ai, null for collections.
router.get("/", async (req, res) => {
  try {
    const projectId = parseInt(req.query.projectId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "projectId is required" });
    }

    const scopedProjectIds = await getScopedProjectIds(req);
    const isAdmin = scopedProjectIds === null || scopedProjectIds === undefined;

    // Verify project exists and is authorized.
    // For endusers, scope against projects.id (not pm.project_id).
    let projectCheck;
    if (isAdmin) {
      projectCheck = await pool.query(
        `SELECT id FROM projects WHERE id = $1`,
        [projectId],
      );
    } else {
      projectCheck = await pool.query(
        `SELECT id FROM projects WHERE id = $1 AND id = ANY($2::bigint[])`,
        [projectId, scopedProjectIds],
      );
    }
    if (projectCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }

    // Fetch modules with their resource IDs.
    // Reservations, forms, analytics, and AI assistant are one-per-project configs.
    // Blog/faq/service are collections (multiple content items per project).
    const { rows } = await pool.query(
      `SELECT
         pm.id,
         pm.project_id AS "projectId",
         pm.module_type AS "kind",
         CASE pm.module_type
           WHEN 'form' THEN (SELECT id FROM forms WHERE module_id = pm.id)
           WHEN 'reservation' THEN (SELECT id FROM reservations WHERE module_id = pm.id)
           WHEN 'analytics' THEN (SELECT id FROM analytics_configs WHERE module_id = pm.id)
           WHEN 'ai-assistant' THEN (SELECT id FROM ai_assistant_configs WHERE module_id = pm.id)
           ELSE NULL
         END AS "resourceId",
         CASE pm.module_type
           WHEN 'form' THEN (SELECT name FROM forms WHERE module_id = pm.id)
           WHEN 'reservation' THEN (SELECT name FROM reservations WHERE module_id = pm.id)
           WHEN 'analytics' THEN (SELECT name FROM analytics_configs WHERE module_id = pm.id)
           WHEN 'ai-assistant' THEN (SELECT name FROM ai_assistant_configs WHERE module_id = pm.id)
           WHEN 'blog' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Blog'
           WHEN 'faq' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' FAQ'
           WHEN 'service' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Services'
           ELSE pm.module_type
         END AS label
       FROM project_modules pm
       WHERE pm.project_id = $1
       ORDER BY pm.module_type`,
      [projectId],
    );

    return res.json(rows);
  } catch (err) {
    console.error("[project-modules/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/project-modules/:id ----
// Returns a single module DTO after checking project membership and caller scope.
router.get("/:id", async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    if (!Number.isFinite(moduleId) || moduleId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid module ID" });
    }

    const scopedProjectIds = await getScopedProjectIds(req);
    const isAdmin = scopedProjectIds === null || scopedProjectIds === undefined;

    // Scope: endusers can only see modules on their assigned projects.
    const { rows } = await pool.query(
      `SELECT
         pm.id,
         pm.project_id AS "projectId",
         pm.module_type AS "kind",
         CASE pm.module_type
           WHEN 'form' THEN (SELECT id FROM forms WHERE module_id = pm.id)
           WHEN 'reservation' THEN (SELECT id FROM reservations WHERE module_id = pm.id)
           WHEN 'analytics' THEN (SELECT id FROM analytics_configs WHERE module_id = pm.id)
           WHEN 'ai-assistant' THEN (SELECT id FROM ai_assistant_configs WHERE module_id = pm.id)
           ELSE NULL
         END AS "resourceId",
         CASE pm.module_type
           WHEN 'form' THEN (SELECT name FROM forms WHERE module_id = pm.id)
           WHEN 'reservation' THEN (SELECT name FROM reservations WHERE module_id = pm.id)
           WHEN 'analytics' THEN (SELECT name FROM analytics_configs WHERE module_id = pm.id)
           WHEN 'ai-assistant' THEN (SELECT name FROM ai_assistant_configs WHERE module_id = pm.id)
           WHEN 'blog' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Blog'
           WHEN 'faq' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' FAQ'
           WHEN 'service' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Services'
           ELSE pm.module_type
         END AS label
       FROM project_modules pm
       WHERE pm.id = $1${isAdmin ? "" : " AND pm.project_id = ANY($2::bigint[])"}`,
      isAdmin ? [moduleId] : [moduleId, scopedProjectIds],
    );

    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Module not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("[project-modules/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
