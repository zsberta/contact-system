-- Up Migration
--
-- 0024: AI Assistant module — embeddable chat widget with RAG knowledge base.
--
-- =============================================================================
-- MODULE SHAPE
-- =============================================================================
-- Six tables:
--
--   ai_assistant_configs   — one row per project (FK projects.id, CASCADE, UNIQUE).
--                            Mirrors analytics_configs: lazy-created on first access.
--                            Stores AI config (model, base_url, api_key, base_prompt),
--                            widget branding (colors, name, greeting), multilanguage
--                            settings, and security (rate limits, origins).
--
--   ai_assistant_translations — per-language UI overrides (display name, greeting,
--                            placeholder). Without a row, the config defaults are used.
--
--   ai_config_presets      — reusable AI config presets (model, base_url, api_key,
--                            base_prompt). Admins create these once and apply across
--                            multiple assistants/projects.
--
--   ai_knowledge_base      — uploaded documents for the RAG knowledge base.
--                            Language-agnostic: no language column.
--
--   ai_knowledge_chunks    — text chunks + pgvector embeddings for RAG retrieval.
--
--   ai_chat_sessions       — one row per visitor session.
--
--   ai_chat_messages       — append-only chat message log.

-- ---------------------------------------------------------------------------
-- Recovery block
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS ai_chat_messages CASCADE;
  DROP TABLE IF EXISTS ai_chat_sessions CASCADE;
  DROP TABLE IF EXISTS ai_knowledge_chunks CASCADE;
  DROP TABLE IF EXISTS ai_knowledge_base CASCADE;
  DROP TABLE IF EXISTS ai_assistant_translations CASCADE;
  DROP TABLE IF EXISTS ai_assistant_configs CASCADE;
  DROP TABLE IF EXISTS ai_config_presets CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0024: recovery drop of AI assistant tables skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Enable pgvector extension (optional — RAG vector search requires it)
-- If the extension is not installed, tables still create successfully but
-- the embedding column and IVFFlat index are skipped. Install pgvector and
-- re-run the migration (or run the ALTER below manually) to add them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  RAISE NOTICE '0024: pgvector extension enabled';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0024: pgvector extension not available — vector columns/indexes skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- AI config presets (reusable across assistants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_config_presets (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  model           TEXT NOT NULL DEFAULT 'gpt-4o',
  base_url        TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  api_key_enc     TEXT,              -- encrypted API key (AES-256-GCM at rest)
  base_prompt     TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION ai_config_presets_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_config_presets_touch_updated_at ON ai_config_presets;
CREATE TRIGGER trg_ai_config_presets_touch_updated_at
  BEFORE UPDATE ON ai_config_presets
  FOR EACH ROW EXECUTE FUNCTION ai_config_presets_touch_updated_at();

-- ---------------------------------------------------------------------------
-- AI assistant configs (one per project)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_assistant_configs (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  secret_token    TEXT NOT NULL UNIQUE CHECK (length(secret_token) = 22),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),

  -- AI configuration (admin-only fields)
  ai_config_id    BIGINT REFERENCES ai_config_presets(id) ON DELETE SET NULL,
  model           TEXT NOT NULL DEFAULT 'gpt-4o',
  base_url        TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  api_key_enc     TEXT,              -- encrypted API key (AES-256-GCM at rest)
  base_prompt     TEXT NOT NULL DEFAULT 'You are a helpful assistant.',

  -- Widget branding (admin/configurable per assistant)
  display_name    TEXT NOT NULL DEFAULT 'AI Assistant',
  primary_color   TEXT NOT NULL DEFAULT '#3b82f6',
  secondary_color TEXT NOT NULL DEFAULT '#ffffff',
  greeting_message TEXT NOT NULL DEFAULT 'Hello! How can I help you today?',
  avatar_url      TEXT,
  position        TEXT NOT NULL DEFAULT 'bottom-right' CHECK (position IN ('bottom-right', 'bottom-left')),

  -- Multilanguage support
  default_language TEXT NOT NULL DEFAULT 'en',
  supported_languages TEXT[] NOT NULL DEFAULT '{en}',

  -- Security
  allowed_origins     TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_burst    INT NOT NULL DEFAULT 30,
  rate_limit_sustained INT NOT NULL DEFAULT 500,
  max_upload_size_mb  INT NOT NULL DEFAULT 20,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION ai_assistant_configs_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_assistant_configs_touch_updated_at ON ai_assistant_configs;
CREATE TRIGGER trg_ai_assistant_configs_touch_updated_at
  BEFORE UPDATE ON ai_assistant_configs
  FOR EACH ROW EXECUTE FUNCTION ai_assistant_configs_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_ai_assistant_configs_status
  ON ai_assistant_configs(status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- AI assistant translations (per-language UI overrides)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_assistant_translations (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  language        TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 10),
  display_name    TEXT,
  greeting_message TEXT,
  placeholder     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assistant_id, language)
);

CREATE OR REPLACE FUNCTION ai_assistant_translations_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_assistant_translations_touch_updated_at ON ai_assistant_translations;
CREATE TRIGGER trg_ai_assistant_translations_touch_updated_at
  BEFORE UPDATE ON ai_assistant_translations
  FOR EACH ROW EXECUTE FUNCTION ai_assistant_translations_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Knowledge base documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_knowledge_base (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type       TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error_message   TEXT,
  chunk_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION ai_knowledge_base_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_knowledge_base_touch_updated_at ON ai_knowledge_base;
CREATE TRIGGER trg_ai_knowledge_base_touch_updated_at
  BEFORE UPDATE ON ai_knowledge_base
  FOR EACH ROW EXECUTE FUNCTION ai_knowledge_base_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_base_assistant
  ON ai_knowledge_base (assistant_id);

-- ---------------------------------------------------------------------------
-- Knowledge base chunks (vector embeddings for RAG)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES ai_knowledge_base(id) ON DELETE CASCADE,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  chunk_index     INT NOT NULL,
  content         TEXT NOT NULL,
  embedding       TEXT,  -- will be ALTERed to VECTOR(1536) if pgvector is available
  token_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_assistant
  ON ai_knowledge_chunks (assistant_id);

-- If pgvector is available, upgrade the embedding column to VECTOR type
-- and create the IVFFlat index for cosine similarity search.
DO $$
BEGIN
  -- Check if vector type exists (i.e. pgvector extension is loaded)
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    -- Change column type from TEXT to VECTOR(1536)
    ALTER TABLE ai_knowledge_chunks
      ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector;

    -- IVFFlat index for cosine similarity. Lists=100 is a reasonable
    -- default for up to ~100k vectors.
    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding
      ON ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    RAISE NOTICE '0024: pgvector embedding column and IVFFlat index created';
  ELSE
    RAISE NOTICE '0024: pgvector not available — embedding stored as TEXT, no vector index';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Chat sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  visitor_id      TEXT,
  language        TEXT NOT NULL DEFAULT 'en',
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION ai_chat_sessions_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_chat_sessions_touch_updated_at ON ai_chat_sessions;
CREATE TRIGGER trg_ai_chat_sessions_touch_updated_at
  BEFORE UPDATE ON ai_chat_sessions
  FOR EACH ROW EXECUTE FUNCTION ai_chat_sessions_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_assistant_session
  ON ai_chat_sessions (assistant_id, session_id);

-- ---------------------------------------------------------------------------
-- Chat messages (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',
  tokens_used     INT NOT NULL DEFAULT 0,
  rag_sources     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
  ON ai_chat_messages (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_assistant
  ON ai_chat_messages (assistant_id, created_at DESC);

-- Down Migration

DROP TRIGGER IF EXISTS trg_ai_chat_sessions_touch_updated_at ON ai_chat_sessions;
DROP FUNCTION IF EXISTS ai_chat_sessions_touch_updated_at();
DROP TABLE IF EXISTS ai_chat_messages;
DROP TABLE IF EXISTS ai_chat_sessions;
DROP TABLE IF EXISTS ai_knowledge_chunks;
DROP TRIGGER IF EXISTS trg_ai_knowledge_base_touch_updated_at ON ai_knowledge_base;
DROP FUNCTION IF EXISTS ai_knowledge_base_touch_updated_at();
DROP TABLE IF EXISTS ai_knowledge_base;
DROP TRIGGER IF EXISTS trg_ai_assistant_translations_touch_updated_at ON ai_assistant_translations;
DROP FUNCTION IF EXISTS ai_assistant_translations_touch_updated_at();
DROP TABLE IF EXISTS ai_assistant_translations;
DROP TRIGGER IF EXISTS trg_ai_assistant_configs_touch_updated_at ON ai_assistant_configs;
DROP FUNCTION IF EXISTS ai_assistant_configs_touch_updated_at();
DROP TABLE IF EXISTS ai_assistant_configs;
DROP TRIGGER IF EXISTS trg_ai_config_presets_touch_updated_at ON ai_config_presets;
DROP FUNCTION IF EXISTS ai_config_presets_touch_updated_at();
DROP TABLE IF EXISTS ai_config_presets;
DROP EXTENSION IF EXISTS vector;
