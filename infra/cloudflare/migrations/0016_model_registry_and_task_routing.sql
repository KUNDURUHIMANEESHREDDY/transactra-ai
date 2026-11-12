CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_model_providers_owner ON model_providers(owner_id, enabled);
CREATE TABLE IF NOT EXISTS task_model_routes (
  owner_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  model_provider_id TEXT,
  fallback_provider_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, task_type),
  FOREIGN KEY(model_provider_id) REFERENCES model_providers(id) ON DELETE SET NULL,
  FOREIGN KEY(fallback_provider_id) REFERENCES model_providers(id) ON DELETE SET NULL
);
