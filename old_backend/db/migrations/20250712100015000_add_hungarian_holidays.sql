-- Up Migration
-- 0016: Hungarian holidays feature
--
-- 1. Add `disable_hungarian_holidays` boolean to reservations
-- 2. Add `source` and `enabled` columns to reservation_disabled_ranges
--    to support auto-generated holiday records with soft-disable.
-- ============================================================================

-- 1. reservations table: add toggle
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS disable_hungarian_holidays BOOLEAN NOT NULL DEFAULT false;

-- 2. reservation_disabled_ranges: add source + enabled
ALTER TABLE reservation_disabled_ranges
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';

ALTER TABLE reservation_disabled_ranges
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- Index for the hot query: fetch enabled auto holidays per reservation.
CREATE INDEX IF NOT EXISTS idx_reservation_disabled_ranges_source_enabled
  ON reservation_disabled_ranges (reservation_id, source, enabled)
  WHERE source = 'auto_holiday';

-- Down Migration

DROP INDEX IF EXISTS idx_reservation_disabled_ranges_source_enabled;
ALTER TABLE reservation_disabled_ranges DROP COLUMN IF EXISTS enabled;
ALTER TABLE reservation_disabled_ranges DROP COLUMN IF EXISTS source;
ALTER TABLE reservations DROP COLUMN IF EXISTS disable_hungarian_holidays;
