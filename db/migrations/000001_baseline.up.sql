-- Baseline schema: all core tables in their final state.
-- Plugin tables (calendar, maps, sessions, timeline, syncapi) are managed
-- by per-plugin migrations in internal/plugins/<name>/migrations/.
-- This file is idempotent: every CREATE TABLE uses IF NOT EXISTS.

-- ============================================================================
-- 1. Independent tables (no FK dependencies)
-- ============================================================================

CREATE TABLE IF NOT EXISTS site_settings (
    setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
    setting_value TEXT         NOT NULL,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS smtp_settings (
    id                 INT            NOT NULL DEFAULT 1,
    host               VARCHAR(255)   NOT NULL DEFAULT '',
    port               INT            NOT NULL DEFAULT 587,
    username           VARCHAR(255)   NOT NULL DEFAULT '',
    password_encrypted VARBINARY(512) DEFAULT NULL,
    from_address       VARCHAR(255)   NOT NULL DEFAULT '',
    from_name          VARCHAR(100)   NOT NULL DEFAULT 'Chronicle',
    encryption         VARCHAR(20)    NOT NULL DEFAULT 'starttls',
    enabled            BOOLEAN        NOT NULL DEFAULT FALSE,
    updated_at         DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT smtp_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. Users
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id                   CHAR(36)     NOT NULL,
    email                VARCHAR(255) NOT NULL,
    display_name         VARCHAR(100) NOT NULL,
    password_hash        VARCHAR(255) NOT NULL,
    avatar_path          VARCHAR(500) DEFAULT NULL,
    is_admin             BOOLEAN      NOT NULL DEFAULT FALSE,
    totp_secret          VARCHAR(255) DEFAULT NULL,
    totp_enabled         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at        DATETIME     DEFAULT NULL,
    is_disabled          BOOLEAN      NOT NULL DEFAULT FALSE,
    timezone             VARCHAR(50)  DEFAULT NULL,
    pending_email        VARCHAR(255) DEFAULT NULL,
    email_verify_token   CHAR(64)     DEFAULT NULL,
    email_verify_expires DATETIME     DEFAULT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY idx_users_email (email),
    UNIQUE INDEX idx_users_email_verify_token (email_verify_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         INT          NOT NULL AUTO_INCREMENT,
    user_id    CHAR(36)     NOT NULL,
    email      VARCHAR(255) NOT NULL,
    token_hash CHAR(64)     NOT NULL,
    expires_at DATETIME     NOT NULL,
    used_at    DATETIME     DEFAULT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY idx_reset_token_hash (token_hash),
    KEY idx_reset_user_id (user_id),
    KEY idx_reset_expires (expires_at),

    CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS security_events (
    id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(50)  NOT NULL,
    user_id    CHAR(36)     DEFAULT NULL,
    actor_id   CHAR(36)     DEFAULT NULL,
    ip_address VARCHAR(45)  NOT NULL DEFAULT '',
    user_agent TEXT         DEFAULT NULL,
    details    JSON         DEFAULT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_security_events_type_created (event_type, created_at DESC),
    INDEX idx_security_events_user (user_id, created_at DESC),
    INDEX idx_security_events_ip (ip_address, created_at DESC),
    INDEX idx_security_events_created (created_at DESC),
    INDEX idx_security_events_actor (actor_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 3. Campaigns
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaigns (
    id               CHAR(36)     NOT NULL,
    name             VARCHAR(200) NOT NULL,
    slug             VARCHAR(200) NOT NULL,
    description      TEXT         DEFAULT NULL,
    is_public        BOOLEAN      NOT NULL DEFAULT FALSE,
    settings         JSON         NOT NULL DEFAULT ('{}'),
    backdrop_path    VARCHAR(500) DEFAULT NULL,
    sidebar_config   JSON         NOT NULL DEFAULT ('{}'),
    dashboard_layout JSON         DEFAULT NULL,
    created_by       CHAR(36)     NOT NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY idx_campaigns_slug (slug),
    INDEX idx_campaigns_created_by (created_by),
    CONSTRAINT fk_campaigns_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ownership_transfers (
    id           CHAR(36)     NOT NULL,
    campaign_id  CHAR(36)     NOT NULL,
    from_user_id CHAR(36)     NOT NULL,
    to_user_id   CHAR(36)     NOT NULL,
    token        VARCHAR(128) NOT NULL,
    expires_at   DATETIME     NOT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY idx_ot_campaign (campaign_id),
    UNIQUE KEY idx_ot_token (token),
    CONSTRAINT fk_ot_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_ot_from FOREIGN KEY (from_user_id) REFERENCES users(id),
    CONSTRAINT fk_ot_to FOREIGN KEY (to_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
    campaign_id CHAR(36)     NOT NULL,
    user_id     CHAR(36)     NOT NULL,
    action      VARCHAR(50)  NOT NULL,
    entity_type VARCHAR(50)  NOT NULL DEFAULT '',
    entity_id   VARCHAR(36)  NOT NULL DEFAULT '',
    entity_name VARCHAR(255) NOT NULL DEFAULT '',
    details     JSON         DEFAULT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_audit_campaign_created (campaign_id, created_at DESC),
    INDEX idx_audit_entity (entity_id),
    INDEX idx_audit_user (user_id),

    CONSTRAINT fk_audit_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_files (
    id              CHAR(36)     NOT NULL PRIMARY KEY,
    campaign_id     CHAR(36)     NULL,
    uploaded_by     CHAR(36)     NOT NULL,
    filename        VARCHAR(500) NOT NULL,
    original_name   VARCHAR(500) NOT NULL,
    mime_type       VARCHAR(100) NOT NULL,
    file_size       BIGINT       NOT NULL,
    usage_type      VARCHAR(50)  NOT NULL DEFAULT 'attachment',
    thumbnail_paths JSON         DEFAULT NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_media_campaign (campaign_id),
    INDEX idx_media_uploaded_by (uploaded_by),

    CONSTRAINT fk_media_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
    CONSTRAINT fk_media_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_storage_limits (
    user_id           CHAR(36)     NOT NULL PRIMARY KEY,
    max_upload_size   BIGINT       DEFAULT NULL,
    max_total_storage BIGINT       DEFAULT NULL,
    bypass_max_upload BIGINT       NULL,
    bypass_expires_at TIMESTAMP    NULL,
    bypass_reason     VARCHAR(255) NULL,
    bypass_granted_by CHAR(36)     NULL,
    updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_user_storage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_storage_limits (
    campaign_id        CHAR(36)     NOT NULL PRIMARY KEY,
    max_total_storage  BIGINT       DEFAULT NULL,
    max_files          INT          DEFAULT NULL,
    bypass_max_storage BIGINT       NULL,
    bypass_max_files   INT          NULL,
    bypass_expires_at  TIMESTAMP    NULL,
    bypass_reason      VARCHAR(255) NULL,
    bypass_granted_by  CHAR(36)     NULL,
    updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_campaign_storage_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 4. Addon registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS addons (
    id            INT          AUTO_INCREMENT PRIMARY KEY,
    slug          VARCHAR(100) NOT NULL UNIQUE,
    name          VARCHAR(200) NOT NULL,
    description   TEXT,
    version       VARCHAR(50)  NOT NULL DEFAULT '0.1.0',
    category      ENUM('system', 'widget', 'integration', 'plugin') NOT NULL,
    status        ENUM('active', 'planned', 'deprecated') NOT NULL DEFAULT 'active',
    icon          VARCHAR(100) DEFAULT 'fa-puzzle-piece',
    author        VARCHAR(200),
    config_schema JSON         DEFAULT NULL,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_addons (
    id          INT      AUTO_INCREMENT PRIMARY KEY,
    campaign_id CHAR(36) NOT NULL,
    addon_id    INT      NOT NULL,
    enabled     BOOLEAN  NOT NULL DEFAULT TRUE,
    config_json JSON     DEFAULT NULL,
    enabled_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    enabled_by  CHAR(36),

    UNIQUE KEY uq_campaign_addon (campaign_id, addon_id),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed addon registry with final state of all addons.
-- Plugin-specific addons (calendar, maps, etc.) are seeded here so the
-- addon registry is complete even if a plugin's schema migration fails.
INSERT INTO addons (slug, name, description, version, category, status, icon, author) VALUES
    ('dnd5e', 'D&D 5th Edition', 'Reference data, stat blocks, and tooltips for Dungeons & Dragons 5th Edition', '0.1.0', 'system', 'planned', 'fa-dragon', 'Chronicle'),
    ('pathfinder2e', 'Pathfinder 2nd Edition', 'Reference data and tooltips for Pathfinder 2nd Edition', '0.1.0', 'system', 'planned', 'fa-shield-halved', 'Chronicle'),
    ('drawsteel', 'Draw Steel', 'Reference data for the Draw Steel RPG system', '0.1.0', 'system', 'planned', 'fa-swords', 'Chronicle'),
    ('notes', 'Notes', 'Floating notebook panel (bottom-right) for personal and shared campaign notes. Includes checklists, color coding, version history, and edit locking.', '0.1.0', 'widget', 'active', 'fa-book', 'Chronicle'),
    ('player-notes', 'Player Notes', 'Collaborative note-taking block for entity pages. Players can write real-time notes about specific entities, visible to all campaign members.', '0.1.0', 'widget', 'planned', 'fa-sticky-note', 'Chronicle'),
    ('calendar', 'Calendar', 'Custom fantasy calendar with configurable months, weekdays, moons, seasons, and events. Link events to entities for timeline tracking.', '0.1.0', 'plugin', 'active', 'fa-calendar-days', 'Chronicle'),
    ('maps', 'Interactive Maps', 'Leaflet.js map viewer with entity pins and layer support', '0.1.0', 'plugin', 'active', 'fa-map', 'Chronicle'),
    ('sync-api', 'Sync API', 'Secure REST API for external tool integration (Foundry VTT, Roll20, etc.)', '0.1.0', 'integration', 'active', 'fa-arrows-rotate', 'Chronicle'),
    ('media-gallery', 'Media Gallery', 'Campaign media management — upload, browse, and organize images. Future: albums, tagging, and lightbox.', '0.1.0', 'plugin', 'active', 'fa-images', 'Chronicle'),
    ('timeline', 'Timeline', 'Interactive visual timelines with zoom levels, entity grouping, and calendar integration. Multiple timelines per campaign.', '0.1.0', 'plugin', 'active', 'fa-timeline', 'Chronicle'),
    ('family-tree', 'Family Tree', 'Visual family/org tree diagram from entity relations', '0.1.0', 'widget', 'planned', 'fa-sitemap', 'Chronicle'),
    ('dice-roller', 'Dice Roller', 'In-app dice rolling with formula support and history', '0.1.0', 'widget', 'planned', 'fa-dice-d20', 'Chronicle'),
    ('attributes', 'Attributes', 'Custom attribute fields on entity pages (e.g. race, alignment, HP). When disabled, attribute panels are hidden from entity pages.', '0.1.0', 'widget', 'active', 'fa-sliders', 'Chronicle'),
    ('sessions', 'Sessions', 'Track game sessions with scheduling, linked entities, and RSVP.', '0.1.0', 'plugin', 'active', 'fa-calendar-check', 'Chronicle')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============================================================================
-- 5. Entity types & entities
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_types (
    id                INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id       CHAR(36)     NOT NULL,
    slug              VARCHAR(100) NOT NULL,
    name              VARCHAR(100) NOT NULL,
    name_plural       VARCHAR(100) NOT NULL,
    icon              VARCHAR(50)  NOT NULL DEFAULT 'fa-file',
    color             VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
    description       TEXT         DEFAULT NULL,
    pinned_entity_ids JSON         DEFAULT NULL,
    fields            JSON         NOT NULL DEFAULT ('[]'),
    layout_json       JSON         NOT NULL DEFAULT ('{"sections":[]}'),
    dashboard_layout  JSON         DEFAULT NULL,
    sort_order        INT          NOT NULL DEFAULT 0,
    is_default        BOOLEAN      NOT NULL DEFAULT FALSE,
    enabled           BOOLEAN      NOT NULL DEFAULT TRUE,

    UNIQUE KEY uq_entity_types_campaign_slug (campaign_id, slug),
    CONSTRAINT fk_entity_types_campaign
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entities (
    id              CHAR(36)     PRIMARY KEY,
    campaign_id     CHAR(36)     NOT NULL,
    entity_type_id  INT          NOT NULL,
    name            VARCHAR(200) NOT NULL,
    slug            VARCHAR(200) NOT NULL,
    entry           JSON         NULL,
    entry_html      LONGTEXT     NULL,
    image_path      VARCHAR(500) NULL,
    parent_id       CHAR(36)     NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    type_label      VARCHAR(100) NULL,
    is_private      BOOLEAN      NOT NULL DEFAULT FALSE,
    visibility      ENUM('default','custom') NOT NULL DEFAULT 'default',
    is_template     BOOLEAN      NOT NULL DEFAULT FALSE,
    fields_data     JSON         NOT NULL DEFAULT ('{}'),
    field_overrides JSON         DEFAULT NULL,
    popup_config    JSON         DEFAULT NULL,
    created_by      CHAR(36)     NOT NULL,
    created_at      DATETIME     NOT NULL,
    updated_at      DATETIME     NOT NULL,

    UNIQUE KEY uq_entities_campaign_slug (campaign_id, slug),
    FULLTEXT KEY ft_entities_name (name),
    INDEX idx_entities_campaign_type (campaign_id, entity_type_id),
    INDEX idx_entities_parent (parent_id),

    CONSTRAINT fk_entities_campaign
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_entities_type
        FOREIGN KEY (entity_type_id) REFERENCES entity_types(id) ON DELETE CASCADE,
    CONSTRAINT fk_entities_parent
        FOREIGN KEY (parent_id) REFERENCES entities(id) ON DELETE SET NULL,
    CONSTRAINT fk_entities_creator
        FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6. Entity-related tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_members (
    campaign_id         CHAR(36)    NOT NULL,
    user_id             CHAR(36)    NOT NULL,
    role                VARCHAR(20) NOT NULL DEFAULT 'player',
    joined_at           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    character_entity_id VARCHAR(36) DEFAULT NULL,

    PRIMARY KEY (campaign_id, user_id),
    INDEX idx_campaign_members_user (user_id),
    CONSTRAINT fk_cm_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_cm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_cm_character_entity FOREIGN KEY (character_entity_id) REFERENCES entities(id) ON DELETE SET NULL,
    CONSTRAINT chk_cm_role CHECK (role IN ('owner', 'scribe', 'player'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entity_aliases (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    entity_id  CHAR(36)     NOT NULL,
    alias      VARCHAR(200) NOT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_alias_entity (entity_id, alias),
    FULLTEXT INDEX ft_alias (alias),
    CONSTRAINT fk_alias_entity FOREIGN KEY (entity_id)
        REFERENCES entities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entity_posts (
    id          CHAR(36)     NOT NULL,
    entity_id   CHAR(36)     NOT NULL,
    campaign_id CHAR(36)     NOT NULL,
    name        VARCHAR(200) NOT NULL,
    entry       JSON         NULL     COMMENT 'TipTap/ProseMirror JSON',
    entry_html  LONGTEXT     NULL     COMMENT 'Pre-rendered HTML for display',
    is_private  BOOLEAN      NOT NULL DEFAULT FALSE COMMENT 'DM-only post',
    sort_order  INT          NOT NULL DEFAULT 0,
    created_by  CHAR(36)     NOT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    INDEX idx_entity_posts_entity (entity_id),
    INDEX idx_entity_posts_campaign (campaign_id),
    CONSTRAINT fk_entity_posts_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    CONSTRAINT fk_entity_posts_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entity_permissions (
    id           INT          AUTO_INCREMENT PRIMARY KEY,
    entity_id    CHAR(36)     NOT NULL,
    subject_type ENUM('role','user','group') NOT NULL,
    subject_id   VARCHAR(36)  NOT NULL,
    permission   ENUM('view','edit') NOT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_entity_perm (entity_id, subject_type, subject_id, permission),
    INDEX idx_entity_perm_entity (entity_id),
    INDEX idx_entity_perm_subject (subject_type, subject_id),

    CONSTRAINT fk_entity_perm_entity
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entity_relations (
    id                    INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id           VARCHAR(36)  NOT NULL,
    source_entity_id      VARCHAR(36)  NOT NULL,
    target_entity_id      VARCHAR(36)  NOT NULL,
    relation_type         VARCHAR(100) NOT NULL,
    reverse_relation_type VARCHAR(100) NOT NULL,
    created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by            VARCHAR(36)  NOT NULL,
    metadata              JSON         COMMENT 'Relation-specific data (e.g., shop: price, quantity)',
    dm_only               BOOLEAN      NOT NULL DEFAULT FALSE,

    UNIQUE KEY uq_entity_relations_pair (source_entity_id, target_entity_id, relation_type),
    INDEX idx_entity_relations_source (source_entity_id),
    INDEX idx_entity_relations_target (target_entity_id),
    INDEX idx_entity_relations_campaign (campaign_id),

    CONSTRAINT fk_entity_relations_campaign
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_entity_relations_source
        FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    CONSTRAINT fk_entity_relations_target
        FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    CONSTRAINT fk_entity_relations_creator
        FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 7. Tags
-- ============================================================================

CREATE TABLE IF NOT EXISTS tags (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id CHAR(36)     NOT NULL,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL,
    color       VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
    dm_only     BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE INDEX idx_tags_campaign_slug (campaign_id, slug),
    INDEX idx_tags_campaign (campaign_id),
    INDEX idx_tags_campaign_visible (campaign_id, dm_only),

    CONSTRAINT fk_tags_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entity_tags (
    entity_id  CHAR(36) NOT NULL,
    tag_id     INT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (entity_id, tag_id),
    INDEX idx_entity_tags_tag (tag_id),

    CONSTRAINT fk_entity_tags_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    CONSTRAINT fk_entity_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 8. Notes
-- ============================================================================

CREATE TABLE IF NOT EXISTS notes (
    id             CHAR(36)     PRIMARY KEY,
    campaign_id    CHAR(36)     NOT NULL,
    user_id        CHAR(36)     NOT NULL,
    entity_id      CHAR(36)     DEFAULT NULL,
    parent_id      CHAR(36)     NULL DEFAULT NULL,
    is_folder      BOOLEAN      NOT NULL DEFAULT FALSE,
    title          VARCHAR(200) NOT NULL DEFAULT 'Untitled',
    content        JSON         NOT NULL,
    entry          JSON         DEFAULT NULL,
    entry_html     TEXT         DEFAULT NULL,
    color          VARCHAR(20)  NOT NULL DEFAULT '#374151',
    pinned         BOOLEAN      NOT NULL DEFAULT FALSE,
    is_shared      BOOLEAN      NOT NULL DEFAULT FALSE,
    last_edited_by CHAR(36)     DEFAULT NULL,
    locked_by      CHAR(36)     DEFAULT NULL,
    locked_at      DATETIME     DEFAULT NULL,
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_notes_user_campaign (user_id, campaign_id),
    INDEX idx_notes_entity (entity_id),
    INDEX idx_notes_locked (locked_by, locked_at),
    INDEX idx_notes_shared (campaign_id, is_shared),
    INDEX idx_notes_parent (parent_id),

    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_notes_parent FOREIGN KEY (parent_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS note_versions (
    id         CHAR(36)     NOT NULL PRIMARY KEY,
    note_id    CHAR(36)     NOT NULL,
    user_id    CHAR(36)     NOT NULL,
    title      VARCHAR(200) NOT NULL DEFAULT '',
    content    JSON         NOT NULL,
    entry      JSON         DEFAULT NULL,
    entry_html TEXT         DEFAULT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_note_versions_note (note_id, created_at DESC),
    CONSTRAINT fk_note_versions_note
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 9. Campaign groups
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_groups (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    campaign_id CHAR(36)     NOT NULL,
    name        VARCHAR(100) NOT NULL,
    description VARCHAR(500) DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_campaign_groups_campaign (campaign_id),
    UNIQUE KEY uq_campaign_group_name (campaign_id, name),

    CONSTRAINT fk_campaign_groups_campaign
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_group_members (
    group_id  INT      NOT NULL,
    user_id   CHAR(36) NOT NULL,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (group_id, user_id),
    INDEX idx_group_members_user (user_id),

    CONSTRAINT fk_group_members_group
        FOREIGN KEY (group_id) REFERENCES campaign_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 10. Extension system
-- ============================================================================

CREATE TABLE IF NOT EXISTS extensions (
    id           CHAR(36)     NOT NULL PRIMARY KEY,
    ext_id       VARCHAR(64)  NOT NULL UNIQUE,
    name         VARCHAR(100) NOT NULL,
    version      VARCHAR(20)  NOT NULL,
    description  TEXT         NOT NULL,
    manifest     JSON         NOT NULL,
    installed_by CHAR(36)     NOT NULL,
    status       VARCHAR(20)  NOT NULL DEFAULT 'active',
    created_at   DATETIME     NOT NULL DEFAULT NOW(),
    updated_at   DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),

    CONSTRAINT fk_ext_installed_by FOREIGN KEY (installed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_extensions (
    campaign_id  CHAR(36) NOT NULL,
    extension_id CHAR(36) NOT NULL,
    enabled      BOOLEAN  NOT NULL DEFAULT TRUE,
    applied_contents JSON DEFAULT '{}',
    enabled_at   DATETIME NOT NULL DEFAULT NOW(),
    enabled_by   CHAR(36) NULL,

    PRIMARY KEY (campaign_id, extension_id),
    CONSTRAINT fk_ce_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_ce_extension FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS extension_provenance (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id  CHAR(36)     NOT NULL,
    extension_id CHAR(36)     NOT NULL,
    table_name   VARCHAR(64)  NOT NULL,
    record_id    CHAR(36)     NOT NULL,
    record_type  VARCHAR(50)  NOT NULL DEFAULT '',
    created_at   DATETIME     NOT NULL DEFAULT NOW(),

    INDEX idx_ep_campaign_ext (campaign_id, extension_id),
    INDEX idx_ep_table_record (table_name, record_id),
    CONSTRAINT fk_ep_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_ep_extension FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS extension_data (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id  CHAR(36)     NOT NULL,
    extension_id CHAR(36)     NOT NULL,
    namespace    VARCHAR(50)  NOT NULL,
    data_key     VARCHAR(100) NOT NULL,
    data_value   JSON         NOT NULL,

    UNIQUE KEY uk_ext_data (campaign_id, extension_id, namespace, data_key),
    CONSTRAINT fk_ed_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_ed_extension FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS extension_schema_versions (
    extension_id CHAR(36) NOT NULL,
    version      INT      NOT NULL,
    applied_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (extension_id, version),
    CONSTRAINT fk_esv_extension
        FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plugin schema version tracking (built-in plugins, separate from user extensions).
-- Created here so plugin_schema.go can track versions immediately.
CREATE TABLE IF NOT EXISTS plugin_schema_versions (
    plugin_slug VARCHAR(100) NOT NULL,
    version     INT          NOT NULL,
    applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (plugin_slug, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
