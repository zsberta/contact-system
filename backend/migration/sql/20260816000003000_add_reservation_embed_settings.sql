-- Up Migration
-- Add brand color, iframe width, and iframe height to reservations for customizable embed widget.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS brand_color TEXT NOT NULL DEFAULT '#0A2540';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS iframe_width TEXT NOT NULL DEFAULT '100%';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS iframe_height TEXT NOT NULL DEFAULT '760px';

-- Down Migration
ALTER TABLE reservations DROP COLUMN IF EXISTS brand_color;
ALTER TABLE reservations DROP COLUMN IF EXISTS iframe_width;
ALTER TABLE reservations DROP COLUMN IF EXISTS iframe_height;
