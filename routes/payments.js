import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();
router.use(requireAuth);

const STATUS_VALUES = new Set(["pending", "paid", "overdue", "cancelled"]);
const PERIOD_VALUES = new Set(["monthly", "yearly", "one_off"]);
const ORIGIN_VALUES = new Set(["auto", "manual"]);

// Snake_case DB column -> camelCase API field. We serialise due_date as a
// YYYY-MM-DD string (no time component) — pg returns it as a Date object.
function rowToPaymentDTO(row) {
  if (!row) return null;
  let dueDate = row.due_date;
  if (dueDate instanceof Date) {
    dueDate = dueDate.toISOString().slice(0, 10);
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    // pg returns NUMERIC as string to preserve precision — coerce for the API.
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

// Normalise empty/whitespace strings to null. Same convention as routes/projects.js.
function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

// YYYY-MM-DD validator with calendar round-trip. Rejects e.g. "2024-02-31".
function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

// Validate POST/PUT body. Returns { ok, value } on success, { ok: false, error }
// otherwise. Accepts partial payloads for PUT (only validate provided fields).
//
// Required on POST: projectId, amount, dueDate.
// projectId is fixed once created — PUT cannot change it.
function validatePaymentBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  // projectId — required on POST, forbidden on PUT (payments belong to one project forever).
  if (body.projectId !== undefined || body.project_id !== undefined) {
    if (partial) {
      errors.push("projectId cannot be changed");
    } else {
      const v = body.projectId ?? body.project_id;
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push("projectId must be a positive integer");
      } else {
        out.project_id = n;
      }
    }
  } else if (!partial) {
    errors.push("projectId is required");
  }

  // amount — non-negative number.
  if (body.amount !== undefined) {
    const v = body.amount;
    if (v === null || v === "") {
      out.amount = null;
    } else {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        errors.push("amount must be a non-negative number or null");
      } else {
        out.amount = n;
      }
    }
  } else if (!partial) {
    errors.push("amount is required");
  }

  // dueDate — YYYY-MM-DD.
  if (body.dueDate !== undefined || body.due_date !== undefined) {
    const v = body.dueDate ?? body.due_date;
    if (v === null || v === "") {
      out.due_date = null;
    } else if (!isValidDateString(v)) {
      errors.push("dueDate must be a valid YYYY-MM-DD date");
    } else {
      out.due_date = v;
    }
  } else if (!partial) {
    errors.push("dueDate is required");
  }

  // status — defaults to 'pending' on POST. PUT can change freely within the set.
  // The 'overdue' status is normally set by the cron, but we don't reject it here
  // — an admin might want to manually mark a payment overdue, or to revert one
  // back to pending.
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  } else if (!partial) {
    out.status = "pending";
  }

  // period — optional.
  if (body.period !== undefined) {
    const v = emptyToNull(body.period);
    if (v === null) {
      out.period = null;
    } else if (typeof v !== "string" || !PERIOD_VALUES.has(v)) {
      errors.push(`period must be one of ${[...PERIOD_VALUES].join(", ")} or null`);
    } else {
      out.period = v;
    }
  }

  // createdBy — defaults to 'manual' on POST.
  if (body.createdBy !== undefined || body.created_by !== undefined) {
    const v = body.createdBy ?? body.created_by;
    if (typeof v !== "string" || !ORIGIN_VALUES.has(v)) {
      errors.push(`createdBy must be one of ${[...ORIGIN_VALUES].join(", ")}`);
    } else {
      out.created_by = v;
    }
  } else if (!partial) {
    out.created_by = "manual";
  }

  // paidAt — optional ISO timestamp. Only meaningful when status='paid'.
  if (body.paidAt !== undefined || body.paid_at !== undefined) {
    const v = body.paidAt ?? body.paid_at;
    if (v === null || v === "") {
      out.paid_at = null;
    } else if (typeof v !== "string") {
      errors.push("paidAt must be an ISO timestamp string or null");
    } else {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        errors.push("paidAt must be a valid ISO timestamp");
      } else {
        out.paid_at = d.toISOString();
      }
    }
  }

  // note — optional string up to 5000 chars.
  if (body.note !== undefined) {
    const v = emptyToNull(body.note);
    if (v === null) {
      out.note = null;
    } else if (typeof v !== "string" || v.length > 5000) {
      errors.push("note must be a string up to 5000 chars or null");
    } else {
      out.note = v;
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// ---- GET /api/payments ----
// Paged list, optionally filtered by projectId.
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size ?? "10", 10) || 10));

  // projectId filter — must be a positive integer if present.
  let projectFilter = null;
  if (req.query.projectId !== undefined) {
    const pid = parseInt(req.query.projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    projectFilter = pid;
  }

  const whereParts = [];
  const params = [];
  if (projectFilter !== null) {
    params.push(projectFilter);
    whereParts.push(`project_id = $${params.length}`);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const offset = page * size;
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM payments ${whereSql}`;
    const countResult = await pool.query(countSql, params);
    const totalElements = countResult.rows[0].total;

    const dataSql = `SELECT id, project_id, amount, status, due_date, period,
                            created_by, paid_at, note, created_at, updated_at
                     FROM payments
                     ${whereSql}
                     ORDER BY due_date DESC, id DESC
                     LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const dataResult = await pool.query(dataSql, [...params, size, offset]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToPaymentDTO);

    return res.json({
      totalPages,
      totalElements,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset,
        sort: { sorted: false, unsorted: true, empty: false },
      },
      numberOfElements: rows.length,
      size,
      content: rows,
      number: page,
      sort: { sorted: false, unsorted: true, empty: false },
      first: page === 0,
      last: page === totalPages - 1,
      empty: rows.length === 0,
    });
  } catch (err) {
    console.error("[payments/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/payments/:id ----
router.get("/:id", requireAuth, async (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, project_id, amount, status, due_date, period,
              created_by, paid_at, note, created_at, updated_at
       FROM payments WHERE id = $1`,
      [paymentId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Payment not found" });
    }
    return res.json(rowToPaymentDTO(rows[0]));
  } catch (err) {
    console.error("[payments/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/payments ----
router.post("/", requireAuth, async (req, res) => {
  const validation = validatePaymentBody(req.body, { partial: false });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;

  // Confirm the project exists — FK would catch it too, but a 404 with a
  // friendlier message is much nicer than a raw constraint violation.
  try {
    const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [v.project_id]);
    if (proj.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
  } catch (err) {
    console.error("[payments/create] project lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Auto-set paid_at when status='paid' and caller didn't supply one.
  if (v.status === "paid" && !v.paid_at) {
    v.paid_at = new Date().toISOString();
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO payments
        (project_id, amount, status, due_date, period, created_by, paid_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, project_id, amount, status, due_date, period,
                 created_by, paid_at, note, created_at, updated_at`,
      [
        v.project_id,
        v.amount,
        v.status,
        v.due_date,
        v.period ?? null,
        v.created_by,
        v.paid_at ?? null,
        v.note ?? null,
      ],
    );
    return res.status(201).json(rowToPaymentDTO(rows[0]));
  } catch (err) {
    // 23505 = unique_violation on uq_payments_project_due_active.
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ errorMessage: "A payment for this project and due date already exists" });
    }
    if (err.code === "22P02") {
      return res.status(400).json({ errorMessage: "Invalid enum value" });
    }
    console.error("[payments/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/payments/:id ----
router.put("/:id", requireAuth, async (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const validation = validatePaymentBody(req.body, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  if (Object.keys(v).length === 0) {
    return res.status(400).json({ errorMessage: "No updatable fields provided" });
  }

  // paid_at bookkeeping: when the caller moves status into/out of 'paid',
  // we manage paid_at for them unless they passed an explicit value.
  //   - status='paid' AND no paid_at supplied  -> paid_at = now()
  //   - status != 'paid' AND no paid_at supplied -> paid_at = null
  // The validator's `paid_at` field is set only when the caller sent it, so
  // absence here means "you decide for me".
  if (v.status !== undefined && v.paid_at === undefined) {
    if (v.status === "paid") {
      v.paid_at = new Date().toISOString();
    } else {
      v.paid_at = null;
    }
  }

  try {
    const setClauses = [];
    const params = [paymentId];
    let p = 2;
    for (const [col, val] of Object.entries(v)) {
      setClauses.push(`${col} = $${p}`);
      params.push(val);
      p++;
    }
    // updated_at is also bumped by the trg_payments_touch_updated_at trigger,
    // but we set it explicitly so callers don't need to know about triggers.
    setClauses.push("updated_at = now()");

    const sql = `UPDATE payments
                 SET ${setClauses.join(", ")}
                 WHERE id = $1
                 RETURNING id, project_id, amount, status, due_date, period,
                           created_by, paid_at, note, created_at, updated_at`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Payment not found" });
    }
    return res.json(rowToPaymentDTO(rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ errorMessage: "A payment for this project and due date already exists" });
    }
    if (err.code === "22P02") {
      return res.status(400).json({ errorMessage: "Invalid enum value" });
    }
    console.error("[payments/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/payments/:id ----
// Refuses to delete paid payments — they're an audit trail.
router.delete("/:id", requireAuth, async (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    // Look up the current status so we can refuse with a 409 before issuing
    // a doomed DELETE. Using RETURNING + checking rowCount would still work,
    // but it leaves the caller wondering why the row vanished.
    const { rows } = await pool.query(
      `SELECT status FROM payments WHERE id = $1`,
      [paymentId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Payment not found" });
    }
    if (rows[0].status === "paid") {
      return res
        .status(409)
        .json({ errorMessage: "Cannot delete a paid payment" });
    }

    await pool.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    return res.status(204).send();
  } catch (err) {
    console.error("[payments/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});