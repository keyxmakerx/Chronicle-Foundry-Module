-- Campaign invite system: email-based invitations with one-click accept.
CREATE TABLE IF NOT EXISTS campaign_invites (
    id          CHAR(36)     NOT NULL,
    campaign_id CHAR(36)     NOT NULL,
    email       VARCHAR(255) NOT NULL,
    role        VARCHAR(20)  NOT NULL DEFAULT 'player',
    token       VARCHAR(64)  NOT NULL,
    created_by  CHAR(36)     NOT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME     NOT NULL,
    accepted_at DATETIME     DEFAULT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_invite_token (token),
    INDEX idx_invite_campaign (campaign_id),
    INDEX idx_invite_email (email),
    CONSTRAINT fk_invite_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_invite_created_by FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT chk_invite_role CHECK (role IN ('player', 'scribe'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
