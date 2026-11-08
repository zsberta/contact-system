-- Up Migration
-- Add embed_title to reservations for customizable embed widget heading.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS embed_title TEXT NOT NULL DEFAULT 'Időpont foglalás';

-- Down Migration
ALTER TABLE reservations DROP COLUMN IF EXISTS embed_title;
