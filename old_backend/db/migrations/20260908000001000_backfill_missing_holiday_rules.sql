-- Backfill missing per-service holiday rules.
--
-- The holiday-rules table was backfilled once for services existing at that
-- time, but service creation never seeded rows for NEW services. Those
-- services report an empty holidayRules list, so the UI renders an empty
-- holiday section. Insert the missing (service, key) combos as disabled;
-- admins opt in per holiday from the Blocked page.
-- Services created going forward are seeded by the create-service route.

-- Up
WITH all_holidays AS (
  SELECT unnest(ARRAY[
    'new_year', 'revolution_day', 'good_friday', 'easter_monday',
    'labour_day', 'whit_monday', 'state_foundation_day', 'october_23',
    'all_saints', 'christmas_1', 'christmas_2'
  ]) AS holiday_key
)
INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled)
SELECT rs.id, h.holiday_key, false
FROM reservation_services rs
CROSS JOIN all_holidays h
ON CONFLICT (service_id, holiday_key) DO NOTHING;

-- Down (non-destructive: seeded rows are indistinguishable from
-- admin-disabled rows, so rollback is intentionally a no-op)
SELECT 1;
