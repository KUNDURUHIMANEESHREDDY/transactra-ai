-- Persist the evaluator decision independently from the model/adapter result.
-- Task completion must be backed by an explicit accepted decision and non-empty evidence.
ALTER TABLE orchestrator_step_runs
  ADD COLUMN evaluation_json TEXT
  CHECK (evaluation_json IS NULL OR json_valid(evaluation_json));
