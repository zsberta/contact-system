-- Up Migration
--
-- 0010: Forms module replaces Widgets module (locked-in ADR 0009).
--
-- ============================================================================
-- IDEMPOTENCY STRATEGY
-- ============================================================================
-- This migration is designed to be safely re-runnable after a killed or
-- partial application. Postgres error 42P07 ("relation already exists")
-- is the failure mode we are defending against: if the migration was
-- interrupted mid-run, the new forms / form_submissions tables may have
-- been partially created without the pgmigrations row being recorded, and
-- a plain CREATE TABLE on retry will fail.
--
-- We use a two-tier safety net:
--
--   (a) RECOVERY DROP BLOCK — at the top of the file, a DO block
--       unconditionally DROP TABLE IF EXISTS's the NEW tables
--       (forms / form_submissions) before any CREATE. This is the
--       recovery path for a partial-application state. We do NOT check
--       pgmigrations here because if the code is executing this
--       migration, the row has not been recorded yet (it is recorded
--       only on successful commit). The block is wrapped in
--       EXCEPTION WHEN OTHERS so any unexpected failure here does not
--       block the rest of the migration.
--
--   (b) IF NOT EXISTS GUARDS — every CREATE in this file uses
--       `IF NOT EXISTS`, so a re-run on a clean database (or after the
--       recovery block has dropped the partial state) will not raise
--       42P07. CREATE INDEX uses IF NOT EXISTS (non-CONCURRENTLY, so it
--       is safe inside the transaction). CREATE OR REPLACE FUNCTION is
--       used for the trigger function, and DROP TRIGGER IF EXISTS
--       guards the trigger re-creation.
--
-- Expected order: recovery drops first, then old-widget drops, then
-- creates. The widget ENUM drops sit between the two drop blocks.
--
-- This migration is intentionally DESTRUCTIVE on the widgets module.
-- Per ADR 0009, widgets is being retired in favour of a leaner forms
-- module; there is no preservation path. Rolling back returns the
-- schema to a state where neither module exists — the predecessor
-- schema (pre-0010 with widgets / widget_form_submissions) is
-- permanently removed and can only be recovered from backup.
--
-- ============================================================================
-- SCHEMA NOTES
-- ============================================================================
-- Drops the old widgets / widget_form_submissions tables and ENUM types,
-- creates the leaner forms / form_submissions tables. Forms keep
-- `slug` (human-readable kebab-case label) and add `secret_token`
-- (22-char base64url random token used in API URLs — auth on this one,
-- not slug).
--
-- Removed vs. widgets:
--   - widget_kind / widget_status ENUMs → status is now a TEXT CHECK
--     (no need for the type extensibility ceremony)
--   - name_i18n / fields JSONB columns → BE knows nothing about field
--     names. Validated `data: JSONB` only.
--   - consent_required / privacy_policy_url / custom_css / snippet_id →
--     GDPR consent is owned by the FE entirely; no custom CSS or iframe
--     injection in the new minimal form design.
-- Kept:
--   - allowed_origins (text[]) — same per-form host-allowlist semantics
--     as widget allowed_domains
--   - project_id FK — forms still belong to a project
--   - touch_updated_at() function pattern
--
-- ============================================================================
-- TRANSACTION NOTE
-- ============================================================================
-- node-pg-migrate wraps each migration file in a single transaction by
-- default. CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) is safe
-- inside a transaction; we deliberately do NOT use CONCURRENTLY here
-- so the whole migration is atomic.

-- ---------------------------------------------------------------------------
-- Recovery block: drop orphaned forms / form_submissions from partial runs.
-- This runs BEFORE the old-widget drops so that on a partial state the
-- recovery is clean. The CASCADE on each drop also removes any partial
-- triggers / indexes / FK constraints that might have been created before
-- the previous run was killed.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS form_submissions CASCADE;
  DROP TABLE IF EXISTS forms CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0010: recovery drop of forms/form_submissions skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  -- Drop the OLD tables first. CASCADE removes the FK from
  -- widget_form_submissions.widget_id → widgets.id, so we can drop in
  -- either order, but explicit ordering keeps the down-migration
  -- trivially safe.
  DROP TABLE IF EXISTS widget_form_submissions CASCADE;
  DROP TABLE IF EXISTS widgets CASCADE;
EXCEPTION WHEN OTHERS THEN
  -- If the old tables don't exist (fresh installs), swallow the error
  -- so the migration is idempotent on greenfield databases.
  RAISE NOTICE '0010: widget tables did not exist (fresh install): %', SQLERRM;
END $$;

-- Old ENUM types — drop if they exist. The DO/EXCEPTION wrapper keeps
-- this idempotent for databases that never had widgets.
DO $$ BEGIN
  DROP TYPE IF EXISTS widget_kind;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0010: widget_kind did not exist: %', SQLERRM;
END $$;
DO $$ BEGIN
  DROP TYPE IF EXISTS widget_status;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0010: widget_status did not exist: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Forms table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forms (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- `slug` is a human-readable kebab-case label. NOT used for auth;
  -- humans use it to identify a form by its mnemonic name.
  slug            TEXT NOT NULL UNIQUE CHECK (
                    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                    AND length(slug) BETWEEN 1 AND 50
                  ),
  -- `secret_token` is the credential used in API URLs (forms/{token}/submissions).
  -- 22 chars is the base64url encoding of 16 random bytes — generates the
  -- ~128 bits of entropy that the BE needs via crypto.randomBytes(16).
  secret_token    TEXT NOT NULL UNIQUE CHECK (length(secret_token) = 22),
  -- Per-form host-allowlist (text[]). Empty = no restriction.
  -- Same semantics as the old widgets.allowed_domains, just renamed.
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  -- `status` is a TEXT with a CHECK constraint, not a PG ENUM — the
  -- orchestrator decision preferred adding new statuses (e.g. "archived")
  -- via code change, not migration.
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Covering index for the project-flavoured list query
-- (api/forms?projectId=N).
CREATE INDEX IF NOT EXISTS idx_forms_project_id ON forms(project_id);
-- Partial index for active forms only — accelerates the public embed
-- endpoint's lookup (which always filters status='active').
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status) WHERE status = 'active';

-- Per-table trigger function for updated_at (mirrors the pattern used by
-- projects / payments / widgets — one trigger function per table so
-- each can be DROP'd cleanly on rollback).
CREATE OR REPLACE FUNCTION forms_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forms_touch_updated_at ON forms;
CREATE TRIGGER trg_forms_touch_updated_at
  BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION forms_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Form submissions table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_submissions (
  id           BIGSERIAL PRIMARY KEY,
  form_id      BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- INET captures both IPv4 and IPv6; pg driver returns strings.
  ip_address   INET,
  -- Clip these at the BE side too; columns just store whatever fits.
  user_agent   TEXT,
  referer      TEXT,
  -- The validated `data` payload — opaque, validated only as a
  -- bounded bag (plain object, depth ≤ 5, ≤ 50 keys/level,
  -- ≤ 50 KB JSON-encoded). Fields schema is BE-agnostic.
  data         JSONB NOT NULL,
  locale       TEXT
);

-- Covering index for the admin submissions list query
-- (api/forms/:id/submissions — newest first).
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id_submitted_at
  ON form_submissions (form_id, submitted_at DESC);

-- Down Migration

DROP TRIGGER IF EXISTS trg_forms_touch_updated_at ON forms;
DROP FUNCTION IF EXISTS forms_touch_updated_at();
DROP TABLE IF EXISTS form_submissions;
DROP TABLE IF EXISTS forms;

-- Note: the down-migration does NOT recreate widgets / widget_form_submissions
-- because they were dropped intentionally as part of this migration. Rolling
-- back returns the schema to a state where neither module exists — the
-- predecessor schema is the pre-0010 state with the old `widgets`
-- /`widget_form_submissions` tables, which are now permanently removed.
-- A recovery from the old schema requires restoring from backup, not from
-- the down-migration.
