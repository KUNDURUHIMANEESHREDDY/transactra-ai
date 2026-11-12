-- Financial Policy Engine: transaction-bound approvals and user-scoped payment ledgers.
-- Existing legacy payment records are quarantined, never attributed to a guessed Telegram owner.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  raw_prompt TEXT NOT NULL,
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE payment_transactions SET user_id='legacy_unassigned' WHERE user_id IS NULL;
ALTER TABLE payment_transactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS approval_id UUID;
CREATE INDEX IF NOT EXISTS payment_transactions_user_created_idx ON payment_transactions(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_approval_id_idx ON payment_transactions(approval_id) WHERE approval_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_workflows (
  id UUID PRIMARY KEY,
  raw_prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','FAILED')),
  step_count INTEGER NOT NULL CHECK (step_count BETWEEN 2 AND 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_workflows ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE payment_workflows SET user_id='legacy_unassigned' WHERE user_id IS NULL;
ALTER TABLE payment_workflows ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS payment_workflows_user_created_idx ON payment_workflows(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS payment_workflow_steps (
  id UUID PRIMARY KEY,
  workflow_id UUID NOT NULL REFERENCES payment_workflows(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no BETWEEN 1 AND 8),
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  paypal_order_id TEXT UNIQUE,
  approve_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workflow_id,sequence_no)
);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES payment_workflows(id);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_step_id UUID REFERENCES payment_workflow_steps(id);

CREATE TABLE IF NOT EXISTS payment_approval_challenges (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  raw_prompt TEXT NOT NULL,
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  policy_version TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONSUMED','REJECTED','EXPIRED','DENIED')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_approval_challenges_user_expiry_idx ON payment_approval_challenges(user_id,expires_at) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS financial_policy_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  payload_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_policy_audit_user_created_idx ON financial_policy_audit(user_id,created_at DESC);
REVOKE UPDATE, DELETE ON financial_policy_audit FROM PUBLIC;
INSERT INTO schema_migrations(version) VALUES ('0007_financial_policy_engine') ON CONFLICT DO NOTHING;
