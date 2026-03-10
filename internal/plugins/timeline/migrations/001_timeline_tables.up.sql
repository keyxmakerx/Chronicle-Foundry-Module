-- Timeline plugin schema: interactive visual timelines with zoom, entity
-- grouping, calendar event linking, standalone events, and connections.
-- The calendar_id FK on timelines is nullable (standalone timelines).

CREATE TABLE IF NOT EXISTS timelines (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    campaign_id      VARCHAR(36)  NOT NULL,
    calendar_id      VARCHAR(36)  DEFAULT NULL,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    description_html TEXT,
    color            VARCHAR(7)   NOT NULL DEFAULT '#6366f1',
    icon             VARCHAR(100) NOT NULL DEFAULT 'fa-timeline',
    visibility       VARCHAR(20)  NOT NULL DEFAULT 'everyone',
    visibility_rules JSON         DEFAULT NULL,
    sort_order       INT          NOT NULL DEFAULT 0,
    zoom_default     VARCHAR(20)  NOT NULL DEFAULT 'year',
    created_by       VARCHAR(36)  DEFAULT NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_timelines_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_timelines_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE SET NULL,
    INDEX idx_timelines_campaign (campaign_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timeline_event_links (
    id                  INT          AUTO_INCREMENT PRIMARY KEY,
    timeline_id         VARCHAR(36)  NOT NULL,
    event_id            VARCHAR(36)  NOT NULL,
    display_order       INT          NOT NULL DEFAULT 0,
    visibility_override VARCHAR(20)  DEFAULT NULL,
    visibility_rules    JSON         DEFAULT NULL,
    label               VARCHAR(255) DEFAULT NULL,
    color_override      VARCHAR(7)   DEFAULT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_tel_timeline FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE,
    CONSTRAINT fk_tel_event FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    UNIQUE KEY uq_timeline_event (timeline_id, event_id),
    INDEX idx_tel_timeline (timeline_id, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timeline_entity_groups (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    timeline_id VARCHAR(36)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    color       VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
    sort_order  INT          NOT NULL DEFAULT 0,

    CONSTRAINT fk_teg_timeline FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE,
    INDEX idx_teg_timeline (timeline_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timeline_entity_group_members (
    id        INT         AUTO_INCREMENT PRIMARY KEY,
    group_id  INT         NOT NULL,
    entity_id VARCHAR(36) NOT NULL,

    CONSTRAINT fk_tegm_group FOREIGN KEY (group_id) REFERENCES timeline_entity_groups(id) ON DELETE CASCADE,
    CONSTRAINT fk_tegm_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    UNIQUE KEY uq_group_entity (group_id, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Standalone timeline events (not linked to calendar events).
CREATE TABLE IF NOT EXISTS timeline_events (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    timeline_id      VARCHAR(36)  NOT NULL,
    entity_id        VARCHAR(36)  DEFAULT NULL,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    description_html TEXT         DEFAULT NULL,
    year             INT          NOT NULL,
    month            INT          NOT NULL DEFAULT 1,
    day              INT          NOT NULL DEFAULT 1,
    start_hour       INT          DEFAULT NULL,
    start_minute     INT          DEFAULT NULL,
    end_year         INT          DEFAULT NULL,
    end_month        INT          DEFAULT NULL,
    end_day          INT          DEFAULT NULL,
    end_hour         INT          DEFAULT NULL,
    end_minute       INT          DEFAULT NULL,
    is_recurring     TINYINT(1)   NOT NULL DEFAULT 0,
    recurrence_type  VARCHAR(20)  DEFAULT NULL,
    category         VARCHAR(100) DEFAULT NULL,
    visibility       VARCHAR(20)  NOT NULL DEFAULT 'everyone',
    visibility_rules JSON         DEFAULT NULL,
    display_order    INT          NOT NULL DEFAULT 0,
    label            VARCHAR(255) DEFAULT NULL,
    color            VARCHAR(7)   DEFAULT NULL,
    created_by       VARCHAR(36)  DEFAULT NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_te_timeline FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE,
    CONSTRAINT fk_te_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL,
    INDEX idx_te_timeline_date (timeline_id, year, month, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timeline_event_connections (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    timeline_id VARCHAR(36)  NOT NULL,
    source_id   VARCHAR(36)  NOT NULL,
    target_id   VARCHAR(36)  NOT NULL,
    source_type VARCHAR(20)  NOT NULL DEFAULT 'standalone',
    target_type VARCHAR(20)  NOT NULL DEFAULT 'standalone',
    label       VARCHAR(200) DEFAULT NULL,
    color       VARCHAR(7)   DEFAULT NULL,
    style       VARCHAR(20)  NOT NULL DEFAULT 'arrow',
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_tec_timeline FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE,
    UNIQUE KEY uq_tec_pair (timeline_id, source_id, target_id),
    INDEX idx_tec_timeline (timeline_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
