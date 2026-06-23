import { pool } from "../db/pool.js";
import { computeNextDue, dateToYMD } from "../lib/billing-dates.js";

const TERMINAL_STATUSES = ["paid", "cancelled", "completed", "customer_paid"];

// Whole-day diff (a, b in UTC). Rounds toward negative infinity.
function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Decide whether a project should transition status based on its days-to-due.
 *
 * Order of checks matters — the "overdue → notified_customer" rule is
 * evaluated first because it doesn't depend on the days window.
 */
function decideTransition(currentStatus, daysUntilDue) {
  // 1. Overdue: only flips waiting_for_payment -> notified_customer.
  if (daysUntilDue <= 0 && currentStatus === "waiting_for_payment") {
    return "notified_customer";
  }
  // 2. Within 30 days (and not already in the waiting/notification chain).
  if (daysUntilDue > 0 && daysUntilDue <= 30) {
    if (
      currentStatus !== "waiting_for_payment" &&
      currentStatus !== "notified_customer"
    ) {
      return "waiting_for_payment";
    }
    return null;
  }
  // 3. 31..45 days ahead.
  if (daysUntilDue > 30 && daysUntilDue <= 45) {
    if (
      currentStatus !== "have_to_notify" &&
      currentStatus !== "waiting_for_payment" &&
      currentStatus !== "notified_customer"
    ) {
      return "have_to_notify";
    }
    return null;
  }
  return null;
}

export async function runProjectStatusCron() {
  const log = (...args) => console.log("[cron projects]", ...args);
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const { rows } = await pool.query(
      `SELECT id, fordulonap, billing_period, status
       FROM projects
       WHERE fordulonap IS NOT NULL AND billing_period IS NOT NULL`,
    );

    const transitions = []; // { id, from, to, _billingPeriod, _fordulonap }
    for (const r of rows) {
      if (TERMINAL_STATUSES.includes(r.status)) continue;
      const next = computeNextDue(r.billing_period, r.fordulonap, today);
      if (!next) continue;
      const diff = daysBetween(today, next); // positive = future, 0 = today, negative = overdue
      const to = decideTransition(r.status, diff);
      if (to && to !== r.status) {
        // Stash period + fordulonap so the payment-creation step below can
        // recompute the same next-due date without re-reading the project row.
        transitions.push({
          id: r.id,
          from: r.status,
          to,
          _billingPeriod: r.billing_period,
          _fordulonap: r.fordulonap,
        });
      }
    }

    // Each update is its own atomic operation guarded by the WHERE-clause
    // status match, so we won't clobber a manual change made between the
    // SELECT and the UPDATE.
    for (const t of transitions) {
      try {
        const { rowCount } = await pool.query(
          `UPDATE projects
           SET status = $1, last_status_change_at = now(), updated_at = now()
           WHERE id = $2 AND status = $3`,
          [t.to, t.id, t.from],
        );
        if (rowCount > 0) log(`#${t.id}: ${t.from} -> ${t.to}`);
      } catch (e) {
        console.error(
          "[cron projects] update failed for id",
          t.id,
          e.code ?? "",
          e.message,
        );
      }
    }

    // -- Payment side-effects --
    // 1. For each project that just transitioned into 'waiting_for_payment',
    //    create an auto-pending payment for the next due date. We re-check
    //    status via WHERE status = $3 in the UPDATE above so a manual change
    //    that happened concurrently would have made our update no-op (and
    //    we'd not see it in transitions anyway). The auto-create uses an
    //    ON CONFLICT DO NOTHING for the second-layer race safety.
    let paymentsCreated = 0;
    for (const t of transitions) {
      if (t.to !== "waiting_for_payment") continue;
      try {
        const projRes = await pool.query(
          `SELECT id, price FROM projects WHERE id = $1`,
          [t.id],
        );
        if (projRes.rowCount === 0) continue;
        const project = projRes.rows[0];
        const next = computeNextDue(t._billingPeriod, t._fordulonap, today);
        if (!next) continue;
        const result = await findOrCreateAutoPayment(project, next, t._billingPeriod);
        if (result.created) {
          paymentsCreated += 1;
          log(`#${t.id}: created payment (id=${result.id})`);
        }
      } catch (e) {
        console.error(
          "[cron projects] payment create failed for project",
          t.id,
          e.code ?? "",
          e.message,
        );
      }
    }

    // 2. Mark pending payments whose due_date has passed as 'overdue'.
    let paymentsOverdue = 0;
    try {
      paymentsOverdue = await markOverduePayments();
      if (paymentsOverdue > 0) {
        log(`marked ${paymentsOverdue} payments as overdue`);
      }
    } catch (e) {
      console.error(
        "[cron projects] overdue update failed",
        e.code ?? "",
        e.message,
      );
    }

    log(
      `processed ${rows.length} projects, ${transitions.length} transitions, ` +
        `${paymentsCreated} payments created, ${paymentsOverdue} payments overdue`,
    );
    return {
      processed: rows.length,
      transitions: transitions.length,
      paymentsCreated,
      paymentsOverdue,
    };
  } catch (e) {
    console.error("[cron projects] tick failed", e.code ?? "", e.message);
    return { error: e.message };
  }
}

/**
 * Create (or find) the pending payment row for one auto-billing event.
 *
 * Returns { id, created }. `created` is true only when this call actually
 * inserted a new row; `id` may be null if the row was neither pre-existing
 * nor insertable (e.g. race lost on the ON CONFLICT branch).
 *
 * Skips when:
 *   - no next-due date
 *   - no price (or non-positive price)
 *   - the project row vanished between SELECT and here
 */
export async function findOrCreateAutoPayment(project, nextDue, billingPeriod) {
  if (!nextDue || !project.price || project.price <= 0) {
    return { id: null, created: false };
  }

  const dueDateStr = dateToYMD(nextDue);

  // Cheap pre-check: avoid the INSERT round-trip if there's already an active
  // payment for this (project_id, due_date).
  const existing = await pool.query(
    `SELECT id FROM payments
     WHERE project_id = $1 AND due_date = $2
       AND status IN ('pending', 'paid', 'overdue')
     LIMIT 1`,
    [project.id, dueDateStr],
  );
  if (existing.rowCount > 0) {
    return { id: Number(existing.rows[0].id), created: false };
  }

  // Race-safe insert. The partial unique index
  // uq_payments_project_due_active has the same predicate as our pre-check,
  // so the WHERE clause on the ON CONFLICT matches the index expression.
  const { rows } = await pool.query(
    `INSERT INTO payments (project_id, amount, status, due_date, period, created_by)
     VALUES ($1, $2, 'pending', $3, $4, 'auto')
     ON CONFLICT (project_id, due_date) WHERE status IN ('pending', 'paid', 'overdue')
     DO NOTHING
     RETURNING id`,
    [project.id, project.price, dueDateStr, billingPeriod],
  );
  if (rows.length === 0) {
    // Lost the race — another cron instance inserted between our pre-check
    // and now. That's fine, the existing payment covers this due date.
    return { id: null, created: false };
  }
  return { id: Number(rows[0].id), created: true };
}

/**
 * Flip all `pending` payments whose due_date is in the past to `overdue`.
 * Returns the number of rows updated.
 */
export async function markOverduePayments() {
  const { rowCount } = await pool.query(
    `UPDATE payments
     SET status = 'overdue', updated_at = now()
     WHERE status = 'pending' AND due_date < CURRENT_DATE`,
  );
  return rowCount;
}

let timer = null;
let interval = null;

export function startProjectStatusCron() {
  if (process.env.DISABLE_CRON === "true") {
    console.log("[cron projects] disabled by DISABLE_CRON=true");
    return;
  }

  const tick = () => {
    runProjectStatusCron().catch((e) => {
      console.error("[cron projects] tick rejected", e?.message);
    });
  };

  // First tick at next 06:00 UTC, then every 24h. If we're already past 06:00
  // UTC today, schedule for tomorrow.
  const now = new Date();
  const next6 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0),
  );
  if (next6 <= now) next6.setUTCDate(next6.getUTCDate() + 1);
  const ms = next6.getTime() - now.getTime();
  console.log(
    `[cron projects] first tick at ${next6.toISOString()} (in ${Math.round(ms / 1000)}s)`,
  );
  timer = setTimeout(() => {
    tick();
    interval = setInterval(tick, 24 * 60 * 60 * 1000);
  }, ms);

  const shutdown = () => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    // Don't kill the pool here — server.js owns it. Just release our handles.
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
