-- Add timezone column to media table for video upload (media date and sync use this timezone).
-- Run per schema if you have multiple class schemas with media tables.
ALTER TABLE gp50.media ADD COLUMN IF NOT EXISTS timezone text;
