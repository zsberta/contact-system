-- Up Migration
-- Seen-state for the gateway payment watcher (lib/gateway-payments.js).
-- One row per gateway transaction; the poller notifies admins only when a
-- transaction is first observed in a terminal state (paid/failed/refunded)
-- or transitions into one. Pending rows are tracked silently.

CREATE TABLE IF NOT EXISTS gateway_payment_seen (
  transaction_id TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  notified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS gateway_payment_seen;
