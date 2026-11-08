-- Up Migration
--
-- 0014: Reservation disabled ranges — freely defined date/time windows
-- where no bookings are allowed. Unlike bookings (which are customer-
-- initiated), disabled ranges are operator-declared blackouts (holidays,
-- maintenance, lunch breaks, etc.).
--
-- The BE enforces that disabled ranges cannot overlap within the same
-- reservation (EXCLUDE constraint, same pattern as bookings). The public
-- availability endpoint returns both booked AND disabled ranges so the
-- embed can grey out both.
-- ============================================================================

-- Recovery block
DO $$ BEGIN
  DROP TABLE IF EXISTS reservation_disabled_ranges CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0014: recovery drop of reservation_disabled_ranges skipped: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS reservation_disabled_ranges (
  id              BIGSERIAL PRIMARY KEY,
  reservation_id  BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  reason          TEXT CHECK (length(reason) BETWEEN 1 AND 500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_disabled_ranges_valid_range CHECK (ends_at > starts_at)
);

-- Index for the hot query: fetch all disabled ranges for a reservation.
CREATE INDEX IF NOT EXISTS idx_reservation_disabled_ranges_reservation_id
  ON reservation_disabled_ranges (reservation_id, starts_at);

-- GiST index for range overlap queries (same pattern as bookings).
CREATE INDEX IF NOT EXISTS idx_reservation_disabled_ranges_reservation_id_range
  ON reservation_disabled_ranges
  USING gist (reservation_id, tstzrange(starts_at, ends_at, '[)'));

-- No-overlap constraint within the same reservation.
ALTER TABLE reservation_disabled_ranges
  DROP CONSTRAINT IF EXISTS reservation_disabled_ranges_no_overlap;

ALTER TABLE reservation_disabled_ranges
  ADD CONSTRAINT reservation_disabled_ranges_no_overlap
  EXCLUDE USING gist (
    reservation_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );

-- Down Migration

ALTER TABLE reservation_disabled_ranges
  DROP CONSTRAINT IF EXISTS reservation_disabled_ranges_no_overlap;

DROP TABLE IF EXISTS reservation_disabled_ranges;
