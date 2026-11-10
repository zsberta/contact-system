-- Up Migration
--
-- Deploy guard: never email historical attended bookings.
--
-- The ratings worker picks up every attended, past booking with
-- rating_sent_at IS NULL. On an environment that already has attended
-- bookings (e.g. production at feature-deploy time), those would ALL
-- look due on first boot and every past guest would get emailed at once.
-- Stamp them as processed up front so only visits marked attended AFTER
-- this migration can generate rating emails. Scoped to visits already
-- over (ends_at < now()) — future-dated attended bookings keep NULL and
-- email normally once their visit ends.
-- Idempotent: only touches rows the worker would otherwise grab.

UPDATE reservation_bookings
SET rating_sent_at = now()
WHERE status = 'attended'
  AND rating_sent_at IS NULL
  AND ends_at < now();

-- Down Migration (non-destructive no-op: un-stamping would re-arm emails)
SELECT 1;
