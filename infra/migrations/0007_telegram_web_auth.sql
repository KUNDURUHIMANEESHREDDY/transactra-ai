-- Telegram Login Widget identity and server-side browser sessions.
CREATE TABLE IF NOT EXISTS telegram_web_sessions (
  session_hash TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT,
  username TEXT,
  photo_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS telegram_login_events (
  payload_hash TEXT PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telegram_login_events_expiry_idx ON telegram_login_events(consumed_at);
CREATE INDEX IF NOT EXISTS telegram_web_sessions_user_idx
  ON telegram_web_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS telegram_web_sessions_expiry_idx
  ON telegram_web_sessions(expires_at);
INSERT INTO schema_migrations(version)
VALUES ('0007_telegram_web_auth')
ON CONFLICT DO NOTHING;
