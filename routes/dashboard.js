import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();

// Legacy stub kept for backwards compat with /api/dashboard/summary.
router.get("/summary", requireAuth, async (_req, res) => {
  res.json({ totalContacts: 0, lastUpdated: null });
});

/**
 * GET /api/dashboard/stats
 *
 * Returns the KPIs, monthly revenue series, status counts and upcoming payments
 * consumed by the React dashboard page (KpiCards / RevenueChart /
 * StatusBreakdown / UpcomingPayments). Shape matches DashboardStatsDTO on the
 * client. Best-effort: on any DB error we still return a well-formed zeroed
 * payload so the frontend can render an empty state instead of crashing.
 */
router.get("/stats", requireAuth, async (_req, res) => {
  const empty = {
    revenue30d: 0,
    revenue90d: 0,
    revenue365d: 0,
    outstanding: 0,
    counts: { pending: 0, overdue: 0, paid: 0, cancelled: 0 },
    monthlyRevenue: [],
    upcomingPayments: [],
  };

  try {
    const [totals, counts, monthly, upcoming] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '30 days'), 0)::float   AS revenue30d,
           COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '90 days'), 0)::float   AS revenue90d,
           COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '365 days'), 0)::float  AS revenue365d,
           COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','overdue')), 0)::float                              AS outstanding
         FROM payments`,
      ).catch(() => ({ rows: [{}] })),
      pool.query(
        `SELECT status, COUNT(*)::int AS n FROM payments GROUP BY status`,
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT TO_CHAR(date_trunc('month', paid_at), 'YYYY-MM') AS month,
                COALESCE(SUM(amount), 0)::float                  AS amount
         FROM payments
         WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '12 months'
         GROUP BY 1
         ORDER BY 1 ASC`,
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT p.id              AS "paymentId",
                p.project_id      AS "projectId",
                pr.name           AS "projectName",
                p.amount::float   AS amount,
                p.due_date::text  AS "dueDate",
                p.status          AS status,
                pr.customer_name  AS "customerName"
         FROM payments p
         JOIN projects pr ON pr.id = p.project_id
         WHERE p.status IN ('pending','overdue')
         ORDER BY p.due_date ASC
         LIMIT 5`,
      ).catch(() => ({ rows: [] })),
    ]);

    const t = totals.rows[0] || {};
    const countMap = { pending: 0, overdue: 0, paid: 0, cancelled: 0 };
    for (const row of counts.rows) {
      if (row.status in countMap) countMap[row.status] = row.n;
    }

    return res.json({
      revenue30d: Number(t.revenue30d ?? 0),
      revenue90d: Number(t.revenue90d ?? 0),
      revenue365d: Number(t.revenue365d ?? 0),
      outstanding: Number(t.outstanding ?? 0),
      counts: countMap,
      monthlyRevenue: monthly.rows.map((r) => ({
        month: r.month,
        amount: Number(r.amount ?? 0),
      })),
      upcomingPayments: upcoming.rows.map((r) => ({
        paymentId: Number(r.paymentId),
        projectId: Number(r.projectId),
        projectName: r.projectName,
        amount: Number(r.amount),
        dueDate: r.dueDate,
        status: r.status,
        customerName: r.customerName ?? null,
      })),
    });
  } catch (err) {
    // Never 500 the dashboard — the FE renders empty-state on the empty payload.
    console.error("[dashboard/stats]", err.code, err.message);
    return res.json(empty);
  }
});
