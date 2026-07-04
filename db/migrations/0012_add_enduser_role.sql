-- Up Migration
--
-- 0012: Enduser module — second role on the users table, plus invite and
-- password-reset token tables, plus a many-to-many assignments table.
--
-- Idempotency strategy mirrors 0011: CREATE IF NOT EXISTS everywhere, with
-- a recovery DROP block guarded by DO/EXCEPTION so a clean re-run is safe.
--
-- Schema notes
-- ============
-- * users.role is a TEXT + CHECK instead of a PG ENUM, matching the
--   project_status enum-free convention we use elsewhere
--   (forms.status, project_status, etc.) so the table is editable
--   without an ALTER TYPE migration.
-- * users.must_set_password is the gate that prevents an invited
--   enduser from signing in before they click their invite link. It's
--   TRUE for a freshly-invited enduser, FALSE once /set-password
--   succeeds. Admins are always FALSE.
-- * users.password_hash becomes nullable so the invited enduser can
--   have a row before they have a password. Signin refuses any row
--   with password_hash IS NULL.
-- * invite_tokens.token_hash is sha256(token) — the plaintext is only
--   in the email URL, never returned by the API.
-- * password_reset_tokens has the same shape but a shorter TTL (15 min)
--   and is DELETEd on use (not just marked consumed) so the table
--   doesn't grow forever.
-- * user_project_assignments is a many-to-many between users (endusers)
--   and projects. The same user can be assigned to many projects (one
--   customer with multiple sites) and a project can have many
--   endusers (one site with several stakeholders). The composite PK
--   enforces uniqueness. ON DELETE CASCADE both ways so deleting an
--   enduser or a project auto-cleans the assignment rows.

-- ---------------------------------------------------------------------------
-- Recovery block — drop orphaned enduser artifacts from partial runs.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS user_project_assignments CASCADE;
  DROP TABLE IF EXISTS password_reset_tokens CASCADE;
  DROP TABLE IF EXISTS invite_tokens CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0012: recovery drop of enduser tables skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 1) users: role, must_set_password, password_hash nullable
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE users
    ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
      CHECK (role IN ('admin', 'enduser'));
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users
    ADD COLUMN must_set_password BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2) invite_tokens
--    One row per (active) invite. A user can have multiple rows in flight
--    (re-issued invites invalidate older rows via the unique-active index
--    below), but only the latest one is usable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_user_id ON invite_tokens(user_id);
-- Hot lookup: "is there an unconsumed, unexpired invite for this user?"
CREATE INDEX IF NOT EXISTS idx_invite_tokens_active
  ON invite_tokens(user_id) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) password_reset_tokens
--    Same shape as invite_tokens, shorter TTL, row is hard-deleted on use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens(user_id);

-- ---------------------------------------------------------------------------
-- 4) user_project_assignments — many-to-many
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_project_assignments (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

-- Hot lookup: "which projects does this user have?" — used to scope
-- the enduser's read queries.
CREATE INDEX IF NOT EXISTS idx_user_project_assignments_user_id
  ON user_project_assignments(user_id);

-- Reverse lookup (e.g. "which endusers are assigned to this project?")
CREATE INDEX IF NOT EXISTS idx_user_project_assignments_project_id
  ON user_project_assignments(project_id);

-- Down Migration

DROP TABLE IF EXISTS user_project_assignments;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS invite_tokens;

-- Re-tighten password_hash to NOT NULL. This will fail if any user has a
-- NULL password_hash, which is fine — that's exactly what we want to be
-- loud about. Admins can clean up orphans by re-inviting or deleting.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE password_hash IS NULL) THEN
    RAISE EXCEPTION '0012 down: cannot restore NOT NULL on password_hash; users with NULL password_hash exist';
  END IF;
  ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS must_set_password;
ALTER TABLE users DROP COLUMN IF EXISTS role;
