-- PayPal OAuth 2.0 Connection and State Management
CREATE TABLE IF NOT EXISTS paypal_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default_user',
  redirect_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paypal_oauth_states_expiry_idx 
  ON paypal_oauth_states(expires_at) 
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS paypal_connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL DEFAULT 'default_user',
  paypal_payer_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  verified_account BOOLEAN NOT NULL DEFAULT false,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'REVOKED')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS paypal_connected_accounts_payer_idx 
  ON paypal_connected_accounts(paypal_payer_id);

INSERT INTO schema_migrations(version) VALUES ('0005_paypal_connection') ON CONFLICT DO NOTHING;
