-- Harden PayPal OAuth state, account isolation and browser-session binding.
-- Existing state and default_user associations cannot be safely attributed to a real principal.
DELETE FROM paypal_oauth_states;
ALTER TABLE paypal_oauth_states ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE paypal_oauth_states ADD COLUMN IF NOT EXISTS session_hash TEXT;
ALTER TABLE paypal_oauth_states ADD COLUMN IF NOT EXISTS redirect_url TEXT;
ALTER TABLE paypal_oauth_states ADD COLUMN IF NOT EXISTS launch_used_at TIMESTAMPTZ;
ALTER TABLE paypal_oauth_states ALTER COLUMN session_hash SET NOT NULL;
ALTER TABLE paypal_oauth_states ALTER COLUMN redirect_url SET NOT NULL;
UPDATE paypal_connected_accounts
SET user_id = 'legacy_unassigned',
    status = 'DISCONNECTED',
    encrypted_access_token = NULL,
    encrypted_refresh_token = NULL,
    updated_at = NOW()
WHERE user_id = 'default_user';
ALTER TABLE paypal_connected_accounts ALTER COLUMN user_id DROP DEFAULT;
INSERT INTO schema_migrations(version) VALUES ('0006_paypal_oauth_hardening') ON CONFLICT DO NOTHING;
