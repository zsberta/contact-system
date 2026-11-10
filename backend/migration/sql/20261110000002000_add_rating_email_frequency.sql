-- Up Migration
--
-- Per-project rating-email frequency: send a rating request every Nth
-- attended booking instead of every one. N = 1 preserves the old
-- behavior (every attended visit emails until the guest rates).
--
-- The worker counts the guest's past attended bookings
-- (same reservation + email, visit already over) and sends when the
-- current visit is the 1st, Nth, 2Nth, ... one. Skipped bookings are
-- still stamped (rating_sent_at) so they are never reconsidered.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS rating_email_every_n_bookings INTEGER NOT NULL DEFAULT 1
    CHECK (rating_email_every_n_bookings >= 1 AND rating_email_every_n_bookings <= 1000);

-- Supports the worker's per-guest ordinal count:
-- same reservation + attended + same email + past visits in order.
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_rating_ordinal
  ON reservation_bookings (reservation_id, status, lower(email), ends_at);

-- Down Migration
DROP INDEX IF EXISTS idx_reservation_bookings_rating_ordinal;
ALTER TABLE projects DROP COLUMN IF EXISTS rating_email_every_n_bookings;
