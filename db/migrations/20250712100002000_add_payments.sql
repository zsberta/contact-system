-- Up Migration

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'overdue', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_period AS ENUM ('monthly', 'yearly', 'one_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_origin AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  amount       NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  status       payment_status NOT NULL DEFAULT 'pending',
  due_date     DATE NOT NULL,
  period       payment_period,
  created_by   payment_origin NOT NULL DEFAULT 'manual',
  paid_at      TIMESTAMPTZ,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Listing payments under a project (newest due_date first).
CREATE INDEX IF NOT EXISTS idx_payments_project_due
  ON payments (project_id, due_date DESC, id DESC);

-- Cron scan: find pending payments whose due_date has passed.
CREATE INDEX IF NOT EXISTS idx_payments_overdue
  ON payments (status, due_date)
  WHERE status = 'pending';

-- Dashboard aggregation: revenue per paid_at month.
CREATE INDEX IF NOT EXISTS idx_payments_paid_at
  ON payments (paid_at)
  WHERE status = 'paid';

-- updated_at touch trigger — mirrors the projects pattern.
CREATE OR REPLACE FUNCTION payments_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_touch_updated_at ON payments;
CREATE TRIGGER trg_payments_touch_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION payments_touch_updated_at();

-- Idempotency guard for the cron auto-create path. We allow multiple
-- 'cancelled' payments for the same project+due_date (a user might cancel
-- and then a manual override later could re-open with a new row) but only
-- one active payment at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_project_due_active
  ON payments (project_id, due_date)
  WHERE status IN ('pending', 'paid', 'overdue');

-- Down Migration

DROP TRIGGER IF EXISTS trg_payments_touch_updated_at ON payments;
DROP FUNCTION IF EXISTS payments_touch_updated_at();
DROP INDEX IF EXISTS uq_payments_project_due_active;
DROP INDEX IF EXISTS idx_payments_paid_at;
DROP INDEX IF EXISTS idx_payments_overdue;
DROP INDEX IF EXISTS idx_payments_project_due;
DROP TABLE IF EXISTS payments;
DROP TYPE IF EXISTS payment_origin;
DROP TYPE IF EXISTS payment_period;
DROP TYPE IF EXISTS payment_status;