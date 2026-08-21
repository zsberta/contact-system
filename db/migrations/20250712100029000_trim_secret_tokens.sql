-- Migration 0030: Trim invisible characters from secret_token columns.
--
-- Root cause: a production form had an invisible character appended to its
-- secret_token that broke exact string equality (`WHERE token = $1`) while
-- LIKE prefix matching and SELECT-expression equality still worked.  The
-- pg driver sends the parameter as UTF-8 text; the stored value contained
-- a non-breaking space (U+00A0) or similar zero-width character that
-- PostgreSQL's C-locale collation treated as different during B-tree
-- index lookups.
--
-- This migration trims whitespace from every secret_token across all four
-- config tables.  The trim is idempotent — clean tokens are unchanged.
-- All embed routers (form-embed, reservation-embed, analytics-embed,
-- ai-assistant-embed) now use `trim(secret_token)` in their WHERE clauses
-- as a defense-in-depth measure.

-- Forms
UPDATE forms SET secret_token = trim(secret_token)
  WHERE secret_token != trim(secret_token);

-- Reservations
UPDATE reservations SET secret_token = trim(secret_token)
  WHERE secret_token != trim(secret_token);

-- Analytics configs
UPDATE analytics_configs SET secret_token = trim(secret_token)
  WHERE secret_token != trim(secret_token);

-- AI assistant configs
UPDATE ai_assistant_configs SET secret_token = trim(secret_token)
  WHERE secret_token != trim(secret_token);
