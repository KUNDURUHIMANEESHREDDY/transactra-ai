-- Durable orchestration and owner-controlled memory.
-- Additive only: preserves existing tasks, events, runs and execution plans.
CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'telegram',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(owner_id, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_owner_updated
  ON agent_memory(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_expiry
  ON agent_memory(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_memory (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  memory_id TEXT NOT NULL REFERENCES agent_memory(id),
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(task_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_task_memory_task
  ON task_memory(task_id, captured_at);

CREATE TABLE IF NOT EXISTS orchestrator_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  status TEXT NOT NULL CHECK(status IN ('pending','leased','linked','retry','blocked','dead_letter','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 10),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_jobs_due
  ON orchestrator_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_orchestrator_jobs_lease
  ON orchestrator_jobs(lease_until) WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS orchestrator_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES orchestrator_jobs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_events_job
  ON orchestrator_events(job_id, created_at);
