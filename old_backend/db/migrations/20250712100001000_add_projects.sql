-- Up Migration

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
  CREATE TYPE billing_period AS ENUM ('monthly', 'yearly', 'one_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'under_construction',
    'customer_paid',
    'waiting_for_payment',
    'notified_customer',
    'have_to_notify',
    'paid',
    'cancelled',
    'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS projects (
  id                     BIGSERIAL PRIMARY KEY,
  name                   TEXT NOT NULL,
  domain_address         TEXT,
  price                  NUMERIC(12, 2),
  -- The design spec calls this "NOT NULL" but the cron code path explicitly
  -- skips projects where fordulonap IS NULL, and the UI permits saving a
  -- project without a schedule. Keep it nullable to match the runtime contract.
  fordulonap             TEXT,
  billing_period         billing_period,
  status                 project_status NOT NULL DEFAULT 'under_construction',
  comment                TEXT,
  customer_name          TEXT,
  customer_phone         TEXT,
  customer_email         CITEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_change_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_name_trgm            ON projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_customer_name_trgm   ON projects USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_customer_email_trgm  ON projects USING gin (customer_email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_domain_trgm          ON projects USING gin (domain_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_comment_trgm         ON projects USING gin (comment gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_created_at_id        ON projects (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_projects_status               ON projects (status);

CREATE TABLE IF NOT EXISTS project_attachments (
  id                 BIGSERIAL PRIMARY KEY,
  project_id         BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_filename  TEXT NOT NULL,
  stored_filename    TEXT NOT NULL UNIQUE,
  mime_type          TEXT NOT NULL,
  size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0),
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_attachments_project_id ON project_attachments (project_id, uploaded_at DESC);

CREATE OR REPLACE FUNCTION projects_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_touch_updated_at ON projects;
CREATE TRIGGER trg_projects_touch_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION projects_touch_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_projects_touch_updated_at ON projects;
DROP FUNCTION IF EXISTS projects_touch_updated_at();
DROP TABLE IF EXISTS project_attachments;
DROP TABLE IF EXISTS projects;
DROP TYPE IF EXISTS project_status;
DROP TYPE IF EXISTS billing_period;
