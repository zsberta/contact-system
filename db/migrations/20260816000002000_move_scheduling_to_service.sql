-- Up Migration
-- Move scheduling config from reservation to service level.
-- Each service now owns its own granularity, slot grid, lead time, and advance window.

ALTER TABLE reservation_services ADD COLUMN IF NOT EXISTS granularity TEXT NOT NULL DEFAULT 'hour' CHECK (granularity IN ('day', 'hour', 'minute'));
ALTER TABLE reservation_services ADD COLUMN IF NOT EXISTS slot_duration_minutes INTEGER CHECK (slot_duration_minutes IS NULL OR slot_duration_minutes > 0);
ALTER TABLE reservation_services ADD COLUMN IF NOT EXISTS lead_time_minutes INTEGER NOT NULL DEFAULT 60 CHECK (lead_time_minutes >= 0);
ALTER TABLE reservation_services ADD COLUMN IF NOT EXISTS max_advance_days INTEGER NOT NULL DEFAULT 90 CHECK (max_advance_days >= 1);

-- Defence-in-depth: slot_duration_minutes only meaningful for hour/minute granularity
ALTER TABLE reservation_services ADD CONSTRAINT reservation_services_slot_duration_for_granularity CHECK (
  slot_duration_minutes IS NULL OR granularity IN ('hour', 'minute')
);

-- Down Migration
ALTER TABLE reservation_services DROP CONSTRAINT IF EXISTS reservation_services_slot_duration_for_granularity;
ALTER TABLE reservation_services DROP COLUMN IF EXISTS granularity;
ALTER TABLE reservation_services DROP COLUMN IF EXISTS slot_duration_minutes;
ALTER TABLE reservation_services DROP COLUMN IF EXISTS lead_time_minutes;
ALTER TABLE reservation_services DROP COLUMN IF EXISTS max_advance_days;
