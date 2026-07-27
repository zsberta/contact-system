-- 0025: Add legal_message column to ai_assistant_configs.
-- The legal message is displayed first when a chat starts, before the greeting.

ALTER TABLE ai_assistant_configs
  ADD COLUMN IF NOT EXISTS legal_message TEXT NOT NULL DEFAULT '';
