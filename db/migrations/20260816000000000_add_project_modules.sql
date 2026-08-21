-- Up Migration
--
-- 0032: Project-Module Registry
--
-- Adds a canonical `project_modules` registry that enforces one logical
-- module instance per supported module kind per project. Every source
-- config table (forms, reservations, analytics_configs, ai_assistant_configs)
-- and every content table (blog_posts, faq_items, service_items) receives
-- a `module_id` FK pointing to its owning registry row.
--
-- Module kinds: form, reservation, blog, faq, service, analytics, ai-assistant
--
-- Cardinality rules enforced here:
--   - project_modules: UNIQUE(project_id, module_type) — at most one per kind
--   - forms, reservations, analytics_configs, ai_assistant_configs: UNIQUE(module_id) — one source per registry row
--   - blog_posts, faq_items, service_items: non-unique module_id — many content children per registry row
--
-- Duplicate preflight: the migration ABORTS with RAISE EXCEPTION if
-- any project has >1 forms or >1 reservations rows. Existing data is
-- never silently deleted or merged.
--
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Recovery block — clean partial runs
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE IF EXISTS service_items DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS faq_items DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS blog_posts DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS ai_assistant_configs DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS analytics_configs DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS reservations DROP COLUMN IF EXISTS module_id;
  ALTER TABLE IF EXISTS forms DROP COLUMN IF EXISTS module_id;
  DROP TABLE IF EXISTS project_modules CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0032: recovery drop of project_modules skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Create the project_modules registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_modules (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_type   TEXT NOT NULL CHECK (module_type IN (
    'form', 'reservation', 'blog', 'faq', 'service', 'analytics', 'ai-assistant'
  )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, module_type)
);

CREATE INDEX IF NOT EXISTS idx_project_modules_project_id ON project_modules(project_id);

-- ---------------------------------------------------------------------------
-- 2. Duplicate preflight — ABORT if any source table has >1 row per project
--    One module per project per kind is the cardinality rule.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT 'forms' AS tbl, project_id, COUNT(*) AS cnt FROM forms GROUP BY project_id HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'reservations', project_id, COUNT(*) FROM reservations GROUP BY project_id HAVING COUNT(*) > 1
  LOOP
    RAISE EXCEPTION '0032 DUPLICATE %: project_id=% has % rows. Resolve duplicates before migrating.', dup.tbl, dup.project_id, dup.cnt;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Add module_id to source config tables (nullable initially for backfill)
-- ---------------------------------------------------------------------------
ALTER TABLE forms ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;
ALTER TABLE analytics_configs ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;
ALTER TABLE ai_assistant_configs ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;

-- Add module_id to content tables (nullable initially)
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;
ALTER TABLE faq_items ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;
ALTER TABLE service_items ADD COLUMN IF NOT EXISTS module_id BIGINT REFERENCES project_modules(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Backfill registry rows for existing modules
--    Each project gets at most one registry row per kind. Content tables
--    may have many rows per project — they all link to the same registry row.
-- ---------------------------------------------------------------------------

-- 4a. Forms: one registry row per project, link each form
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT f.project_id, 'form'
FROM forms f
WHERE f.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE forms f
SET module_id = pm.id
FROM project_modules pm
WHERE f.project_id = pm.project_id
  AND pm.module_type = 'form'
  AND f.module_id IS NULL;

-- 4b. Reservations: one registry row per project, link each reservation
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT r.project_id, 'reservation'
FROM reservations r
WHERE r.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE reservations r
SET module_id = pm.id
FROM project_modules pm
WHERE r.project_id = pm.project_id
  AND pm.module_type = 'reservation'
  AND r.module_id IS NULL;

-- 4c. Analytics: one registry row per project (UNIQUE(project_id) already enforced)
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT ac.project_id, 'analytics'
FROM analytics_configs ac
WHERE ac.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE analytics_configs ac
SET module_id = pm.id
FROM project_modules pm
WHERE ac.project_id = pm.project_id
  AND pm.module_type = 'analytics'
  AND ac.module_id IS NULL;

-- 4d. AI Assistant: one registry row per project (UNIQUE(project_id) already enforced)
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT ai.project_id, 'ai-assistant'
FROM ai_assistant_configs ai
WHERE ai.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE ai_assistant_configs ai
SET module_id = pm.id
FROM project_modules pm
WHERE ai.project_id = pm.project_id
  AND pm.module_type = 'ai-assistant'
  AND ai.module_id IS NULL;

-- 4e. Blog: one registry row per project (multiple posts per project)
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT bp.project_id, 'blog'
FROM blog_posts bp
WHERE bp.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE blog_posts bp
SET module_id = pm.id
FROM project_modules pm
WHERE bp.project_id = pm.project_id
  AND pm.module_type = 'blog'
  AND bp.module_id IS NULL;

-- 4f. FAQ: one registry row per project (multiple items per project)
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT fi.project_id, 'faq'
FROM faq_items fi
WHERE fi.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE faq_items fi
SET module_id = pm.id
FROM project_modules pm
WHERE fi.project_id = pm.project_id
  AND pm.module_type = 'faq'
  AND fi.module_id IS NULL;

-- 4g. Service: one registry row per project (multiple items per project)
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT si.project_id, 'service'
FROM service_items si
WHERE si.module_id IS NULL
ON CONFLICT (project_id, module_type) DO NOTHING;

UPDATE service_items si
SET module_id = pm.id
FROM project_modules pm
WHERE si.project_id = pm.project_id
  AND pm.module_type = 'service'
  AND si.module_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Enforce NOT NULL after backfill (all rows now have module_id)
-- ---------------------------------------------------------------------------
ALTER TABLE forms ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE reservations ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE analytics_configs ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE ai_assistant_configs ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE blog_posts ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE faq_items ALTER COLUMN module_id SET NOT NULL;
ALTER TABLE service_items ALTER COLUMN module_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Enforce one-source-per-registry-row for config tables
--    (content tables keep non-unique module_id — many children per module)
-- ---------------------------------------------------------------------------
ALTER TABLE forms ADD CONSTRAINT uq_forms_module_id UNIQUE (module_id);
ALTER TABLE reservations ADD CONSTRAINT uq_reservations_module_id UNIQUE (module_id);
ALTER TABLE analytics_configs ADD CONSTRAINT uq_analytics_configs_module_id UNIQUE (module_id);
ALTER TABLE ai_assistant_configs ADD CONSTRAINT uq_ai_assistant_configs_module_id UNIQUE (module_id);

-- ---------------------------------------------------------------------------
-- 7. Indexes for module_id lookups on content tables (hot query: list by module)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_blog_posts_module_id ON blog_posts(module_id);
CREATE INDEX IF NOT EXISTS idx_faq_items_module_id ON faq_items(module_id);
CREATE INDEX IF NOT EXISTS idx_service_items_module_id ON service_items(module_id);
CREATE INDEX IF NOT EXISTS idx_forms_module_id ON forms(module_id);
CREATE INDEX IF NOT EXISTS idx_reservations_module_id ON reservations(module_id);
CREATE INDEX IF NOT EXISTS idx_analytics_configs_module_id ON analytics_configs(module_id);
CREATE INDEX IF NOT EXISTS idx_ai_assistant_configs_module_id ON ai_assistant_configs(module_id);

-- Down Migration

-- Remove unique constraints on source tables
ALTER TABLE forms DROP CONSTRAINT IF EXISTS uq_forms_module_id;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS uq_reservations_module_id;
ALTER TABLE analytics_configs DROP CONSTRAINT IF EXISTS uq_analytics_configs_module_id;
ALTER TABLE ai_assistant_configs DROP CONSTRAINT IF EXISTS uq_ai_assistant_configs_module_id;

-- Drop indexes
DROP INDEX IF EXISTS idx_blog_posts_module_id;
DROP INDEX IF EXISTS idx_faq_items_module_id;
DROP INDEX IF EXISTS idx_service_items_module_id;
DROP INDEX IF EXISTS idx_forms_module_id;
DROP INDEX IF EXISTS idx_reservations_module_id;
DROP INDEX IF EXISTS idx_analytics_configs_module_id;
DROP INDEX IF EXISTS idx_ai_assistant_configs_module_id;

-- Drop module_id columns
ALTER TABLE service_items DROP COLUMN IF EXISTS module_id;
ALTER TABLE faq_items DROP COLUMN IF EXISTS module_id;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS module_id;
ALTER TABLE ai_assistant_configs DROP COLUMN IF EXISTS module_id;
ALTER TABLE analytics_configs DROP COLUMN IF EXISTS module_id;
ALTER TABLE reservations DROP COLUMN IF EXISTS module_id;
ALTER TABLE forms DROP COLUMN IF EXISTS module_id;

-- Drop registry table
DROP INDEX IF EXISTS idx_project_modules_project_id;
DROP TABLE IF EXISTS project_modules;
