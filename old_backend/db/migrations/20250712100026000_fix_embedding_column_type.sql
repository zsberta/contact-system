-- Up Migration
--
-- 0027: Enable pgvector extension and fix the embedding column type.
--
-- When 0024 originally ran without pgvector, CREATE EXTENSION failed
-- silently (caught by EXCEPTION). This migration:
--   1. Creates the pgvector extension (safe to re-run)
--   2. Converts the embedding column from TEXT → VECTOR(1536)
--   3. Creates the IVFFlat index for cosine similarity

-- Step 1: Enable pgvector (the image pgvector/pgvector:pg16 ships with it)
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2 + 3: Fix column type and index if still TEXT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_knowledge_chunks'
      AND column_name = 'embedding'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE ai_knowledge_chunks
      ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector;

    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding
      ON ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    RAISE NOTICE '0027: fixed embedding column from TEXT to vector(1536) and created IVFFlat index';
  ELSE
    RAISE NOTICE '0027: embedding column already vector or pgvector not available';
  END IF;
END $$;

-- Down Migration

-- Cannot safely reverse a TYPE change; skip.
