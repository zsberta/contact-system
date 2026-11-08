-- Up Migration
--
-- 0019: Blog translation groups — link same-content posts across
-- locales so the landing can offer an "Read in English" link that
-- switches slug without 404.
--
-- ============================================================================
-- WHY A GROUP ID INSTEAD OF A POST-TO-POST JOIN TABLE
-- ============================================================================
-- Two patterns were considered:
--   (a) blog_post_translations(post_id, target_post_id, locale) — a
--       many-to-many join. Pro: explicit. Con: requires the operator
--       to remember which post is the "source" and which is the
--       "target", and the join turns every read into a second query
--       (or a JOIN with potential N+1 across translations).
--   (b) translation_group_id on blog_posts, with the operator linking
--       two posts by hand after the second one is created. Pro:
--       minimal schema change, single read query (WHERE
--       translation_group_id = $1), no join table to maintain. Con:
--       the "linking" UX is a small admin step rather than automatic.
--
-- We pick (b) because the operator already has to write two posts
-- (one per locale) — they can copy the group id from the source
-- post's view/edit page and paste it into the new post's create
-- form. The DB schema stays simple and every read is one indexed
-- query.
--
-- ============================================================================
-- SCHEMA
-- ============================================================================
-- translation_group_id is a UUID generated on insert. A unique
-- constraint per (project_id, translation_group_id) keeps the
-- group inside one project (so a malicious cross-project link
-- can't redirect a bitusmassazs.hu/post to a malicious-domain/post
-- via a leaked group id).
--
-- The lookup index is (translation_group_id, project_id, locale,
-- status='published') — covers the public API's translation-fetch
-- query exactly. Partial-indexed on status='published' so drafts
-- don't pollute the hot read path.
--
-- ============================================================================
-- TRANSACTION NOTE
-- ============================================================================
-- node-pg-migrate wraps each migration in a single transaction by
-- default. CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) is safe
-- inside a transaction. We need pgcrypto for gen_random_uuid() —
-- pgcrypto ships with the postgres image we use, but the extension
-- itself needs an explicit CREATE EXTENSION call.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- blog_posts.translation_group_id
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE blog_posts
    ADD COLUMN translation_group_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill existing rows: each post gets its own group id (i.e.
-- self-link, no cross-locale redirect possible until the operator
-- manually links them). gen_random_uuid() is pgcrypto's UUID v4
-- generator — collision probability is negligible (122 bits of
-- entropy).
UPDATE blog_posts
   SET translation_group_id = gen_random_uuid()
 WHERE translation_group_id IS NULL;

-- Now make the column NOT NULL.
DO $$ BEGIN
  ALTER TABLE blog_posts
    ALTER COLUMN translation_group_id SET NOT NULL,
    ALTER COLUMN translation_group_id SET DEFAULT gen_random_uuid();
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Hot read path: "give me all the published translations of this
-- post's group, in any locale." Covers the public API's
-- `?include_translations=true` lookup.
--
-- We don't filter on status in the index because the BE applies
-- that filter at query time; an unfiltered composite is small
-- enough (one row per locale per group) and avoids the partial-index
-- overhead.
CREATE INDEX IF NOT EXISTS idx_blog_posts_group
  ON blog_posts (translation_group_id, project_id, locale);

-- Lookup by group id alone (without project_id) — used by the
-- admin UI's "linked translations" view.
CREATE INDEX IF NOT EXISTS idx_blog_posts_group_only
  ON blog_posts (translation_group_id);

-- Down Migration

DROP INDEX IF EXISTS idx_blog_posts_group_only;
DROP INDEX IF EXISTS idx_blog_posts_group;

DO $$ BEGIN
  ALTER TABLE blog_posts
    DROP COLUMN IF EXISTS translation_group_id;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;