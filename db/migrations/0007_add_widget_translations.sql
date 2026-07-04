-- Up Migration

ALTER TABLE widgets
  ADD COLUMN IF NOT EXISTS name_i18n JSONB NOT NULL DEFAULT '{"en": "", "hu": ""}'::jsonb;

-- Backfill: copy existing `name` into both locales. The application-level
-- auto-upgrade (upgradeField / nameI18n handling in routes/widgets.js) does
-- the same for row writes; this keeps existing rows consistent immediately
-- after the migration runs so subsequent SELECTs return a non-empty
-- nameI18n without depending on a write to trigger the upgrade.
UPDATE widgets
SET name_i18n = jsonb_build_object('en', name, 'hu', name)
WHERE name_i18n = '{"en": "", "hu": ""}'::jsonb;

-- Down Migration
ALTER TABLE widgets DROP COLUMN IF EXISTS name_i18n;
