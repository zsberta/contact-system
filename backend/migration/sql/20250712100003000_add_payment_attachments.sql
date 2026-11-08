-- Up Migration

CREATE TABLE IF NOT EXISTS payment_attachments (
  id                BIGSERIAL PRIMARY KEY,
  payment_id        BIGINT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_filename   TEXT NOT NULL UNIQUE,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_attachments_payment_id
  ON payment_attachments (payment_id, uploaded_at DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_payment_attachments_payment_id;
DROP TABLE IF EXISTS payment_attachments;
