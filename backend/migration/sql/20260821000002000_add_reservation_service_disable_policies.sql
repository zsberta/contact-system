-- Up Migration
--
-- Reservation service-scoped disable policies.
--
-- Makes disabled-range and holiday-disable controls target individual
-- reservation services instead of the entire reservation.
--
-- Changes:
-- 1. reservation_service_disable_policies — per-service auto-holiday flag
-- 2. reservation_disabled_range_services — join table linking ranges to services
-- 3. Drop EXCLUDE constraint on reservation_disabled_ranges (service-scoped
--    ranges can legitimately overlap for different services; overlap is
--    enforced at the application layer per-service).
-- 4. Backfill from existing reservation-level settings.

-- 1. Per-service holiday policy
CREATE TABLE IF NOT EXISTS reservation_service_disable_policies (
  service_id              BIGINT PRIMARY KEY REFERENCES reservation_services(id) ON DELETE CASCADE,
  auto_disable_holidays   BOOLEAN NOT NULL DEFAULT false
);

-- 2. Range-service join table
CREATE TABLE IF NOT EXISTS reservation_disabled_range_services (
  disabled_range_id  BIGINT NOT NULL REFERENCES reservation_disabled_ranges(id) ON DELETE CASCADE,
  service_id         BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  PRIMARY KEY (disabled_range_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_disabled_range_services_service
  ON reservation_disabled_range_services (service_id);

-- 3. Drop the EXCLUDE constraint (service-scoped ranges can overlap)
ALTER TABLE reservation_disabled_ranges
  DROP CONSTRAINT IF EXISTS reservation_disabled_ranges_no_overlap;

-- 4. Backfill policies: copy reservation-level flag to each service
INSERT INTO reservation_service_disable_policies (service_id, auto_disable_holidays)
SELECT rs.id, COALESCE(r.disable_hungarian_holidays, false)
FROM reservation_services rs
JOIN reservations r ON r.id = rs.reservation_id
ON CONFLICT (service_id) DO NOTHING;

-- 5. Backfill range-service links: link every existing range to every
--    service in the same reservation. This preserves current behavior
--    (all services blocked by existing ranges) while making associations
--    explicit for the new service-scoped availability check.
INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id)
SELECT dr.id, rs.id
FROM reservation_disabled_ranges dr
JOIN reservation_services rs ON rs.reservation_id = dr.reservation_id
ON CONFLICT DO NOTHING;

-- Down Migration

-- Restore the EXCLUDE constraint
ALTER TABLE reservation_disabled_ranges
  ADD CONSTRAINT reservation_disabled_ranges_no_overlap EXCLUDE USING gist (
    reservation_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );

DROP TABLE IF EXISTS reservation_disabled_range_services;
DROP TABLE IF EXISTS reservation_service_disable_policies;
