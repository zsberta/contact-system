-- Migration 0020: Add brand_color to projects
-- Allows per-project brand color theming for blog posts and landing pages.
-- Stored as HSL values (e.g. "212 73% 18%") to match the CSS convention.

-- Up Migration

DO $$ BEGIN
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS brand_color VARCHAR(50);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Down Migration

DO $$ BEGIN
  ALTER TABLE projects
    DROP COLUMN IF EXISTS brand_color;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
