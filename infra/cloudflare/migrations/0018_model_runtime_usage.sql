ALTER TABLE model_providers ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 512;
CREATE TABLE IF NOT EXISTS model_usage_daily (
  owner_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  requests_reserved INTEGER NOT NULL DEFAULT 0,
  requests_used INTEGER NOT NULL DEFAULT 0,
  tokens_reserved INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  max_requests INTEGER NOT NULL DEFAULT 100,
  max_tokens INTEGER NOT NULL DEFAULT 50000,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, provider_id, usage_date),
  FOREIGN KEY(provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
);
