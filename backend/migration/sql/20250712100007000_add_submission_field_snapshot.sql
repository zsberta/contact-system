-- Up Migration

-- Snapshot of the widget's `fields` JSONB at the moment of submission.
-- Captured server-side in routes/widget-embed.js so the admin detail
-- view can render each data key against its label/placeholder even if
-- the widget's fields are later edited, renamed, or deleted.
ALTER TABLE widget_form_submissions
  ADD COLUMN IF NOT EXISTS field_snapshot JSONB;

-- Snapshot of the widget's `name_i18n` at the moment of submission.
-- Used by the admin submissions list/detail to show the widget's name
-- even after the operator renames or deletes the widget.
ALTER TABLE widget_form_submissions
  ADD COLUMN IF NOT EXISTS widget_name_snapshot JSONB;

-- Down Migration
ALTER TABLE widget_form_submissions DROP COLUMN IF EXISTS widget_name_snapshot;
ALTER TABLE widget_form_submissions DROP COLUMN IF EXISTS field_snapshot;