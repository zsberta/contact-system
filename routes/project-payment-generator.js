// Single endpoint: POST /api/projects/:id/payments/generate
// Generates (or returns existing) the next payment for a project based on its billing schedule.
// This is the BE counterpart of the "Generate payment" button on the project view page.

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { computeNextDue, dateToYMD } from "../lib/billing-dates.js";

export const router = express.Router();
router.use(requireAuth);

// Reuse the same DTO shape as routes/payments.js
function rowToPaymentDTO(row) {
  if (!row) return null;
  let dueDate = row.due_date;
  if (dueDate instanceof Date) {
    dueDate = dueDate.toISOString().slice(0, 10);
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    amount: row.amount == null ? null : Number(row.amount),
    status: row.status,
    dueDate,
    period: row.period,
    createdBy: row.created_by,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

router.post("/:id/payments/generate", async (req, res) => {
  if (req.user && req.user.role === "enduser") {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, price, fordulonap, billing_period FROM projects WHERE id = $1`,
      [projectId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    const project = rows[0];

    if (!project.fordulonap || !project.billing_period) {
      return res.status(400).json({ errorMessage: "Project has no billing schedule" });
    }
    if (project.price == null || Number(project.price) <= 0) {
      return res.status(400).json({ errorMessage: "Project has no price set" });
    }

    const next = computeNextDue(project.billing_period, project.fordulonap);
    if (!next) {
      return res.status(400).json({ errorMessage: "Invalid billing schedule" });
    }
    const dueDateStr = dateToYMD(next);

    // Idempotent: check for existing active payment first
    const existing = await pool.query(
      `SELECT id, project_id, amount, status, due_date, period, created_by, paid_at, note,
              created_at, updated_at
       FROM payments
       WHERE project_id = $1 AND due_date = $2 AND status IN ('pending', 'paid', 'overdue')
       LIMIT 1`,
      [projectId, dueDateStr],
    );
    if (existing.rowCount > 0) {
      return res.status(200).json(rowToPaymentDTO(existing.rows[0]));
    }

    // Insert with ON CONFLICT DO NOTHING for race safety
    const inserted = await pool.query(
      `INSERT INTO payments (project_id, amount, status, due_date, period, created_by)
       VALUES ($1, $2, 'pending', $3, $4, 'auto')
       ON CONFLICT (project_id, due_date) WHERE status IN ('pending', 'paid', 'overdue')
       DO NOTHING
       RETURNING id, project_id, amount, status, due_date, period, created_by, paid_at, note,
                 created_at, updated_at`,
      [projectId, project.price, dueDateStr, project.billing_period],
    );

    if (inserted.rowCount === 0) {
      // Race lost — re-fetch
      const re = await pool.query(
        `SELECT id, project_id, amount, status, due_date, period, created_by, paid_at, note,
                created_at, updated_at
         FROM payments
         WHERE project_id = $1 AND due_date = $2 AND status IN ('pending', 'paid', 'overdue')
         LIMIT 1`,
        [projectId, dueDateStr],
      );
      return res.status(200).json(rowToPaymentDTO(re.rows[0]));
    }

    console.log(`[projects/payments/generate] project=${projectId} created payment id=${inserted.rows[0].id} due=${dueDateStr}`);
    return res.status(201).json(rowToPaymentDTO(inserted.rows[0]));
  } catch (err) {
    console.error("[projects/payments/generate]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
