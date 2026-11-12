ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department text NOT NULL DEFAULT 'engineering';
ALTER TABLE tasks ALTER COLUMN department DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_department_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_department_check CHECK (department IN ('orchestration','engineering','intelligence','innovation','operations','security'));
  END IF;
END $$;

ALTER TABLE tool_invocations DROP CONSTRAINT IF EXISTS tool_invocations_outcome_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_outcome_check CHECK (outcome IN ('pending','waiting_approval','succeeded','failed','denied'));

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

CREATE TABLE IF NOT EXISTS channel_state (
  channel text NOT NULL,
  state_key text NOT NULL,
  state_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel,state_key)
);

CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
  message_id text PRIMARY KEY,
  sender text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_inbox (
  message_id text PRIMARY KEY,
  sender text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_inbox_due_idx ON whatsapp_inbox(status,available_at,created_at);

CREATE TABLE IF NOT EXISTS whatsapp_usage_monthly (
  phone_number_id text NOT NULL,
  month_start date NOT NULL,
  messages_reserved integer NOT NULL DEFAULT 0 CHECK (messages_reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(phone_number_id,month_start)
);
