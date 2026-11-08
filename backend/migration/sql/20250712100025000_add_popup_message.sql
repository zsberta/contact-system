-- 0026: Add popup_message column to ai_assistant_configs.
-- The popup message is shown as a bubble from the FAB button when the page loads.

ALTER TABLE ai_assistant_configs
  ADD COLUMN IF NOT EXISTS popup_message TEXT NOT NULL DEFAULT '';
