-- Sessions plugin schema: game session scheduling, linked entities, RSVP tracking.
-- The calendar_id FK references the calendar plugin's table. If the calendar
-- plugin's schema fails, this FK will also fail — sessions plugin will degrade.

CREATE TABLE IF NOT EXISTS sessions (
    id                     CHAR(36)     PRIMARY KEY,
    campaign_id            CHAR(36)     NOT NULL,
    calendar_id            VARCHAR(36)  DEFAULT NULL,
    name                   VARCHAR(200) NOT NULL,
    summary                TEXT,
    notes                  TEXT,
    notes_html             TEXT,
    recap                  TEXT         DEFAULT NULL,
    recap_html             TEXT         DEFAULT NULL,
    scheduled_date         DATE         DEFAULT NULL,
    calendar_year          INT          DEFAULT NULL,
    calendar_month         INT          DEFAULT NULL,
    calendar_day           INT          DEFAULT NULL,
    status                 VARCHAR(20)  NOT NULL DEFAULT 'planned',
    is_recurring           TINYINT(1)   NOT NULL DEFAULT 0,
    recurrence_type        VARCHAR(20)  DEFAULT NULL,
    recurrence_interval    INT          DEFAULT 1,
    recurrence_day_of_week INT          DEFAULT NULL,
    recurrence_end_date    DATE         DEFAULT NULL,
    sort_order             INT          NOT NULL DEFAULT 0,
    created_by             CHAR(36)     NOT NULL,
    created_at             DATETIME     NOT NULL,
    updated_at             DATETIME     NOT NULL,

    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT fk_sessions_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE SET NULL,
    INDEX idx_sessions_campaign (campaign_id),
    INDEX idx_sessions_scheduled (campaign_id, scheduled_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_entities (
    id         INT      AUTO_INCREMENT PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    entity_id  CHAR(36) NOT NULL,
    role       VARCHAR(50) NOT NULL DEFAULT 'mentioned',

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    UNIQUE KEY uq_session_entity (session_id, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_attendees (
    id           INT         AUTO_INCREMENT PRIMARY KEY,
    session_id   CHAR(36)    NOT NULL,
    user_id      CHAR(36)    NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'invited',
    responded_at DATETIME,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_session_attendee (session_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_rsvp_tokens (
    id         INT          AUTO_INCREMENT PRIMARY KEY,
    token      VARCHAR(64)  NOT NULL UNIQUE,
    session_id VARCHAR(36)  NOT NULL,
    user_id    VARCHAR(36)  NOT NULL,
    action     VARCHAR(20)  NOT NULL,
    used_at    DATETIME     DEFAULT NULL,
    expires_at DATETIME     NOT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_rsvp_token (token),
    INDEX idx_rsvp_session_user (session_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_session_entities_entity ON session_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_session_attendees_user ON session_attendees(user_id);
