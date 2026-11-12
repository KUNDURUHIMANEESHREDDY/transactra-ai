-- Durable memory lifecycle, quota accounting, compaction archives and retryable Mem0 sync.
-- Additive only. Existing task, event, approval and memory rows are preserved.
CREATE TABLE IF NOT EXISTS memory_usage_monthly (
  owner_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0 CHECK(additions >= 0),
  retrievals INTEGER NOT NULL DEFAULT 0 CHECK(retrievals >= 0),
  last_add_at TEXT,
  last_retrieval_at TEXT,
  PRIMARY KEY(owner_id, month_key)
);

CREATE TABLE IF NOT EXISTS memory_compaction_state (
  owner_id TEXT PRIMARY KEY,
  active_generation INTEGER NOT NULL DEFAULT 1 CHECK(active_generation >= 1),
  last_compacted_at TEXT,
  last_compacted_month TEXT,
  last_summary_hash TEXT,
  mem0_paused_month TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_archives (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  summary TEXT NOT NULL,
  summary_hash TEXT NOT NULL,
  source_counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_memory_archives_owner_created
  ON memory_archives(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_sync_outbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  agent_scope TEXT NOT NULL DEFAULT 'transactra',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','leased','processing','retry','done','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  provider_event_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_sync_due
  ON memory_sync_outbox(status, next_attempt_at);
