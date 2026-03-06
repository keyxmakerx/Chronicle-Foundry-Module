DROP INDEX idx_users_email_verify_token ON users;

ALTER TABLE users
  DROP COLUMN pending_email,
  DROP COLUMN email_verify_token,
  DROP COLUMN email_verify_expires;
