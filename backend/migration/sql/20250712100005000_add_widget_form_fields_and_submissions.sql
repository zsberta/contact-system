-- Up Migration

ALTER TABLE widgets
  ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS widget_form_submissions (
  id              BIGSERIAL PRIMARY KEY,
  widget_id       BIGINT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address      INET,
  user_agent      TEXT,
  referer         TEXT,
  data            JSONB NOT NULL,
  locale          TEXT,
  consent_granted BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_form_submissions_widget_submitted
  ON widget_form_submissions (widget_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_widget_form_submissions_widget_created
  ON widget_form_submissions (widget_id, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_widget_form_submissions_widget_created;
DROP INDEX IF EXISTS idx_widget_form_submissions_widget_submitted;
DROP TABLE IF EXISTS widget_form_submissions;
ALTER TABLE widgets DROP COLUMN IF EXISTS fields;
