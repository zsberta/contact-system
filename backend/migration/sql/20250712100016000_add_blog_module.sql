-- Up Migration
--
-- 0017: Blog module — turn the CRM into a headless CMS for landing pages.
--
-- ============================================================================
-- SCOPE
-- ============================================================================
-- This migration introduces the Blog module: a CMS-like authoring surface for
-- landing pages (React SPAs) that consume blog content from this CRM via a
-- public read API. The landing pages do their own prerender (post-build static
-- HTML generation) against the public endpoints added in routes/blog-public.js.
--
-- Multi-tenant: every blog_post belongs to a project, so the same CRM can
-- power N landing pages. The Host header (or X-Forwarded-Host) is used by the
-- public API to resolve which project's posts to return.
--
-- ============================================================================
-- DESIGN NOTES
-- ============================================================================
--   - `projects.landing_*` columns are the per-project landing configuration.
--     A project can opt out entirely (landing_enabled=false) without setting
--     any of the path/command/env fields.
--   - `projects.domain_address` becomes UNIQUE here so the public API can do
--     a single index lookup per Host. If the existing data has duplicates
--     (it shouldn't — the address is documented as the project's canonical
--     domain), the migration will fail and an operator must clean up first.
--   - `blog_posts.slug` is kebab-case, 1..50 chars, matches forms.slug regex.
--     Uniqueness is per (project_id, slug, locale) — the same slug can exist
--     under different locales on the same project, but two projects can both
--     have /blog/foo without collision.
--   - `blog_posts.body_html` is the rendered/sanitized output (Tiptap editor
--     stores JSON, server sanitizes to HTML on save). Public API returns
--     body_html as-is — sanitization is enforced at write-time, not read.
--     The CMS sanitize helper (lib/sanitize.js) applies DOMPurify before
--     INSERT/UPDATE.
--   - `blog_posts.body_json` is the Tiptap JSON document. Optional because
--     if we ever switch editors we won't have a stale JSON blob sitting in
--     the table. body_html is the canonical source.
--   - `status` is TEXT + CHECK (not PG ENUM) so we can add 'archived' or
--     'scheduled' via code change instead of a migration — same pattern as
--     forms.status.
--   - Partial index on status='published' for the hot read path: the public
--     list API filters on (project_id, locale, status, updated_at DESC)
--     every rebuild, so the index must cover all four.
--
-- ============================================================================
-- IDEMPOTENCY STRATEGY
-- ============================================================================
-- Same two-tier safety net as 0010 (the forms migration this one mirrors):
--   (a) RECOVERY DROP BLOCK at the top — drops blog_posts if a partial run
--       left it behind. Wrapped in EXCEPTION WHEN OTHERS so a missing table
--       is silent.
--   (b) IF NOT EXISTS / IF NOT EXISTS-guarded CREATE / CREATE OR REPLACE
--       FUNCTION — every DDL is re-runnable on a clean DB.
--
-- ============================================================================
-- TRANSACTION NOTE
-- ============================================================================
-- node-pg-migrate wraps each migration in a single transaction by default.
-- CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) is safe inside a
-- transaction. We do NOT use CONCURRENTLY so the whole migration is atomic.

-- ---------------------------------------------------------------------------
-- Recovery block: drop a half-created blog_posts from a previous interrupted
-- migration run. The pgmigrations row is only written on successful commit,
-- so if we are executing this file, no row exists yet.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS blog_posts CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0017: recovery drop of blog_posts skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- projects: landing configuration + UNIQUE(domain_address)
-- ---------------------------------------------------------------------------
-- A project is the unit of tenancy. landing_repo_dir is the host path to
-- the landing's source tree (e.g. /home/zsolt/www/zsoltberta.hu). The
-- landing's static dist lives next to it. The host-cron watchdog (see
-- VPS setup notes) watches a flag directory mounted into the CRM
-- container and triggers `npm run build:content-only` there, which in
-- turn calls the public read API to fetch this project's posts.

DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_repo_dir TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_build_command TEXT NOT NULL DEFAULT 'npm run build:content-only';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- landing_build_env is a JSONB of KEY=VALUE env vars to pass to the build.
-- Stored as object (not array) so the build wrapper can do Object.entries().
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_build_env JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- landing_dist_path is informational — where the landing's built dist
-- lives on disk. nginx in production reads this via its mount config; we
-- don't bind it from inside this CRM.
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_dist_path TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_enabled BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Last-build observability — the landing's watcher script updates these
-- via a dedicated internal endpoint (mounted under /api/internal/landing-build-status,
-- gated by a shared secret), not via the public CRUD API.
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_last_build_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_last_build_status TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN landing_last_build_log TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- UNIQUE(domain_address): public API resolves Host -> project with a
-- single index lookup. Guarded by IF NOT EXISTS so re-runs on a DB that
-- already has the constraint are silent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_projects_domain_address_unique'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_domain_address_unique UNIQUE (domain_address);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- blog_posts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blog_posts (
  id                 BIGSERIAL PRIMARY KEY,
  project_id         BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- kebab-case, immutable-ish (changing slug breaks inbound links; we
  -- intentionally don't auto-redirect because the CMS exposes the old
  -- slug's last published_at so callers can handle 404s explicitly).
  -- Regex matches forms.slug so the validation helper is shared.
  slug               TEXT NOT NULL CHECK (
                       slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                       AND length(slug) BETWEEN 1 AND 50
                     ),
  -- Locale: 'hu' | 'en' | ... Default 'hu' matches the CRM's primary locale.
  -- Stored as TEXT (not ENUM) so new locales don't need a migration.
  locale             TEXT NOT NULL DEFAULT 'hu' CHECK (
                       locale ~ '^[a-z]{2}(-[A-Z]{2})?$'
                       AND length(locale) BETWEEN 2 AND 5
                     ),

  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- excerpt is optional but recommended for list-page cards and OG description
  excerpt            TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  cover_image_url    TEXT CHECK (
                       cover_image_url IS NULL OR length(cover_image_url) <= 2000
                     ),

  -- body_html is the rendered/sanitized HTML (see lib/sanitize.js). It's
  -- the canonical surface consumed by the public API.
  body_html          TEXT NOT NULL,
  -- body_json stores the Tiptap editor document. NULL is allowed so we can
  -- retire the JSON without a destructive migration. body_html stays the
  -- canonical read surface.
  body_json          JSONB,

  -- Status: draft (visible only in CRM), published (visible publicly),
  -- archived (soft-deleted — dist file is removed by the landing rebuild).
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (
                       status IN ('draft', 'published', 'archived')
                     ),

  -- SEO metadata. seo_title overrides <title>; seo_description overrides
  -- <meta name="description">. Both fall back to title / excerpt if unset.
  seo_title          TEXT CHECK (seo_title IS NULL OR length(seo_title) <= 70),
  seo_description    TEXT CHECK (seo_description IS NULL OR length(seo_description) <= 200),
  -- seo_keywords is a TEXT[] for flexibility (no per-keyword length cap —
  -- the public API consumer / prerender enforces that if needed).
  seo_keywords       TEXT[] NOT NULL DEFAULT '{}',
  og_image_url       TEXT CHECK (og_image_url IS NULL OR length(og_image_url) <= 2000),
  -- canonical_url lets the operator override the auto-derived
  -- https://<domain>/blog/<slug> for cross-domain syndication.
  canonical_url      TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2000),

  -- published_at is set on first transition to 'published' and not
  -- updated on subsequent edits (so the article's "publication date" is
  -- stable). The landing rebuild uses this for sitemap lastmod ordering.
  published_at       TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,

  -- Per-project, per-locale slug uniqueness. Two different projects can
  -- both have /blog/foo, and the same project can have /blog/foo in 'hu'
  -- and /blog/foo in 'en' — but not two 'hu' /blog/foo on the same project.
  CONSTRAINT blog_posts_project_slug_locale_unique UNIQUE (project_id, slug, locale)
);

-- The hot read path: "give me all published posts for this project + locale,
-- newest updated first." Covers the public API list query and the landing's
-- prerender iteration. Partial index on status='published' keeps it small
-- even when most rows are drafts.
--
-- IMPORTANT: includes updated_at DESC in the column list so ORDER BY
-- updated_at DESC LIMIT N can use index-only scan, avoiding a sort step
-- at scale (millions of posts).
CREATE INDEX IF NOT EXISTS idx_blog_posts_project_locale_status_updated
  ON blog_posts (project_id, locale, updated_at DESC)
  WHERE status = 'published';

-- For the admin list view (all statuses, scoped to project + role).
CREATE INDEX IF NOT EXISTS idx_blog_posts_project_status
  ON blog_posts (project_id, status);

-- For slug uniqueness checks (admin CRUD slug-availability check).
-- Already enforced by the UNIQUE constraint but a separate index lets
-- the check fire as a fast index probe instead of a unique-violation
-- roundtrip.
CREATE INDEX IF NOT EXISTS idx_blog_posts_project_slug
  ON blog_posts (project_id, slug);

-- ---------------------------------------------------------------------------
-- Touch trigger — keep updated_at fresh on every UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION blog_posts_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blog_posts_touch_updated_at ON blog_posts;
CREATE TRIGGER trg_blog_posts_touch_updated_at
  BEFORE UPDATE ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION blog_posts_touch_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_blog_posts_touch_updated_at ON blog_posts;
DROP FUNCTION IF EXISTS blog_posts_touch_updated_at();
DROP TABLE IF EXISTS blog_posts;

-- projects.* columns are NOT dropped on down-migration because the
-- landing_* fields are project-level config and a forward/backward migration
-- pair should leave the projects table's column set unchanged. The next
-- migration that adds landing features can consume them.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_domain_address_unique;
-- landing_* columns intentionally kept on down to preserve tenant config.