-- Durable owner-controlled NVIDIA service switch. Defaults OFF for every owner.
CREATE TABLE IF NOT EXISTS nvidia_runtime_control (
  owner_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
