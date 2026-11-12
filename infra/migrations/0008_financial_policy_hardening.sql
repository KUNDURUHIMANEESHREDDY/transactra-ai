-- Additional financial policy controls, step-up confirmation, idempotency, and tamper-evident audit chaining.
CREATE TABLE IF NOT EXISTS financial_user_policies (
  user_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  max_transaction_amount NUMERIC(18,2) NOT NULL CHECK (max_transaction_amount > 0),
  max_daily_amount NUMERIC(18,2) NOT NULL CHECK (max_daily_amount > 0),
  max_daily_transactions INTEGER NOT NULL CHECK (max_daily_transactions > 0),
  high_value_threshold NUMERIC(18,2) NOT NULL CHECK (high_value_threshold > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_approval_challenges ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_approval_challenges ADD COLUMN IF NOT EXISTS requires_step_up BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payment_approval_challenges ADD COLUMN IF NOT EXISTS step_up_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payment_approval_challenges ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payment_workflows ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_workflows_idempotency_idx
  ON payment_workflows(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_approval_challenges_idempotency_idx
  ON payment_approval_challenges(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS previous_hash TEXT;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS entry_hash TEXT;
INSERT INTO schema_migrations(version) VALUES ('0008_financial_policy_hardening') ON CONFLICT DO NOTHING;
REVOKE UPDATE, DELETE ON financial_policy_audit FROM PUBLIC;
