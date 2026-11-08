-- Up Migration
--
-- Reservation customer profiles — opaque browser-saved tokens that map
-- back to reservation_customers. The browser stores only the raw UUID
-- token; the server stores only the SHA-256 hash. This allows
-- "remember me" functionality without leaking PII to localStorage.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reservation_customer_profiles (
  id                BIGSERIAL PRIMARY KEY,
  reservation_id    BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  customer_id       BIGINT NOT NULL REFERENCES reservation_customers(id) ON DELETE CASCADE,
  profile_token_hash TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reservation_id, profile_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_reservation_customer_profiles_lookup
  ON reservation_customer_profiles (reservation_id, profile_token_hash);

CREATE OR REPLACE FUNCTION reservation_customer_profiles_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_customer_profiles_updated_at ON reservation_customer_profiles;
CREATE TRIGGER trg_reservation_customer_profiles_updated_at
  BEFORE UPDATE ON reservation_customer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION reservation_customer_profiles_set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_reservation_customer_profiles_updated_at ON reservation_customer_profiles;
DROP FUNCTION IF EXISTS reservation_customer_profiles_set_updated_at();
DROP TABLE IF EXISTS reservation_customer_profiles;
