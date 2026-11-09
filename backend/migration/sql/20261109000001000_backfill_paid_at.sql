-- Backfill paid_at for paid payments that lack it.
--
-- Dashboard revenue (30/90/365d totals + monthly chart) aggregates by paid_at.
-- Paid rows written before paid_at bookkeeping existed carry paid_at = NULL
-- and silently vanish from every revenue figure, leaving the chart empty even
-- though paid data exists. Backfill from updated_at (the moment the row was
-- last touched, i.e. marked paid). Idempotent: only touches NULLs.

-- Up
UPDATE payments
SET paid_at = updated_at
WHERE status = 'paid' AND paid_at IS NULL;

-- Down (non-destructive: backfilled timestamps are indistinguishable from
-- bookkeeping-written ones, so rollback is intentionally a no-op)
SELECT 1;
