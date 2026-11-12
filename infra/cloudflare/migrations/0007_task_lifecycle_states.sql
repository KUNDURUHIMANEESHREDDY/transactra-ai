-- Expand task/run lifecycle states used by the Telegram planner bridge.
-- Rebuild parent and child tables together so foreign keys remain valid.
-- All existing records and identifiers are copied unchanged.

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('telegram')),
  source_event_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'awaiting_provider','awaiting_pipeline','waiting_approval',
    'queued','running','succeeded','failed','cancelled'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pipeline_task_id TEXT,
  approval_id TEXT,
  pipeline_status TEXT,
  pipeline_synced_at TEXT,
  UNIQUE(source, source_event_id)
);

CREATE TABLE task_runs_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks_new(id),
  state TEXT NOT NULL CHECK(state IN (
    'awaiting_provider','awaiting_pipeline','waiting_approval',
    'queued','running','succeeded','failed','cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE task_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks_new(id),
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE task_run_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES task_runs_new(id),
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO tasks_new (
  id,source,source_event_id,owner_id,description,status,created_at,updated_at,
  pipeline_task_id,approval_id,pipeline_status,pipeline_synced_at
)
SELECT
  id,source,source_event_id,owner_id,description,status,created_at,updated_at,
  pipeline_task_id,approval_id,pipeline_status,pipeline_synced_at
FROM tasks;

INSERT INTO task_runs_new (
  id,task_id,state,attempt_count,max_attempts,last_error,created_at,updated_at,started_at,completed_at
)
SELECT
  id,task_id,state,attempt_count,max_attempts,last_error,created_at,updated_at,started_at,completed_at
FROM task_runs;

INSERT INTO task_events_new (id,task_id,event_type,detail,created_at)
SELECT id,task_id,event_type,detail,created_at FROM task_events;

INSERT INTO task_run_events_new (id,run_id,event_type,detail,created_at)
SELECT id,run_id,event_type,detail,created_at FROM task_run_events;

DROP TABLE task_run_events;
DROP TABLE task_events;
DROP TABLE task_runs;
DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE task_runs_new RENAME TO task_runs;
ALTER TABLE task_events_new RENAME TO task_events;
ALTER TABLE task_run_events_new RENAME TO task_run_events;

CREATE INDEX IF NOT EXISTS idx_tasks_status_created
  ON tasks(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_pipeline_task_id
  ON tasks(pipeline_task_id) WHERE pipeline_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_approval_id
  ON tasks(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_runs_state_updated
  ON task_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_type
  ON task_events(task_id, event_type);
CREATE INDEX IF NOT EXISTS idx_task_run_events_run_created
  ON task_run_events(run_id, created_at);
