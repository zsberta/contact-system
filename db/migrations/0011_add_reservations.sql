-- Up Migration
--
-- 0011: Reservations module (sibling of Forms). Operator-declared,
-- project-scoped reservation "form" with a structured date/time window
-- (starts_at, ends_at) and an optional free-form `data` JSONB bag.
--
-- The headline difference vs. forms is that the BE must UNDERSTAND the
-- date/time window so the public GET availability endpoint can answer
-- "what ranges are already taken?" without the FE having to fetch every
-- booking and compute overlaps.
--
-- Concurrency safety is provided by a Postgres EXCLUDE constraint with
-- tstzrange + gist, so two simultaneous POSTs at 16:00 are atomic: one
-- wins (201), one fails (409). No TOCTOU window in app code.
-- ============================================================================
-- IDEMPOTENCY STRATEGY
-- ============================================================================
-- Mirrors the pattern used by 0010 (forms):
--   - RECOVERY DROP BLOCK at the top, wrapped in DO/EXCEPTION, drops
--     orphaned reservations / reservation_bookings from partial runs.
--   - IF NOT EXISTS on every CREATE so a clean re-run is safe.
--   - CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS for the
--     updated_at trigger.
--
-- ============================================================================
-- SCHEMA NOTES
-- ============================================================================
-- `reservations` mirrors `forms` 1:1 for the operator-side config columns
-- (project_id, name, slug, secret_token, allowed_origins, status,
--  created_at, updated_at). The reservations-specific columns are:
--
--   granularity            — day / hour / minute (TEX enums avoided)
--   slot_duration_minutes  — optional; only meaningful when granularity
--                            is hour or minute. Aligned to a grid:
--                            if slot=30 then bookings must be 16:00,
--                            16:30, 17:00… (BE enforces).
--   lead_time_minutes      — minimum minutes from "now" until the
--                            booking start (avoid last-minute spam).
--   max_advance_days       — maximum days in the future a booking may
--                            begin (use 1 to forbid today+).
--   extra_fields_enabled   — when true, public POSTs accept an optional
--                            `data` JSONB bag (same validation rules
--                            as form_submissions: depth ≤ 5, ≤ 50
--                            keys/level, ≤ 50 KB). When false, the
--                            `data` field is ignored / 400.
--
-- `reservation_bookings` mirrors `form_submissions` for metadata capture
-- but adds the structured date/time window:
--
--   starts_at, ends_at     — TIMESTAMPTZ; EXCLUDE constraint uses
--                            tstzrange(starts_at, ends_at, '[)')
--                            so [a, b) overlaps iff a < other.b AND
--                            other.a < b.
--
-- The CHECK on (ends_at > starts_at) is duplicate-but-defence-in-depth
-- for the EXCLUDE constraint.
-- ============================================================================
-- TRANSACTION NOTE
-- ============================================================================
-- node-pg-migrate wraps each migration in a single transaction. EXCLUDE
-- USING gist (without CONCURRENTLY) is safe inside a transaction; we
-- deliberately do NOT use CONCURRENTLY so the whole migration is atomic.

-- ---------------------------------------------------------------------------
-- Required extension for combining btree-equality on reservation_id with a
-- gist range. CREATE EXTENSION IF NOT EXISTS is idempotent.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Recovery block — drop orphaned reservations / reservation_bookings
-- from partial runs. Wrapped in DO/EXCEPTION for safety on a greenfield
-- database where the new tables don't exist yet.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS reservation_bookings CASCADE;
  DROP TABLE IF EXISTS reservations CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0011: recovery drop of reservations skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Reservations table (the "form" / operator config)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id                  BIGSERIAL PRIMARY KEY,
  project_id          BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Same human-readable kebab-case label as forms.slug. NOT used for auth.
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug                TEXT NOT NULL UNIQUE CHECK (
                        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                        AND length(slug) BETWEEN 1 AND 50
                      ),
  -- 22-char base64url token, generated server-side, immutable post-create.
  secret_token        TEXT NOT NULL UNIQUE CHECK (length(secret_token) = 22),
  allowed_origins     TEXT[] NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Reservation-specific config
  granularity         TEXT NOT NULL DEFAULT 'hour' CHECK (granularity IN ('day', 'hour', 'minute')),
  slot_duration_minutes INTEGER CHECK (slot_duration_minutes IS NULL OR slot_duration_minutes > 0),
  -- lead_time_minutes = 0 means "no minimum notice"; rejected otherwise.
  -- max_advance_days = 1 means "until tomorrow inclusive"; >= 1 enforced.
  lead_time_minutes   INTEGER NOT NULL DEFAULT 60 CHECK (lead_time_minutes >= 0),
  max_advance_days    INTEGER NOT NULL DEFAULT 90 CHECK (max_advance_days >= 1),
  -- When false, public POSTs REJECT a `data` field. When true, the same
  -- bounded-bag validation as form submissions applies.
  extra_fields_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Defence-in-depth CHECK: slot_duration_minutes only meaningful when
  -- granularity is hour / minute. We relax nothing at this level — the
  -- app layer rejects (granularity='day', slot_duration NOT NULL) too.
  CONSTRAINT reservations_slot_duration_for_granularity CHECK (
    slot_duration_minutes IS NULL
    OR granularity IN ('hour', 'minute')
  )
);

-- Per-table indexes for the same hot queries as forms:
--   - paged list filtered by project_id
--   - paged list filtered by active status (public embed endpoint)
--   - slug + token uniqueness already enforced by UNIQUE
CREATE INDEX IF NOT EXISTS idx_reservations_project_id ON reservations(project_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations(status) WHERE status = 'active';

-- Per-table trigger function for updated_at.
CREATE OR REPLACE FUNCTION reservations_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservations_touch_updated_at ON reservations;
CREATE TRIGGER trg_reservations_touch_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Reservation bookings table — one row per submitted reservation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservation_bookings (
  id              BIGSERIAL PRIMARY KEY,
  reservation_id  BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Metadata capture mirrors form_submissions (pg INET, TEXT-clip in app)
  ip_address      INET,
  user_agent      TEXT,
  referer         TEXT,
  locale          TEXT,
  -- Optional opaque bag, only populated when reservation.extra_fields_enabled
  -- and the visitor supplied it. Same bounded-bag shape as form submissions.
  data            JSONB,
  -- Defence-in-depth; the EXCLUDE constraint is the authoritative check.
  CONSTRAINT reservation_bookings_valid_range CHECK (ends_at > starts_at)
);

-- Indexes
--   - Admin booking list query: list by reservation_id, newest first.
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_reservation_id_booked_at
  ON reservation_bookings (reservation_id, booked_at DESC);

--   - Public availability lookup: filter by reservation_id + range overlap
--     on the EXCLUDE constraint's range column. GiST on the range lets the
--     planner use the constraint index for overlap queries directly.
CREATE INDEX IF NOT EXISTS idx_reservation_bookings_reservation_id_range
  ON reservation_bookings
  USING gist (reservation_id, tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------------
-- The atomicity guarantee — TWO simultaneous POSTs at the SAME slot MUST
-- NOT both succeed. The EXCLUDE constraint with tstzrange + gist fires on
-- INSERT and rejects any overlapping row within the same reservation_id.
-- In the app layer we map 23P01 (exclusion_violation) → 409.
-- ---------------------------------------------------------------------------
ALTER TABLE reservation_bookings
  DROP CONSTRAINT IF EXISTS reservation_bookings_no_overlap;

ALTER TABLE reservation_bookings
  ADD CONSTRAINT reservation_bookings_no_overlap
  EXCLUDE USING gist (
    reservation_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );

-- Down Migration

DROP TRIGGER IF EXISTS trg_reservations_touch_updated_at ON reservations;
DROP FUNCTION IF EXISTS reservations_touch_updated_at();

ALTER TABLE reservation_bookings
  DROP CONSTRAINT IF EXISTS reservation_bookings_no_overlap;

DROP TABLE IF EXISTS reservation_bookings;
DROP TABLE IF EXISTS reservations;

-- Note: btree_gist extension is left in place — other code may rely on it.
