-- Sync API plugin schema: API key management, request logging, and
-- bidirectional sync mappings for external tool integration (Foundry VTT, etc.).

CREATE TABLE IF NOT EXISTS api_keys (
    id                 INT          AUTO_INCREMENT PRIMARY KEY,
    key_hash           VARCHAR(255) NOT NULL,
    key_prefix         VARCHAR(8)   NOT NULL,
    name               VARCHAR(100) NOT NULL,
    user_id            VARCHAR(36)  NOT NULL,
    campaign_id        VARCHAR(36)  NOT NULL,
    permissions        JSON         DEFAULT NULL,
    ip_allowlist       JSON         DEFAULT NULL,
    device_fingerprint VARCHAR(255) DEFAULT NULL,
    device_bound_at    DATETIME     DEFAULT NULL,
    rate_limit         INT          NOT NULL DEFAULT 60,
    is_active          TINYINT(1)   NOT NULL DEFAULT 1,
    last_used_at       DATETIME     DEFAULT NULL,
    last_used_ip       VARCHAR(45)  DEFAULT NULL,
    expires_at         DATETIME     DEFAULT NULL,
    created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY idx_api_keys_prefix (key_prefix),
    KEY idx_api_keys_user (user_id),
    KEY idx_api_keys_campaign (campaign_id),
    KEY idx_api_keys_active (is_active),
    CONSTRAINT fk_api_keys_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_request_log (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY,
    api_key_id    INT          NOT NULL,
    campaign_id   VARCHAR(36)  NULL,
    user_id       VARCHAR(36)  NOT NULL,
    method        VARCHAR(10)  NOT NULL,
    path          VARCHAR(500) NOT NULL,
    status_code   INT          NOT NULL,
    ip_address    VARCHAR(45)  NOT NULL,
    user_agent    VARCHAR(500) DEFAULT NULL,
    request_size  INT          DEFAULT 0,
    response_size INT          DEFAULT 0,
    duration_ms   INT          DEFAULT 0,
    error_message VARCHAR(500) DEFAULT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    KEY idx_api_log_key (api_key_id),
    KEY idx_api_log_campaign (campaign_id),
    KEY idx_api_log_created (created_at),
    KEY idx_api_log_ip (ip_address),
    KEY idx_api_log_status (status_code),
    CONSTRAINT fk_api_request_log_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_mappings (
    id              CHAR(36)     NOT NULL PRIMARY KEY,
    campaign_id     CHAR(36)     NOT NULL,
    chronicle_type  VARCHAR(50)  NOT NULL,
    chronicle_id    CHAR(36)     NOT NULL,
    external_system VARCHAR(50)  NOT NULL,
    external_id     VARCHAR(255) NOT NULL,
    sync_version    INT          NOT NULL DEFAULT 1,
    last_synced_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sync_direction  VARCHAR(10)  NOT NULL DEFAULT 'both',
    sync_metadata   JSON         DEFAULT NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_sync_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    UNIQUE KEY uq_sync_mapping (campaign_id, chronicle_type, chronicle_id, external_system),
    INDEX idx_sync_external (campaign_id, external_system, external_id),
    INDEX idx_sync_type (campaign_id, chronicle_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
