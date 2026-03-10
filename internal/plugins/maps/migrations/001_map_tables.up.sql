-- Maps plugin schema: interactive maps with markers, layers, drawings,
-- tokens, and fog of war.

CREATE TABLE IF NOT EXISTS maps (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    campaign_id      VARCHAR(36)  NOT NULL,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    image_id         VARCHAR(36)  DEFAULT NULL,
    image_width      INT          NOT NULL DEFAULT 0,
    image_height     INT          NOT NULL DEFAULT 0,
    sort_order       INT          NOT NULL DEFAULT 0,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    grid_type        VARCHAR(20)  DEFAULT 'none',
    grid_size        DECIMAL(8,4) DEFAULT 50.0,
    grid_color       VARCHAR(7)   DEFAULT '#000000',
    grid_opacity     DECIMAL(3,2) DEFAULT 0.2,
    background_color VARCHAR(7)   DEFAULT '#222222',
    fog_exploration  BOOLEAN      DEFAULT FALSE,
    initial_view_x   DECIMAL(8,4) DEFAULT 50.0,
    initial_view_y   DECIMAL(8,4) DEFAULT 50.0,
    initial_zoom     DECIMAL(5,3) DEFAULT 1.0,
    foundry_scene_id VARCHAR(255) DEFAULT NULL,

    CONSTRAINT fk_maps_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_maps_image FOREIGN KEY (image_id) REFERENCES media_files(id) ON DELETE SET NULL,
    INDEX idx_maps_campaign (campaign_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_markers (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    map_id      VARCHAR(36)  NOT NULL,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    x           DOUBLE       NOT NULL DEFAULT 50,
    y           DOUBLE       NOT NULL DEFAULT 50,
    icon        VARCHAR(100) NOT NULL DEFAULT 'fa-map-pin',
    color       VARCHAR(7)   NOT NULL DEFAULT '#3b82f6',
    entity_id   VARCHAR(36)  DEFAULT NULL,
    visibility  VARCHAR(20)  NOT NULL DEFAULT 'everyone',
    created_by  VARCHAR(36)  DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_markers_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
    CONSTRAINT fk_markers_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL,
    INDEX idx_markers_map (map_id),
    INDEX idx_markers_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_layers (
    id         CHAR(36)     NOT NULL PRIMARY KEY,
    map_id     CHAR(36)     NOT NULL,
    name       VARCHAR(200) NOT NULL,
    layer_type VARCHAR(50)  NOT NULL,
    sort_order INT          NOT NULL DEFAULT 0,
    is_visible BOOLEAN      NOT NULL DEFAULT TRUE,
    opacity    DECIMAL(3,2) NOT NULL DEFAULT 1.00,
    is_locked  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_layer_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
    INDEX idx_layer_map (map_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_drawings (
    id           CHAR(36)     NOT NULL PRIMARY KEY,
    map_id       CHAR(36)     NOT NULL,
    layer_id     CHAR(36)     DEFAULT NULL,
    drawing_type VARCHAR(50)  NOT NULL,
    points       JSON         NOT NULL,
    stroke_color VARCHAR(7)   NOT NULL DEFAULT '#000000',
    stroke_width DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    fill_color   VARCHAR(7)   DEFAULT NULL,
    fill_alpha   DECIMAL(3,2) NOT NULL DEFAULT 0.5,
    text_content TEXT         DEFAULT NULL,
    font_size    INT          DEFAULT NULL,
    rotation     DECIMAL(6,2) NOT NULL DEFAULT 0,
    visibility   VARCHAR(20)  NOT NULL DEFAULT 'everyone',
    created_by   CHAR(36)     DEFAULT NULL,
    foundry_id   VARCHAR(255) DEFAULT NULL,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_drawing_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
    CONSTRAINT fk_drawing_layer FOREIGN KEY (layer_id) REFERENCES map_layers(id) ON DELETE SET NULL,
    INDEX idx_drawing_map (map_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_tokens (
    id               CHAR(36)     NOT NULL PRIMARY KEY,
    map_id           CHAR(36)     NOT NULL,
    layer_id         CHAR(36)     DEFAULT NULL,
    entity_id        CHAR(36)     DEFAULT NULL,
    name             VARCHAR(200) NOT NULL,
    image_path       VARCHAR(500) DEFAULT NULL,
    x                DECIMAL(8,4) NOT NULL,
    y                DECIMAL(8,4) NOT NULL,
    width            DECIMAL(8,4) NOT NULL DEFAULT 1.0,
    height           DECIMAL(8,4) NOT NULL DEFAULT 1.0,
    rotation         DECIMAL(6,2) NOT NULL DEFAULT 0,
    scale            DECIMAL(5,3) NOT NULL DEFAULT 1.0,
    is_hidden        BOOLEAN      NOT NULL DEFAULT FALSE,
    is_locked        BOOLEAN      NOT NULL DEFAULT FALSE,
    bar1_value       INT          DEFAULT NULL,
    bar1_max         INT          DEFAULT NULL,
    bar2_value       INT          DEFAULT NULL,
    bar2_max         INT          DEFAULT NULL,
    aura_radius      DECIMAL(8,4) DEFAULT NULL,
    aura_color       VARCHAR(7)   DEFAULT NULL,
    light_radius     DECIMAL(8,4) DEFAULT NULL,
    light_dim_radius DECIMAL(8,4) DEFAULT NULL,
    light_color      VARCHAR(7)   DEFAULT NULL,
    vision_enabled   BOOLEAN      NOT NULL DEFAULT FALSE,
    vision_range     DECIMAL(8,4) DEFAULT NULL,
    elevation        INT          NOT NULL DEFAULT 0,
    sort_order       INT          NOT NULL DEFAULT 0,
    status_effects   JSON         DEFAULT NULL,
    flags            JSON         DEFAULT NULL,
    foundry_id       VARCHAR(255) DEFAULT NULL,
    created_by       CHAR(36)     DEFAULT NULL,
    created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_token_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
    CONSTRAINT fk_token_layer FOREIGN KEY (layer_id) REFERENCES map_layers(id) ON DELETE SET NULL,
    CONSTRAINT fk_token_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL,
    INDEX idx_token_map (map_id),
    INDEX idx_token_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_fog (
    id          CHAR(36)  NOT NULL PRIMARY KEY,
    map_id      CHAR(36)  NOT NULL,
    points      JSON      NOT NULL,
    is_explored BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_fog_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
    INDEX idx_fog_map (map_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
