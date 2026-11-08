-- Up Migration
-- Link a local project to its nexus-gateway merchant (billing onboarding).
-- Null = not onboarded for gateway billing.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS gateway_merchant_id UUID NULL;

-- Down Migration
ALTER TABLE projects DROP COLUMN IF EXISTS gateway_merchant_id;
