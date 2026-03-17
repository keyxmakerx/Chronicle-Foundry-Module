-- Worldbuilding prompts: guided writing prompts to help users flesh out
-- their campaign content. Scoped to campaigns and optionally to entity types.
CREATE TABLE IF NOT EXISTS worldbuilding_prompts (
    id             INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id    CHAR(36)     NULL,
    entity_type_id INT          NULL,
    name           VARCHAR(200) NOT NULL,
    prompt_text    TEXT         NOT NULL,
    icon           VARCHAR(50)  NOT NULL DEFAULT 'fa-lightbulb',
    sort_order     INT          NOT NULL DEFAULT 0,
    is_global      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_wb_campaign (campaign_id),
    INDEX idx_wb_type (entity_type_id),
    CONSTRAINT fk_wb_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_wb_entity_type FOREIGN KEY (entity_type_id) REFERENCES entity_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
