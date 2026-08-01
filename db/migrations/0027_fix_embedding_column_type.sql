-- Up Migration
--
-- 0027: Fix ai_knowledge_chunks.embedding column type when pgvector was
--       not available during the original 0024 migration.
--
-- If the column is still TEXT (pgvector wasn't installed at migration time),
-- convert it to VECTOR(1536) and create the IVFFlat index. This is safe to
-- re-run — the ALTER and CREATE INDEX are conditional.

DO $$
BEGIN
  -- Only act if pgvector is available AND the column is still TEXT
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector')
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'ai_knowledge_chunks'
         AND column_name = 'embedding'
         AND data_type = 'text'
     ) THEN
    -- Convert TEXT → VECTOR(1536)
    ALTER TABLE ai_knowledge_chunks
      ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector;

    -- IVFFlat index for cosine similarity
    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding
      ON ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    RAISE NOTICE '0027: fixed embedding column from TEXT to vector(1536) and created IVFFlat index';
  ELSE
    RAISE NOTICE '0027: no fix needed (pgvector unavailable or embedding already VECTOR)';
  END IF;
END $$;

-- Down Migration

-- Cannot safely reverse a TYPE change; skip.
