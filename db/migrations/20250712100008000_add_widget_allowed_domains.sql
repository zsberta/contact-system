-- Up Migration

-- Per-widget host-allowlist (added 2026-06-24, security feature).
-- Empty array = no restriction (backwards compatible with widgets created
-- before this migration). Non-empty array = the public submission endpoint
-- rejects requests whose `parentOrigin` is not in this list. The loader
-- also pre-flights this allowlist before mounting the iframe. See
-- Projects/contact-system/02-modules/widgets/security.md for the threat
-- model and defence-in-depth rationale.
ALTER TABLE widgets
  ADD COLUMN IF NOT EXISTS allowed_domains TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

-- Down Migration
ALTER TABLE widgets DROP COLUMN IF EXISTS allowed_domains;