-- Harden PayPal OAuth ownership and bind every authorization attempt to a gateway session.
-- Pending states created before this migration are invalidated because they cannot be
-- proven to belong to the browser session that initiated them.
DELETE FROM paypal_oauth_states;

ALTER TABLE paypal_oauth_states
  ADD COLUMN IF NOT EXISTS session_hash TEXT;

UPDATE paypal_oauth_states SET session_hash = '' WHERE session_hash IS NULL;
ALTER TABLE paypal_oauth_states
  ALTER COLUMN session_hash SET NOT NULL,
  ALTER COLUMN user_id DROP DEFAULT;

ALTER TABLE paypal_connected_accounts
  ALTER COLUMN user_id DROP DEFAULT;

-- The old shared default_user association cannot be attributed to a real user.
-- Quarantine it and erase its credentials rather than silently assigning it to anyone.
UPDATE paypal_connected_accounts
SET user_id = 'legacy_unassigned:' || id::text,
    status = 'DISCONNECTED',
    encrypted_access_token = NULL,
    encrypted_refresh_token = NULL,
    token_expires_at = NULL,
    updated_at = NOW()
WHERE user_id = 'default_user';

CREATE INDEX IF NOT EXISTS paypal_oauth_states_session_idx
  ON paypal_oauth_states(session_hash, expires_at)
  WHERE used_at IS NULL;

INSERT INTO schema_migrations(version)
VALUES ('0006_paypal_oauth_security')
ON CONFLICT DO NOTHING;
