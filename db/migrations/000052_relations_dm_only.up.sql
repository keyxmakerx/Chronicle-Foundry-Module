-- Add dm_only visibility flag to entity relations.
-- When true, the relation is only visible to Scribe+ roles.
ALTER TABLE entity_relations ADD COLUMN dm_only BOOLEAN NOT NULL DEFAULT FALSE AFTER metadata;
