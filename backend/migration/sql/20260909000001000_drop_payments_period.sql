-- Up Migration
-- Invoices are fully manual and the table holds no real invoices yet.
-- `period` was a leftover label of the retired auto-generation flow with no
-- readers anywhere, so drop the column and its enum type outright.
-- node-pg-migrate wraps each migration in a single transaction; plain
-- ALTER/DROP is safe inside it (whole migration is atomic).

ALTER TABLE payments DROP COLUMN IF EXISTS period;
DROP TYPE IF EXISTS payment_period;

-- Down Migration
-- Restores the column for rollback only; nothing in the code reads it.
DO $$ BEGIN
  CREATE TYPE payment_period AS ENUM ('monthly', 'yearly', 'one_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period payment_period;
