-- Up Migration
-- Error rows in the admin activity log: allow ERROR action_type.

ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_action_type_check;
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_action_type_check
  CHECK (action_type IN ('CREATE','READ','UPDATE','DELETE','SEND','ERROR'));

CREATE INDEX IF NOT EXISTS idx_activity_logs_errors ON activity_logs(action_type, created_at DESC, id DESC) WHERE action_type = 'ERROR';

-- Down Migration
DROP INDEX IF EXISTS idx_activity_logs_errors;
ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_action_type_check;
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_action_type_check
  CHECK (action_type IN ('CREATE','READ','UPDATE','DELETE','SEND'));
