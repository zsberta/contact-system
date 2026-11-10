-- Up Migration
-- Multi-account push: one browser endpoint must be able to serve several
-- user accounts on the same browser profile.
--
-- Before: push_subscriptions.endpoint was UNIQUE, so subscribing as account B
-- on the same browser silently STOLE the endpoint from account A
-- (ON CONFLICT (endpoint) DO UPDATE SET user_id = ...). The victim account
-- stopped receiving pushes until the user manually disabled + re-enabled —
-- which then stole the endpoint back from the other account. Unwinnable.
--
-- After: uniqueness is (user_id, endpoint). The same browser endpoint can be
-- mapped to every account that enabled push on it, and sendPushToUser(userId)
-- fans out per user, so each account keeps working without resubscribing.

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;

-- Guarded (DO block): re-runs on a DB that already has the new constraint
-- are silent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_push_subscriptions_user_endpoint'
  ) THEN
    ALTER TABLE push_subscriptions
      ADD CONSTRAINT uq_push_subscriptions_user_endpoint UNIQUE (user_id, endpoint);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
  ON push_subscriptions (endpoint);

-- Down Migration
-- Restores single-owner endpoints. Fails if the same endpoint is mapped to
-- more than one user — delete the surplus rows manually first, keeping the
-- row of the account that should keep receiving push on that browser.
DROP INDEX IF EXISTS idx_push_subscriptions_endpoint;

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS uq_push_subscriptions_user_endpoint;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
