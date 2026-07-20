-- Up Migration
--
-- 0021: FAQ (GYIK) module — structured Q&A content for landing pages.
--
-- FAQ items belong to a project (multi-tenant, same as blog_posts).
-- Each item contains both HU and EN translations in a single row,
-- so the operator creates one item per Q&A pair and the frontend
-- picks the right language client-side.
--
-- The public API returns all published items in a single call, sorted
-- by sort_order. This is intentionally simple — FAQ is low-volume
-- content (<50 items per project) and doesn't need the incremental
-- fetch / per-slug routing that blog uses.

-- ---------------------------------------------------------------------------
-- Recovery block
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS faq_items CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0021: recovery drop of faq_items skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- faq_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faq_items (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question_hu   TEXT NOT NULL,
  answer_hu     TEXT NOT NULL,
  question_en   TEXT NOT NULL DEFAULT '',
  answer_en     TEXT NOT NULL DEFAULT '',
  sort_order    INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INT REFERENCES users(id)
);

-- Index for the admin list view (project + sort_order).
CREATE INDEX IF NOT EXISTS idx_faq_items_project_sort
  ON faq_items (project_id, sort_order);

-- Index for the public read path (project + status + sort_order).
CREATE INDEX IF NOT EXISTS idx_faq_items_public
  ON faq_items (project_id, status, sort_order)
  WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- updated_at trigger (same pattern as blog_posts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION faq_items_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_faq_items_updated_at ON faq_items;
CREATE TRIGGER trg_faq_items_updated_at
  BEFORE UPDATE ON faq_items
  FOR EACH ROW
  EXECUTE FUNCTION faq_items_set_updated_at();
