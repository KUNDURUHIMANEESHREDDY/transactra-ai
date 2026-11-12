-- Additive-only bridge metadata. Existing task, event, and run rows are preserved.
ALTER TABLE tasks ADD COLUMN pipeline_task_id TEXT;
ALTER TABLE tasks ADD COLUMN approval_id TEXT;
ALTER TABLE tasks ADD COLUMN pipeline_status TEXT;
ALTER TABLE tasks ADD COLUMN pipeline_synced_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_pipeline_task_id
  ON tasks(pipeline_task_id) WHERE pipeline_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_approval_id
  ON tasks(approval_id) WHERE approval_id IS NOT NULL;
