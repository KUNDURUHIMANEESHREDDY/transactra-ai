-- D1-native owner approval records for the Cloudflare planner.
-- Additive only: preserves all existing bridge records and execution plans.
CREATE TABLE IF NOT EXISTS task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_approvals_owner_status_expiry
  ON task_approvals(owner_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_task_approvals_task
  ON task_approvals(task_id);