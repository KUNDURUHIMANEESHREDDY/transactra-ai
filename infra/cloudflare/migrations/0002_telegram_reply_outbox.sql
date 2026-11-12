CREATE TABLE IF NOT EXISTS telegram_reply_outbox (
  update_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  reply_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
