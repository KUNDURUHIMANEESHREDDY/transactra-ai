CREATE TABLE IF NOT EXISTS inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(source, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_events_received_at
  ON inbound_events(received_at);

CREATE TABLE IF NOT EXISTS runtime_heartbeats (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL
);
