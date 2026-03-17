-- shop_transactions records purchases, sales, transfers, and gifts between
-- entities (typically shop→character or character→character). Linked to the
-- entity_relations system but stored separately for query performance and
-- historical tracking (relations can be deleted, transactions persist).
CREATE TABLE IF NOT EXISTS shop_transactions (
    id                INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id       VARCHAR(36)  NOT NULL,
    shop_entity_id    VARCHAR(36)  NOT NULL COMMENT 'Shop or seller entity',
    item_entity_id    VARCHAR(36)  NOT NULL COMMENT 'Item entity being transacted',
    buyer_entity_id   VARCHAR(36)  DEFAULT NULL COMMENT 'Buyer character entity (NULL for restocks)',
    relation_id       INT          DEFAULT NULL COMMENT 'Originating shop inventory relation',
    quantity          INT          NOT NULL DEFAULT 1,
    price_paid        VARCHAR(100) DEFAULT NULL COMMENT 'Display-friendly price string (e.g., "50 gp")',
    currency          VARCHAR(50)  DEFAULT 'gp' COMMENT 'Currency code used for the transaction',
    price_numeric     DECIMAL(12,2) DEFAULT NULL COMMENT 'Numeric price for aggregation queries',
    transaction_type  VARCHAR(20)  NOT NULL COMMENT 'purchase, sale, transfer, gift, restock',
    notes             TEXT         DEFAULT NULL,
    created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by        VARCHAR(36)  DEFAULT NULL COMMENT 'User who initiated the transaction',

    INDEX idx_shop_tx_campaign   (campaign_id),
    INDEX idx_shop_tx_shop       (shop_entity_id),
    INDEX idx_shop_tx_buyer      (buyer_entity_id),
    INDEX idx_shop_tx_item       (item_entity_id),
    INDEX idx_shop_tx_created    (campaign_id, created_at DESC),

    CONSTRAINT fk_shop_tx_campaign FOREIGN KEY (campaign_id)
        REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
