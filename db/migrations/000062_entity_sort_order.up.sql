-- Add sort_order column to entities for manual ordering within categories.
-- Defaults to 0; entities with the same sort_order fall back to alphabetical.
ALTER TABLE entities ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER parent_id;
