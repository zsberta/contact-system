-- Backfill existing reservations timezone.
--
-- The timezone column was added in the original reservation catalog migration
-- but never populated — every reservation defaulted to 'UTC'. All current
-- reservations operate in Europe/Budapest, so we backfill those.
-- Future reservations get their timezone from the create/edit form.

-- Up
UPDATE reservations SET timezone = 'Europe/Budapest' WHERE timezone = 'UTC';

-- Down (non-destructive: reset to UTC)
UPDATE reservations SET timezone = 'UTC' WHERE timezone = 'Europe/Budapest';
