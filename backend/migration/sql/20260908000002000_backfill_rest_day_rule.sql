-- Backfill the generic rest-day rule key for all services.
--
-- Bridge rest days (pihenőnapok) are toggled with a single generic
-- `rest_day` key whose dates come from a per-year table in
-- lib/hungarian-holidays.js. Existing services lack the row, so the
-- toggle would render with no backend state. Insert as disabled;
-- admins opt in from the Blocked page.

-- Up
INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled)
SELECT rs.id, 'rest_day', false
FROM reservation_services rs
ON CONFLICT (service_id, holiday_key) DO NOTHING;

-- Down (non-destructive: seeded rows are indistinguishable from
-- admin-disabled rows, so rollback is intentionally a no-op)
SELECT 1;
