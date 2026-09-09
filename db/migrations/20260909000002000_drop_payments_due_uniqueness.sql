-- Up Migration
-- Manual invoicing: a project may hold several active invoices sharing one
-- due date (partial invoices, corrections). The partial unique index below
-- only existed as the retired auto-create idempotency guard, so drop it.
-- node-pg-migrate wraps each migration in a single transaction; plain
-- DROP INDEX is safe inside it (whole migration is atomic).

DROP INDEX IF EXISTS uq_payments_project_due_active;

-- Down Migration
-- Restores the guard. Fails if duplicate active (project_id, due_date) rows
-- were created while the index was gone — resolve those manually first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_project_due_active
  ON payments (project_id, due_date)
  WHERE status IN ('pending', 'paid', 'overdue');
