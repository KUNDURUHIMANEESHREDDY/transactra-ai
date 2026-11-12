-- Durable AI planning records and fail-closed daily inference quota ledger.
-- Defaults are deliberately conservative internal caps; they do not assert provider free-tier eligibility.
CREATE TABLE IF NOT EXISTS execution_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  plan_version INTEGER NOT NULL DEFAULT 1 CHECK(plan_version >= 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected','executing','completed','failed')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, plan_version)
);

CREATE INDEX IF NOT EXISTS idx_execution_plans_task_created
  ON execution_plans(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_plans_status_updated
  ON execution_plans(status, updated_at);

CREATE TABLE IF NOT EXISTS inference_quota_daily (
  quota_date TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests_reserved INTEGER NOT NULL DEFAULT 0 CHECK(requests_reserved >= 0),
  requests_used INTEGER NOT NULL DEFAULT 0 CHECK(requests_used >= 0),
  tokens_reserved INTEGER NOT NULL DEFAULT 0 CHECK(tokens_reserved >= 0),
  tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
  max_requests INTEGER NOT NULL DEFAULT 10 CHECK(max_requests >= 0),
  max_tokens INTEGER NOT NULL DEFAULT 10000 CHECK(max_tokens >= 0),
  cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK(cost_microunits = 0),
  max_cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK(max_cost_microunits = 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(quota_date, provider),
  CHECK(requests_reserved + requests_used <= max_requests),
  CHECK(tokens_reserved + tokens_used <= max_tokens)
);

CREATE INDEX IF NOT EXISTS idx_inference_quota_status_date
  ON inference_quota_daily(status, quota_date);
