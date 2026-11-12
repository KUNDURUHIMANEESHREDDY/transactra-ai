-- Owner approval records bind an explicit decision to the exact immutable tool action.
CREATE TABLE IF NOT EXISTS orchestrator_step_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','consumed')),
  action_hash TEXT NOT NULL CHECK(length(action_hash)=64),
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT,
  notification_attempted_at TEXT,
  notified_at TEXT,
  UNIQUE(task_id, step_id),
  FOREIGN KEY(task_id, step_id) REFERENCES orchestrator_step_runs(task_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_step_approvals_owner_status
  ON orchestrator_step_approvals(owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orchestrator_step_approvals_task
  ON orchestrator_step_approvals(task_id, step_id, status);
