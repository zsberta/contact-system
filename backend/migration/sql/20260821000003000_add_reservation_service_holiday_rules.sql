-- Up Migration
--
-- Per-service holiday rules — replaces the auto_holiday row generation model.
-- Instead of creating fixed date rows for each year, store which holidays
-- block each service. The availability check computes holidays dynamically.
--
-- 1. New table: reservation_service_holiday_rules
-- 2. Backfill: for each service with auto_disable_holidays=true, create
--    enabled rules for all known holidays.
-- 3. Remove auto_holiday rows from reservation_disabled_ranges (they are
--    replaced by the dynamic check).

-- 1. Per-service holiday rules
CREATE TABLE IF NOT EXISTS reservation_service_holiday_rules (
  service_id   BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  holiday_key  TEXT NOT NULL CHECK (length(holiday_key) BETWEEN 1 AND 50),
  enabled      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (service_id, holiday_key)
);

CREATE INDEX IF NOT EXISTS idx_reservation_service_holiday_rules_service
  ON reservation_service_holiday_rules (service_id)
  WHERE enabled = true;

-- 2. Backfill: all known holiday keys for each service
--    (enabled = true only for services that had auto_disable_holidays = true)
WITH all_holidays AS (
  SELECT unnest(ARRAY[
    'new_year', 'revolution_day', 'good_friday', 'easter_monday',
    'labour_day', 'whit_monday', 'state_foundation_day', 'october_23',
    'all_saints', 'christmas_1', 'christmas_2'
  ]) AS holiday_key
),
all_services AS (
  SELECT rs.id AS service_id, COALESCE(p.auto_disable_holidays, false) AS auto_holidays
  FROM reservation_services rs
  LEFT JOIN reservation_service_disable_policies p ON p.service_id = rs.id
)
INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled)
SELECT s.service_id, h.holiday_key, s.auto_holidays
FROM all_services s
CROSS JOIN all_holidays h
ON CONFLICT (service_id, holiday_key) DO NOTHING;

-- 3. Remove auto_holiday rows — they are replaced by the dynamic check.
--    Also remove their join table entries.
DELETE FROM reservation_disabled_range_services
WHERE disabled_range_id IN (
  SELECT id FROM reservation_disabled_ranges WHERE source = 'auto_holiday'
);

DELETE FROM reservation_disabled_ranges WHERE source = 'auto_holiday';

-- Down Migration

DELETE FROM reservation_service_holiday_rules;
DROP TABLE IF EXISTS reservation_service_holiday_rules;
