-- Add preset_category column to entity_types.
-- This tracks which system preset category an entity type was created from
-- (e.g., "character", "item", "creature"). Used by the Armory plugin to
-- identify item-type entity types across different game systems.
ALTER TABLE entity_types
    ADD COLUMN preset_category VARCHAR(50) DEFAULT NULL AFTER color;

-- Add index for efficient filtering by preset category.
CREATE INDEX idx_entity_types_preset_category ON entity_types (campaign_id, preset_category);
