-- Up Migration
-- Per-reservation booking reminder: hours before starts_at to send a reminder.
-- NULL = disabled. Booking-level reminder_sent_at provides idempotent send.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS reminder_hours_before INTEGER
    CHECK (reminder_hours_before IS NULL OR (reminder_hours_before >= 1 AND reminder_hours_before <= 168));

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_reminder_due
  ON reservation_bookings (starts_at)
  WHERE reminder_sent_at IS NULL AND status = 'confirmed';

-- Down Migration
DROP INDEX IF EXISTS idx_reservation_bookings_reminder_due;
ALTER TABLE reservation_bookings DROP COLUMN IF EXISTS reminder_sent_at;
ALTER TABLE reservations DROP COLUMN IF EXISTS reminder_hours_before;
