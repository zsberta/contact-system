-- Up Migration
--
-- Reservation ratings + rating-request emails:
-- - projects.google_review_url: operator-set link to the project's Google
--   business review page. Shown to customers after a 3-5 star rating.
-- - reservation_bookings.rating_sent_at: idempotent stamp for the
--   rating-request email worker (mirrors reminder_sent_at).
-- - reservation_ratings: one row per rated booking (UNIQUE booking_id),
--   with service snapshot info for the admin list.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS google_review_url TEXT;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS rating_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_rating_due
  ON reservation_bookings (starts_at)
  WHERE rating_sent_at IS NULL AND status = 'attended';

CREATE TABLE IF NOT EXISTS reservation_ratings (
  id                BIGSERIAL PRIMARY KEY,
  reservation_id    BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  service_id        BIGINT REFERENCES reservation_services(id) ON DELETE SET NULL,
  booking_id        BIGINT NOT NULL UNIQUE REFERENCES reservation_bookings(id) ON DELETE CASCADE,
  customer_id       BIGINT REFERENCES reservation_customers(id) ON DELETE SET NULL,
  rater_name        TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservation_ratings_reservation
  ON reservation_ratings (reservation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_ratings_service
  ON reservation_ratings (service_id);

CREATE INDEX IF NOT EXISTS idx_reservation_ratings_email
  ON reservation_ratings (reservation_id, lower(email));

CREATE OR REPLACE FUNCTION reservation_ratings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_ratings_updated_at ON reservation_ratings;
CREATE TRIGGER trg_reservation_ratings_updated_at
  BEFORE UPDATE ON reservation_ratings
  FOR EACH ROW
  EXECUTE FUNCTION reservation_ratings_set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS trg_reservation_ratings_updated_at ON reservation_ratings;
DROP FUNCTION IF EXISTS reservation_ratings_set_updated_at();
DROP TABLE IF EXISTS reservation_ratings;
DROP INDEX IF EXISTS idx_reservation_bookings_rating_due;
ALTER TABLE reservation_bookings DROP COLUMN IF EXISTS rating_sent_at;
ALTER TABLE projects DROP COLUMN IF EXISTS google_review_url;
