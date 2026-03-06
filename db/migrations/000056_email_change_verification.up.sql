-- Add email change verification columns to users table.
-- Flow: user requests email change -> pending_email + token stored -> verification
-- link sent to NEW email -> user clicks link -> email updated.
ALTER TABLE users
  ADD COLUMN pending_email         VARCHAR(255) DEFAULT NULL,
  ADD COLUMN email_verify_token    CHAR(64)     DEFAULT NULL,
  ADD COLUMN email_verify_expires  DATETIME     DEFAULT NULL;

-- Index for token lookup during verification.
CREATE UNIQUE INDEX idx_users_email_verify_token ON users (email_verify_token);
