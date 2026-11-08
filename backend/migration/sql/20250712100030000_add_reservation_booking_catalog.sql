-- Up Migration
--
-- 0028: Reservation booking catalog — service catalog, structured contact
-- fields, customer entity, worker ownership, lifecycle statuses, and
-- capacity enforcement for the Reservations module.

-- ===========================================================================
-- 1. Reservations: add default_locale and timezone
-- ===========================================================================
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS default_locale TEXT NOT NULL DEFAULT 'hu';

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

UPDATE reservations SET timezone = 'UTC' WHERE timezone = 'UTC';

-- ===========================================================================
-- 2. reservation_services — bookable service catalog
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reservation_services (
  id                BIGSERIAL PRIMARY KEY,
  reservation_id    BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled')),
  sort_order        INT NOT NULL DEFAULT 0,
  duration_minutes  INT NOT NULL CHECK (duration_minutes > 0),
  price_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
  currency          TEXT NOT NULL DEFAULT 'HUF'
                      CHECK (length(currency) = 3 AND currency = upper(currency)),
  capacity          INT NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  worker_user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, reservation_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_services_reservation_status_sort
  ON reservation_services (reservation_id, status, sort_order);

CREATE INDEX IF NOT EXISTS idx_reservation_services_worker
  ON reservation_services (worker_user_id)
  WHERE worker_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reservation_services_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_services_updated_at ON reservation_services;
CREATE TRIGGER trg_reservation_services_updated_at
  BEFORE UPDATE ON reservation_services
  FOR EACH ROW
  EXECUTE FUNCTION reservation_services_set_updated_at();

-- ===========================================================================
-- 3. reservation_service_translations — per-locale names/descriptions
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reservation_service_translations (
  service_id    BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  locale        TEXT NOT NULL,
  name          TEXT,
  description   TEXT,
  PRIMARY KEY (service_id, locale),
  CONSTRAINT reservation_service_translations_content_check CHECK (
    name IS NOT NULL OR description IS NOT NULL
  )
);

-- ===========================================================================
-- 4. reservation_service_fields — custom field definitions per service
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reservation_service_fields (
  id            BIGSERIAL PRIMARY KEY,
  service_id    BIGINT NOT NULL REFERENCES reservation_services(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 100),
  field_type    TEXT NOT NULL CHECK (field_type IN ('text', 'textarea', 'select', 'checkbox')),
  required      BOOLEAN NOT NULL DEFAULT false,
  sort_order    INT NOT NULL DEFAULT 0,
  options       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_reservation_service_fields_service
  ON reservation_service_fields (service_id, sort_order);

CREATE OR REPLACE FUNCTION reservation_service_fields_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_service_fields_updated_at ON reservation_service_fields;
CREATE TRIGGER trg_reservation_service_fields_updated_at
  BEFORE UPDATE ON reservation_service_fields
  FOR EACH ROW
  EXECUTE FUNCTION reservation_service_fields_set_updated_at();

-- ===========================================================================
-- 5. reservation_service_field_translations — per-locale field labels
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reservation_service_field_translations (
  field_id      BIGINT NOT NULL REFERENCES reservation_service_fields(id) ON DELETE CASCADE,
  locale        TEXT NOT NULL,
  label         TEXT NOT NULL,
  placeholder   TEXT,
  PRIMARY KEY (field_id, locale)
);

-- ===========================================================================
-- 6. reservation_customers — reusable project-scoped contacts
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reservation_customers (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         CITEXT NOT NULL,
  phone         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, email)
);

CREATE INDEX IF NOT EXISTS idx_reservation_customers_project_status
  ON reservation_customers (project_id, status);

CREATE INDEX IF NOT EXISTS idx_reservation_customers_project_name
  ON reservation_customers (project_id, first_name, last_name);

CREATE INDEX IF NOT EXISTS idx_reservation_customers_project_email
  ON reservation_customers (project_id, email);

CREATE INDEX IF NOT EXISTS idx_reservation_customers_project_phone
  ON reservation_customers (project_id, phone);

CREATE OR REPLACE FUNCTION reservation_customers_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_customers_updated_at ON reservation_customers;
CREATE TRIGGER trg_reservation_customers_updated_at
  BEFORE UPDATE ON reservation_customers
  FOR EACH ROW
  EXECUTE FUNCTION reservation_customers_set_updated_at();

-- ===========================================================================
-- 7. Enrich reservation_bookings with service/contact/status columns
-- ===========================================================================
ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS service_id BIGINT;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS email CITEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS comment TEXT;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS service_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS duration_minutes_snapshot INT,
  ADD COLUMN IF NOT EXISTS price_amount_snapshot NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS currency_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES reservation_customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS worker_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'public'
    CHECK (source IN ('public', 'admin', 'portal', 'import'));

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- ===========================================================================
-- 8. Drop the global EXCLUDE constraint (capacity is now per-service)
-- ===========================================================================
ALTER TABLE reservation_bookings
  DROP CONSTRAINT IF EXISTS reservation_bookings_no_overlap;

DROP INDEX IF EXISTS idx_reservation_bookings_reservation_id_range;
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_service_overlap
  ON reservation_bookings
  USING gist (service_id, tstzrange(starts_at, ends_at, '[)'));

-- ===========================================================================
-- 9. Backfill: create one default service per existing reservation
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reservation_services LIMIT 1) THEN
    INSERT INTO reservation_services (
      reservation_id, status, sort_order, duration_minutes,
      price_amount, currency, capacity, worker_user_id
    )
    SELECT
      r.id, 'active', 0,
      COALESCE(r.slot_duration_minutes, 60),
      0, 'HUF', 1, NULL
    FROM reservations r;

    INSERT INTO reservation_service_translations (service_id, locale, name, description)
    SELECT rs.id, 'hu', r.name, NULL
    FROM reservation_services rs
    JOIN reservations r ON r.id = rs.reservation_id;
  END IF;
END $$;

-- ===========================================================================
-- 10. Backfill: set service_id on all existing bookings
-- ===========================================================================
UPDATE reservation_bookings rb
SET service_id = rs.id
FROM reservation_services rs
WHERE rb.reservation_id = rs.reservation_id
  AND rb.service_id IS NULL
  AND rs.sort_order = 0;

UPDATE reservation_bookings
SET status = 'confirmed'
WHERE status = 'confirmed';

UPDATE reservation_bookings
SET
  first_name = COALESCE(data->>'first_name', data->>'firstName'),
  last_name = COALESCE(data->>'last_name', data->>'lastName'),
  email = COALESCE(data->>'email', data->>'e-mail'),
  phone = COALESCE(data->>'phone', data->>'telefon')
WHERE service_id IS NOT NULL
  AND (data->>'first_name' IS NOT NULL OR data->>'firstName' IS NOT NULL);

ALTER TABLE reservation_bookings
  ALTER COLUMN service_id SET NOT NULL;

ALTER TABLE reservation_bookings
  ADD CONSTRAINT reservation_bookings_service_fk
  FOREIGN KEY (service_id, reservation_id)
  REFERENCES reservation_services (id, reservation_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_customer_id
  ON reservation_bookings (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_status
  ON reservation_bookings (status);
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_worker
  ON reservation_bookings (worker_user_id) WHERE worker_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_created_by
  ON reservation_bookings (created_by_user_id) WHERE created_by_user_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_reservation_bookings_created_by;
DROP INDEX IF EXISTS idx_reservation_bookings_worker;
DROP INDEX IF EXISTS idx_reservation_bookings_status;
DROP INDEX IF EXISTS idx_reservation_bookings_customer_id;
DROP INDEX IF EXISTS idx_reservation_bookings_service_overlap;
ALTER TABLE reservation_bookings
  DROP CONSTRAINT IF EXISTS reservation_bookings_service_fk,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by_user_id,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS timezone,
  DROP COLUMN IF EXISTS currency_snapshot,
  DROP COLUMN IF EXISTS price_amount_snapshot,
  DROP COLUMN IF EXISTS duration_minutes_snapshot,
  DROP COLUMN IF EXISTS service_name_snapshot,
  DROP COLUMN IF EXISTS comment,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS first_name,
  DROP COLUMN IF EXISTS worker_user_id,
  DROP COLUMN IF EXISTS created_by_user_id,
  DROP COLUMN IF EXISTS customer_id,
  DROP COLUMN IF EXISTS service_id;
ALTER TABLE reservation_bookings
  ADD CONSTRAINT reservation_bookings_no_overlap
  EXCLUDE USING gist (
    reservation_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );
DROP TABLE IF EXISTS reservation_service_field_translations CASCADE;
DROP TABLE IF EXISTS reservation_service_fields CASCADE;
DROP TABLE IF EXISTS reservation_service_translations CASCADE;
DROP TABLE IF EXISTS reservation_services CASCADE;
DROP TABLE IF EXISTS reservation_customers CASCADE;
ALTER TABLE reservations
  DROP COLUMN IF EXISTS timezone,
  DROP COLUMN IF EXISTS default_locale;
