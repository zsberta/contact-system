-- Up Migration
--
-- 0015: Reservation availability schedules — recurring time-slot templates
-- that define WHEN a reservation is open for bookings. Unlike disabled
-- ranges (which block specific date/time windows), availability schedules
-- are positive declarations: "on Mondays, we're open 09:00–12:00 and
-- 13:00–17:00".
--
-- Three frequency modes:
--   daily   — applies to every day (day_of_week, day_of_month NULL)
--   weekly  — applies to a specific weekday (0=Sun..6=Sat)
--   monthly — applies to a specific day-of-month (1..31)
--
-- Multiple entries per (reservation, frequency, day) are allowed so the
-- operator can declare split shifts (morning + afternoon with a gap).
-- The FE sorts and renders them in time order.
-- ============================================================================

-- Recovery block
DO $$ BEGIN
  DROP TABLE IF EXISTS reservation_availability_schedules CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0015: recovery drop of reservation_availability_schedules skipped: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS reservation_availability_schedules (
  id              BIGSERIAL PRIMARY KEY,
  reservation_id  BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  frequency       TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month    SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Valid time range
  CONSTRAINT reservation_avail_schedules_valid_range CHECK (end_time > start_time),
  -- Frequency-specific day constraints:
  --   daily:   both day columns must be NULL
  --   weekly:  day_of_week required, day_of_month must be NULL
  --   monthly: day_of_month required, day_of_week must be NULL
  CONSTRAINT reservation_avail_schedules_daily_check CHECK (
    frequency != 'daily' OR (day_of_week IS NULL AND day_of_month IS NULL)
  ),
  CONSTRAINT reservation_avail_schedules_weekly_check CHECK (
    frequency != 'weekly' OR (day_of_week IS NOT NULL AND day_of_month IS NULL)
  ),
  CONSTRAINT reservation_avail_schedules_monthly_check CHECK (
    frequency != 'monthly' OR (day_of_month IS NOT NULL AND day_of_week IS NULL)
  )
);

-- Index: fetch all schedules for a reservation.
CREATE INDEX IF NOT EXISTS idx_reservation_avail_schedules_reservation_id
  ON reservation_availability_schedules (reservation_id, frequency);

-- Down Migration

DROP TABLE IF EXISTS reservation_availability_schedules CASCADE;
