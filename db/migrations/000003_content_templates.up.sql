-- Content templates provide pre-filled editor content for entity creation.
-- Templates can be global (is_global=1, campaign_id IS NULL) or per-campaign.
CREATE TABLE IF NOT EXISTS content_templates (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id     CHAR(36) NULL,
    entity_type_id  INT NULL,
    name            VARCHAR(200) NOT NULL,
    description     VARCHAR(500) NOT NULL DEFAULT '',
    content_json    JSON NOT NULL,
    content_html    TEXT NOT NULL DEFAULT '',
    icon            VARCHAR(50) NOT NULL DEFAULT 'fa-file-lines',
    sort_order      INT NOT NULL DEFAULT 0,
    is_global       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_ct_campaign (campaign_id),
    INDEX idx_ct_entity_type (entity_type_id),
    INDEX idx_ct_global (is_global),

    CONSTRAINT fk_ct_campaign FOREIGN KEY (campaign_id)
        REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_ct_entity_type FOREIGN KEY (entity_type_id)
        REFERENCES entity_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
