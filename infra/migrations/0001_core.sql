CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_subject text UNIQUE, display_name text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, name text NOT NULL, department text NOT NULL, definition_version integer NOT NULL DEFAULT 1 CHECK (definition_version > 0), lifecycle_status text NOT NULL DEFAULT 'enabled' CHECK (lifecycle_status IN ('enabled','disabled','retired')), max_concurrent_tasks integer NOT NULL DEFAULT 1 CHECK (max_concurrent_tasks > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id), title text NOT NULL, objective text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled')), risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')), priority integer NOT NULL DEFAULT 100, idempotency_key text NOT NULL, requested_by jsonb NOT NULL, assigned_agent_id text REFERENCES agents(id), attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0), max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0), available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_until timestamptz, deadline_at timestamptz, result jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,idempotency_key), CHECK ((lease_owner IS NULL) = (lease_until IS NULL)));
CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks(status,available_at,priority,created_at);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS task_events (id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id,id);
CREATE TABLE IF NOT EXISTS approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id), task_id uuid REFERENCES tasks(id), action_hash text NOT NULL, action jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')), requested_by text NOT NULL, decided_by text, decision_reason text, expires_at timestamptz NOT NULL, decided_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals(owner_id,expires_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS tool_invocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid REFERENCES tasks(id), actor_id text NOT NULL, capability text NOT NULL, resource text NOT NULL, input_hash text NOT NULL, policy_version text NOT NULL, allowed boolean NOT NULL, approval_id uuid REFERENCES approvals(id), outcome text NOT NULL CHECK (outcome IN ('pending','waiting_approval','succeeded','failed','denied')), correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE INDEX IF NOT EXISTS tool_invocations_task_idx ON tool_invocations(task_id,created_at);
CREATE TABLE IF NOT EXISTS provider_health (id bigserial PRIMARY KEY, provider text NOT NULL, model text NOT NULL, status text NOT NULL CHECK (status IN ('healthy','degraded','unavailable','unconfigured')), latency_ms integer, failure_reason text, observed_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS provider_health_latest_idx ON provider_health(provider,model,observed_at DESC);
CREATE TABLE IF NOT EXISTS memory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id), project_id text, content text NOT NULL, content_hash text NOT NULL, source_type text NOT NULL, source_ref text, sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','confidential')), retention_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,content_hash));
CREATE INDEX IF NOT EXISTS memory_owner_idx ON memory_items(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS memory_items_fts_idx ON memory_items USING GIN (to_tsvector('simple',content));
CREATE TABLE IF NOT EXISTS audit_events (id bigserial PRIMARY KEY, owner_id uuid REFERENCES owners(id), actor_id text NOT NULL, action text NOT NULL, resource text NOT NULL, outcome text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_events_time_idx ON audit_events(created_at DESC);
INSERT INTO schema_migrations(version) VALUES ('0001_core') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS provider_usage_monthly (
  provider text NOT NULL,
  month_key date NOT NULL,
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,month_key)
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  job_key text NOT NULL,
  department text NOT NULL CHECK (department IN ('orchestration','engineering','intelligence','innovation','operations','security')),
  title text NOT NULL,
  objective text NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,job_key)
);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(enabled,next_run_at) WHERE enabled=true;

CREATE TABLE IF NOT EXISTS search_usage_monthly (
  provider text NOT NULL,
  month_start date NOT NULL,
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,month_start)
);
