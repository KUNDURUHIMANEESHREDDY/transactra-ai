-- Recover capture attempts after a process crash without risking a second charge.
-- PayPal capture requests use a stable transaction-scoped PayPal-Request-Id.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ;

-- Existing in-flight captures receive their last update time as the lease start.
UPDATE payment_transactions
SET capture_started_at = updated_at
WHERE status = 'CAPTURING' AND capture_started_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_transactions_capture_lease_idx
  ON payment_transactions(capture_started_at)
  WHERE status = 'CAPTURING';

INSERT INTO schema_migrations(version)
VALUES ('0009_capture_recovery_leases')
ON CONFLICT DO NOTHING;
