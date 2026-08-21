-- Up Migration
-- 0029: Reservation service assets and schedules.

CREATE TABLE IF NOT EXISTS reservation_service_attachments (
  id                BIGSERIAL PRIMARY KEY,
  service_id        BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_filename   TEXT NOT NULL UNIQUE,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT 'cover'
                      CHECK (purpose IN ('cover')),
  uploaded_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_service_attachments_service_purpose
  ON reservation_service_attachments (service_id, purpose)
  WHERE purpose = 'cover';

CREATE TABLE IF NOT EXISTS reservation_service_availability_schedules (
  id              BIGSERIAL PRIMARY KEY,
  service_id      BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  frequency       TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month    SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_service_avail_schedules_valid_range CHECK (end_time > start_time),
  CONSTRAINT reservation_service_avail_schedules_daily_check CHECK (
    frequency != 'daily' OR (day_of_week IS NULL AND day_of_month IS NULL)
  ),
  CONSTRAINT reservation_service_avail_schedules_weekly_check CHECK (
    frequency != 'weekly' OR (day_of_week IS NOT NULL AND day_of_month IS NULL)
  ),
  CONSTRAINT reservation_service_avail_schedules_monthly_check CHECK (
    frequency != 'monthly' OR (day_of_month IS NOT NULL AND day_of_week IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_reservation_service_avail_schedules_service_id
  ON reservation_service_availability_schedules (service_id, frequency);

-- Down Migration
DROP TABLE IF EXISTS reservation_service_availability_schedules CASCADE;
DROP TABLE IF EXISTS reservation_service_attachments CASCADE;
