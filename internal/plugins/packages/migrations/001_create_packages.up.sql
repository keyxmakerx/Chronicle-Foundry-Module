-- Package registry: tracks external repos and their installed state.
CREATE TABLE IF NOT EXISTS packages (
    id                  CHAR(36) PRIMARY KEY,
    type                ENUM('system', 'foundry-module') NOT NULL,
    slug                VARCHAR(100) NOT NULL UNIQUE,
    name                VARCHAR(255) NOT NULL,
    repo_url            VARCHAR(500) NOT NULL,
    description         TEXT,
    installed_version   VARCHAR(50),
    pinned_version      VARCHAR(50),
    auto_update         ENUM('off', 'nightly', 'weekly', 'on_release') NOT NULL DEFAULT 'off',
    last_checked_at     DATETIME,
    last_installed_at   DATETIME,
    install_path        VARCHAR(500),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Version history: all known versions from GitHub releases.
CREATE TABLE IF NOT EXISTS package_versions (
    id              CHAR(36) PRIMARY KEY,
    package_id      CHAR(36) NOT NULL,
    version         VARCHAR(50) NOT NULL,
    tag_name        VARCHAR(100) NOT NULL,
    release_url     VARCHAR(500) NOT NULL,
    download_url    VARCHAR(500) NOT NULL,
    release_notes   TEXT,
    published_at    DATETIME NOT NULL,
    downloaded_at   DATETIME,
    file_size       BIGINT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
    UNIQUE KEY uk_package_version (package_id, version)
);

CREATE INDEX idx_package_versions_package ON package_versions(package_id, published_at DESC);
