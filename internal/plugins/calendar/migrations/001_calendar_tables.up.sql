-- Calendar plugin schema: custom calendars with non-Gregorian months, moons,
-- eras, seasons, events, and event categories. Multi-calendar per campaign.

CREATE TABLE IF NOT EXISTS calendars (
    id                 VARCHAR(36)  NOT NULL PRIMARY KEY,
    campaign_id        VARCHAR(36)  NOT NULL,
    mode               VARCHAR(20)  NOT NULL DEFAULT 'fantasy',
    name               VARCHAR(255) NOT NULL DEFAULT 'Campaign Calendar',
    description        TEXT,
    epoch_name         VARCHAR(100) DEFAULT NULL,
    sort_order         INT          NOT NULL DEFAULT 0,
    is_default         TINYINT(1)   NOT NULL DEFAULT 0,
    current_year       INT          NOT NULL DEFAULT 1,
    current_month      INT          NOT NULL DEFAULT 1,
    current_day        INT          NOT NULL DEFAULT 1,
    hours_per_day      INT          NOT NULL DEFAULT 24,
    minutes_per_hour   INT          NOT NULL DEFAULT 60,
    seconds_per_minute INT          NOT NULL DEFAULT 60,
    current_hour       INT          NOT NULL DEFAULT 0,
    current_minute     INT          NOT NULL DEFAULT 0,
    leap_year_every    INT          NOT NULL DEFAULT 0,
    leap_year_offset   INT          NOT NULL DEFAULT 0,
    created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_calendars_campaign (campaign_id),
    CONSTRAINT fk_calendars_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_months (
    id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    calendar_id    VARCHAR(36)  NOT NULL,
    name           VARCHAR(100) NOT NULL,
    days           INT          NOT NULL DEFAULT 30,
    sort_order     INT          NOT NULL DEFAULT 0,
    is_intercalary TINYINT(1)   NOT NULL DEFAULT 0,
    leap_year_days INT          NOT NULL DEFAULT 0,

    CONSTRAINT fk_cal_months_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    INDEX idx_cal_months_order (calendar_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_weekdays (
    id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    calendar_id VARCHAR(36)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    sort_order  INT          NOT NULL DEFAULT 0,

    CONSTRAINT fk_cal_weekdays_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    INDEX idx_cal_weekdays_order (calendar_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_moons (
    id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    calendar_id  VARCHAR(36)  NOT NULL,
    name         VARCHAR(100) NOT NULL,
    cycle_days   FLOAT        NOT NULL DEFAULT 29.5,
    phase_offset FLOAT        NOT NULL DEFAULT 0,
    color        VARCHAR(7)   NOT NULL DEFAULT '#c0c0c0',

    CONSTRAINT fk_cal_moons_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    INDEX idx_cal_moons_calendar (calendar_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_seasons (
    id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    calendar_id    VARCHAR(36)  NOT NULL,
    name           VARCHAR(100) NOT NULL,
    start_month    INT          NOT NULL,
    start_day      INT          NOT NULL,
    end_month      INT          NOT NULL,
    end_day        INT          NOT NULL,
    description    TEXT,
    color          VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
    weather_effect VARCHAR(200) DEFAULT NULL,

    CONSTRAINT fk_cal_seasons_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    INDEX idx_cal_seasons_calendar (calendar_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_events (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    calendar_id      VARCHAR(36)  NOT NULL,
    entity_id        VARCHAR(36)  DEFAULT NULL,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    description_html TEXT         DEFAULT NULL,
    year             INT          NOT NULL,
    month            INT          NOT NULL,
    day              INT          NOT NULL,
    start_hour       INT          DEFAULT NULL,
    start_minute     INT          DEFAULT NULL,
    end_year         INT          DEFAULT NULL,
    end_month        INT          DEFAULT NULL,
    end_day          INT          DEFAULT NULL,
    end_hour         INT          DEFAULT NULL,
    end_minute       INT          DEFAULT NULL,
    is_recurring     TINYINT(1)   NOT NULL DEFAULT 0,
    recurrence_type  VARCHAR(20)  DEFAULT NULL,
    visibility       VARCHAR(20)  NOT NULL DEFAULT 'everyone',
    visibility_rules JSON         DEFAULT NULL,
    category         VARCHAR(50)  DEFAULT NULL,
    created_by       VARCHAR(36)  DEFAULT NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_cal_events_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    CONSTRAINT fk_cal_events_entity FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL,
    INDEX idx_cal_events_date (calendar_id, year, month, day),
    INDEX idx_cal_events_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_event_categories (
    id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    calendar_id VARCHAR(36)  NOT NULL,
    slug        VARCHAR(50)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    icon        VARCHAR(10)  NOT NULL DEFAULT '',
    color       VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
    sort_order  INT          NOT NULL DEFAULT 0,

    UNIQUE KEY idx_calendar_category_slug (calendar_id, slug),
    CONSTRAINT fk_event_categories_calendar FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_eras (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    calendar_id VARCHAR(36)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    start_year  INT          NOT NULL,
    end_year    INT          DEFAULT NULL,
    description TEXT         DEFAULT NULL,
    color       VARCHAR(20)  NOT NULL DEFAULT '#6366f1',
    sort_order  INT          NOT NULL DEFAULT 0,

    FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
    INDEX idx_eras_calendar (calendar_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
