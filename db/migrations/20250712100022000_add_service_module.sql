-- Up Migration
--
-- 0023: Service (Szolgaltatasok) module — structured service content for landing pages.
--
-- Service items belong to a project (multi-tenant, same as blog_posts).
-- Each item contains both HU and EN translations in a single row,
-- so the operator creates one item per service and the frontend
-- picks the right language client-side.
--
-- The public API returns all published items in a single call, sorted
-- by sort_order. This is intentionally simple — service is low-volume
-- content (<50 items per project) and doesn't need the incremental
-- fetch / per-slug routing that blog uses.

-- ---------------------------------------------------------------------------
-- Recovery block
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS service_items CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0023: recovery drop of service_items skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- service_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_items (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title_hu        TEXT NOT NULL,
  title_en        TEXT NOT NULL DEFAULT '',
  description_hu  TEXT NOT NULL DEFAULT '',
  description_en  TEXT NOT NULL DEFAULT '',
  price_hu        TEXT NOT NULL DEFAULT '',
  price_en        TEXT NOT NULL DEFAULT '',
  sort_order      INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT REFERENCES users(id)
);

-- Index for the admin list view (project + sort_order).
CREATE INDEX IF NOT EXISTS idx_service_items_project_sort
  ON service_items (project_id, sort_order);

-- Index for the public read path (project + status + sort_order).
CREATE INDEX IF NOT EXISTS idx_service_items_public
  ON service_items (project_id, status, sort_order)
  WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- updated_at trigger (same pattern as blog_posts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION service_items_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_items_updated_at ON service_items;
CREATE TRIGGER trg_service_items_updated_at
  BEFORE UPDATE ON service_items
  FOR EACH ROW
  EXECUTE FUNCTION service_items_set_updated_at();
