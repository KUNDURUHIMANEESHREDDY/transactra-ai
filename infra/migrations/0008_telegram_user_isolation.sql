-- Add Telegram-user ownership to payment records and workflows.
-- These tables were historically created lazily by the API, so create them here
-- when applying migrations to a fresh database.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  user_id TEXT,
  raw_prompt TEXT NOT NULL,
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK(amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE payment_transactions
SET user_id = 'legacy_unassigned:' || id::text
WHERE user_id IS NULL OR user_id = '';
ALTER TABLE payment_transactions ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS payment_transactions_user_created_idx
  ON payment_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_workflows (
  id UUID PRIMARY KEY,
  user_id TEXT,
  raw_prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','FAILED')),
  step_count INTEGER NOT NULL CHECK(step_count BETWEEN 2 AND 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_workflows ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE payment_workflows
SET user_id = 'legacy_unassigned:' || id::text
WHERE user_id IS NULL OR user_id = '';
ALTER TABLE payment_workflows ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS payment_workflows_user_created_idx
  ON payment_workflows(user_id, created_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0008_telegram_user_isolation')
ON CONFLICT DO NOTHING;
