-- Full-organization schema: dynamic agent workforce, hybrid memory + knowledge graph,
-- evidence/opportunity/project persistence, self-evolution, deployments and operations.

-- Department set now includes the self-evolution department.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_department_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_department_check
  CHECK (department IN ('orchestration','engineering','intelligence','innovation','operations','security','evolution'));

ALTER TABLE scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_department_check;
ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_department_check
  CHECK (department IN ('orchestration','engineering','intelligence','innovation','operations','security','evolution'));

-- Dynamic agent definitions extend the original agents table.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_prompt text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS evaluation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS probation_until timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'system';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_lifecycle_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_lifecycle_status_check
  CHECK (lifecycle_status IN ('probation','enabled','quarantined','disabled','retired'));

CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_lifecycle_events_agent_idx ON agent_lifecycle_events(agent_id,id);

-- Local, dependency-free embeddings plus a provenance knowledge graph.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_item_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  vector double precision[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  entity_kind text NOT NULL DEFAULT 'term' CHECK (entity_kind IN ('term','technology','organization','person','product','url')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,normalized_name,entity_kind)
);
CREATE TABLE IF NOT EXISTS memory_entity_mentions (
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  salience double precision NOT NULL DEFAULT 1 CHECK (salience >= 0 AND salience <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_item_id,entity_id)
);
CREATE INDEX IF NOT EXISTS memory_entities_owner_idx ON memory_entities(owner_id,normalized_name);
CREATE TABLE IF NOT EXISTS memory_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  from_memory_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_memory_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'related',
  weight double precision NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_memory_id,to_memory_id,relation),
  CHECK (from_memory_id <> to_memory_id)
);
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links(owner_id,from_memory_id);

-- Evidence-backed intelligence persistence.
CREATE TABLE IF NOT EXISTS research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  url text NOT NULL,
  title text NOT NULL,
  publisher text NOT NULL,
  kind text NOT NULL,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,task_id,url)
);
CREATE INDEX IF NOT EXISTS research_sources_task_idx ON research_sources(task_id,created_at);

CREATE TABLE IF NOT EXISTS evidence_items (
  id text PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  claim text NOT NULL,
  kind text NOT NULL,
  credibility double precision NOT NULL CHECK (credibility >= 0 AND credibility <= 5),
  relevance double precision NOT NULL CHECK (relevance >= 0 AND relevance <= 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_items_task_idx ON evidence_items(task_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  candidate jsonb NOT NULL,
  score jsonb NOT NULL,
  eligible boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_eligible_idx ON opportunities(owner_id,eligible,created_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  summary text NOT NULL,
  findings jsonb NOT NULL,
  recommendations jsonb NOT NULL,
  sources jsonb NOT NULL,
  scores jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_reports_time_idx ON intelligence_reports(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  name text NOT NULL,
  repository_full_name text NOT NULL UNIQUE,
  repository_url text NOT NULL,
  specification jsonb NOT NULL,
  opportunity_score jsonb NOT NULL,
  verification jsonb,
  status text NOT NULL DEFAULT 'scaffolded'
    CHECK (status IN ('scaffolded','verified','validation_failed','deployed','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Self-evolution records.
CREATE TABLE IF NOT EXISTS system_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  score integer NOT NULL CHECK (score >= 0 AND score <= 100),
  findings jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_audits_time_idx ON system_audits(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  audit_id uuid REFERENCES system_audits(id) ON DELETE SET NULL,
  title text NOT NULL,
  rationale text NOT NULL,
  changes jsonb NOT NULL,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation jsonb,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','validated','validation_failed','awaiting_approval','applied','rolled_back','rejected')),
  approval_id uuid REFERENCES approvals(id),
  applied_commits jsonb NOT NULL DEFAULT '[]'::jsonb,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evolution_proposals_status_idx ON evolution_proposals(owner_id,status,created_at DESC);

-- Deployments and operations.
CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  repository text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  workflow_file text NOT NULL,
  workflow_run_id bigint,
  commit_sha text,
  status text NOT NULL DEFAULT 'dispatched'
    CHECK (status IN ('dispatched','in_progress','succeeded','failed','cancelled','rolled_back')),
  approval_id uuid REFERENCES approvals(id),
  requested_by text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deployments_repo_idx ON deployments(owner_id,repository,created_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  incident_key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_key_idx ON incidents(owner_id,incident_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS incidents_time_idx ON incidents(owner_id,opened_at DESC);

CREATE TABLE IF NOT EXISTS system_state (
  state_key text PRIMARY KEY,
  state_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'owner',
  kind text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_due_idx ON notifications(status,available_at);
CREATE INDEX IF NOT EXISTS notifications_locked_idx ON notifications(status,locked_until);

CREATE TABLE IF NOT EXISTS organization_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  cycle_key text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  tasks_enqueued integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(owner_id,cycle_key)
);
CREATE INDEX IF NOT EXISTS organization_cycles_time_idx ON organization_cycles(owner_id,started_at DESC);
