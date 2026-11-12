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
ALTER TABLE payment_workflow_steps ADD COLUMN IF NOT EXISTS step_up_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS payment_workflows_idempotency_idx
  ON payment_workflows(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_approval_challenges_idempotency_idx
  ON payment_approval_challenges(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS previous_hash TEXT;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS entry_hash TEXT;
ALTER TABLE financial_policy_audit ADD COLUMN IF NOT EXISTS entry_payload TEXT;
UPDATE financial_policy_audit SET previous_hash=COALESCE(previous_hash,'LEGACY_UNVERIFIED'),entry_hash=COALESCE(entry_hash,'LEGACY_UNVERIFIED:'||id::text),entry_payload=COALESCE(entry_payload,'{"legacy_unverified":true,"id":'||id::text||'}') WHERE previous_hash IS NULL OR entry_hash IS NULL OR entry_payload IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS financial_policy_audit_entry_hash_idx ON financial_policy_audit(entry_hash) WHERE entry_hash IS NOT NULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='financial_policy_audit_integrity_check') THEN ALTER TABLE financial_policy_audit ADD CONSTRAINT financial_policy_audit_integrity_check CHECK (previous_hash IS NOT NULL AND entry_hash IS NOT NULL AND entry_payload IS NOT NULL) NOT VALID; END IF; END $$;
ALTER TABLE financial_policy_audit VALIDATE CONSTRAINT financial_policy_audit_integrity_check;
CREATE OR REPLACE FUNCTION prevent_financial_policy_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'financial_policy_audit is append-only; UPDATE, DELETE and TRUNCATE are prohibited'; END; $$;
DROP TRIGGER IF EXISTS financial_policy_audit_no_update_delete ON financial_policy_audit;
CREATE TRIGGER financial_policy_audit_no_update_delete BEFORE UPDATE OR DELETE ON financial_policy_audit FOR EACH ROW EXECUTE FUNCTION prevent_financial_policy_audit_mutation();
DROP TRIGGER IF EXISTS financial_policy_audit_no_truncate ON financial_policy_audit;
CREATE TRIGGER financial_policy_audit_no_truncate BEFORE TRUNCATE ON financial_policy_audit FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_policy_audit_mutation();
INSERT INTO schema_migrations(version) VALUES ('0008_financial_policy_hardening') ON CONFLICT DO NOTHING;
REVOKE UPDATE, DELETE, TRUNCATE ON financial_policy_audit FROM PUBLIC;
