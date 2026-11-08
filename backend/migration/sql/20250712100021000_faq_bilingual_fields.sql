-- Up Migration
--
-- 0022: Migrate faq_items from single-locale to bilingual schema.
-- Replaces question/answer/locale with question_hu/answer_hu/question_en/answer_en.
--
-- This migration is a no-op if the table was already created with the
-- bilingual schema (e.g. by 0021 on a fresh install). It only runs the
-- ALTER/UPDATE steps when the old `question` column exists.

-- Check if the old schema exists (question column present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'faq_items' AND column_name = 'question'
  ) THEN
    -- Drop old indexes that reference locale
    DROP INDEX IF EXISTS idx_faq_items_project_locale;
    DROP INDEX IF EXISTS idx_faq_items_public;

    -- Add new columns (with defaults so existing rows are fine)
    ALTER TABLE faq_items
      ADD COLUMN IF NOT EXISTS question_hu TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS answer_hu   TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS question_en TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS answer_en   TEXT NOT NULL DEFAULT '';

    -- Migrate existing data: copy question -> question_hu, answer -> answer_hu
    UPDATE faq_items SET question_hu = question, answer_hu = answer
      WHERE question_hu = '' AND question != '';

    -- Drop old columns
    ALTER TABLE faq_items DROP COLUMN IF EXISTS question;
    ALTER TABLE faq_items DROP COLUMN IF EXISTS answer;
    ALTER TABLE faq_items DROP COLUMN IF EXISTS locale;

    -- Recreate indexes without locale
    CREATE INDEX IF NOT EXISTS idx_faq_items_project_sort
      ON faq_items (project_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_faq_items_public
      ON faq_items (project_id, status, sort_order)
      WHERE status = 'published';

    -- Fix the NOT NULL constraints now that data is migrated
    ALTER TABLE faq_items
      ALTER COLUMN question_hu DROP DEFAULT,
      ALTER COLUMN answer_hu DROP DEFAULT;

    RAISE NOTICE '0022: migrated faq_items from single-locale to bilingual schema';
  ELSE
    -- Table already has the bilingual schema (fresh install via 0021).
    -- Ensure indexes exist (idempotent).
    CREATE INDEX IF NOT EXISTS idx_faq_items_project_sort
      ON faq_items (project_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_faq_items_public
      ON faq_items (project_id, status, sort_order)
      WHERE status = 'published';

    RAISE NOTICE '0022: faq_items already bilingual, skipping migration';
  END IF;
END $$;
