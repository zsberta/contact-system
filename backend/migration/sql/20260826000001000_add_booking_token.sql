-- Up Migration
--
-- 0035: Add booking_token to reservation_bookings for customer self-service.
-- Each booking gets a unique, unguessable UUID-v4 token that serves as
-- the capability for the public manage/delete/modify endpoints.
-- The token is generated server-side at booking creation time and
-- returned in the confirmation email as a link.

-- ---------------------------------------------------------------------------
-- 1. Add booking_token column with default for new rows
-- ---------------------------------------------------------------------------
ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS booking_token TEXT DEFAULT gen_random_uuid()::text;

-- ---------------------------------------------------------------------------
-- 2. Backfill existing bookings that have no token
-- ---------------------------------------------------------------------------
UPDATE reservation_bookings
SET booking_token = gen_random_uuid()::text
WHERE booking_token IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Set NOT NULL + UNIQUE constraint
-- ---------------------------------------------------------------------------
ALTER TABLE reservation_bookings
  ALTER COLUMN booking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_bookings_booking_token
  ON reservation_bookings (booking_token);

-- Down Migration
DROP INDEX IF EXISTS idx_reservation_bookings_booking_token;
ALTER TABLE reservation_bookings
  DROP COLUMN IF EXISTS booking_token;
