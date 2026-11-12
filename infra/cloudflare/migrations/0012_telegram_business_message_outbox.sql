-- Preserve Telegram Business connection context so replies are sent through the same authorized business connection.
-- Additive only: existing outbox rows remain valid and continue using ordinary sendMessage.
ALTER TABLE telegram_reply_outbox ADD COLUMN business_connection_id TEXT;
