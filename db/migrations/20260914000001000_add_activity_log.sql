-- Up Migration
-- Activity log table (admin audit trail: writes + sends + admin reads)

CREATE TABLE IF NOT EXISTS activity_logs (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('admin','enduser','public','system','service')),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  actor_role    TEXT,
  actor_ip      TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  action        TEXT NOT NULL,
  action_type   TEXT NOT NULL CHECK (action_type IN ('CREATE','READ','UPDATE','DELETE','SEND')),
  entity_type   TEXT,
  entity_id     BIGINT,
  entity_label  TEXT,
  project_id    BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  status_code   INT,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  metadata      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON activity_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_type ON activity_logs(action_type);

-- Down Migration
DROP INDEX IF EXISTS idx_activity_logs_action_type;
DROP INDEX IF EXISTS idx_activity_logs_action;
DROP INDEX IF EXISTS idx_activity_logs_project;
DROP INDEX IF EXISTS idx_activity_logs_entity;
DROP INDEX IF EXISTS idx_activity_logs_actor;
DROP INDEX IF EXISTS idx_activity_logs_created;
DROP TABLE IF EXISTS activity_logs;
