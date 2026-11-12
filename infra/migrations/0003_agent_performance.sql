-- Supports 30-day agent execution evaluation from step lifecycle events.
CREATE INDEX IF NOT EXISTS task_events_agent_performance_idx
  ON task_events(created_at,actor_id,task_id)
  WHERE event_type IN ('task.step_started','task.step_completed','task.step_failed','task.step_waiting_approval');
