CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('telegram')),
  source_event_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting_provider','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created
  ON tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events(task_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_type
  ON task_events(task_id, event_type);
