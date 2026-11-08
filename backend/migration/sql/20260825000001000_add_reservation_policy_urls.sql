-- Up Migration
-- Add optional privacy policy and cookie policy URL fields to reservations.
-- These are shown as consent checkbox links on the public embed widget.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS privacy_policy_url TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cookie_policy_url TEXT;

-- Down Migration
ALTER TABLE reservations DROP COLUMN IF EXISTS privacy_policy_url;
ALTER TABLE reservations DROP COLUMN IF EXISTS cookie_policy_url;
