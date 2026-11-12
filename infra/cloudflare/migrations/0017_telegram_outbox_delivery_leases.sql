-- Lease claims prevent concurrent queue consumers from delivering the same Telegram outbox row.
-- Telegram sendMessage has no provider idempotency key, so ambiguous network outcomes remain at-least-once.
ALTER TABLE telegram_reply_outbox ADD COLUMN lease_token TEXT;
ALTER TABLE telegram_reply_outbox ADD COLUMN lease_until TEXT;
CREATE INDEX IF NOT EXISTS idx_telegram_reply_outbox_pending_lease
  ON telegram_reply_outbox(status, lease_until, created_at);
