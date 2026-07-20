-- Up Migration
--
-- 0022: Migrate faq_items from single-locale to bilingual schema.
-- Replaces question/answer/locale with question_hu/answer_hu/question_en/answer_en.
-- Safe to run on an existing table — migrates any existing data.

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
