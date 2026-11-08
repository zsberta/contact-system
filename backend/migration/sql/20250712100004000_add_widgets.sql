-- Up Migration

DO $$ BEGIN
  CREATE TYPE widget_kind AS ENUM ('form', 'reservation', 'tracking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE widget_status AS ENUM ('active', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS widgets (
  id                   BIGSERIAL PRIMARY KEY,
  project_id           BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind                 widget_kind NOT NULL,
  snippet_id           TEXT NOT NULL UNIQUE,
  consent_required     BOOLEAN NOT NULL DEFAULT false,
  privacy_policy_url   TEXT,
  custom_css           TEXT,
  status               widget_status NOT NULL DEFAULT 'active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widgets_project_id     ON widgets (project_id);
CREATE INDEX IF NOT EXISTS idx_widgets_snippet_id     ON widgets (snippet_id);
CREATE INDEX IF NOT EXISTS idx_widgets_status         ON widgets (status);
CREATE INDEX IF NOT EXISTS idx_widgets_created_at_id  ON widgets (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION widgets_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_widgets_touch_updated_at ON widgets;
CREATE TRIGGER trg_widgets_touch_updated_at
  BEFORE UPDATE ON widgets
  FOR EACH ROW EXECUTE FUNCTION widgets_touch_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS trg_widgets_touch_updated_at ON widgets;
DROP FUNCTION IF EXISTS widgets_touch_updated_at();
DROP TABLE IF EXISTS widgets;
DROP TYPE IF EXISTS widget_status;
DROP TYPE IF EXISTS widget_kind;
