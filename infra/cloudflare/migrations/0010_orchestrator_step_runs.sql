-- Durable per-step execution ledger for the D1-native orchestrator.
CREATE TABLE IF NOT EXISTS orchestrator_step_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 8),
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','retry','blocked','needs_review','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  lease_token TEXT,
  lease_until TEXT,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  result_text TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(task_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_step_due
  ON orchestrator_step_runs(task_id, sequence_no, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_step_lease
  ON orchestrator_step_runs(status, lease_until);
