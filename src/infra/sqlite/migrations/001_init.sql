-- S1 最小十张表（规格 14.1 行 1150）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workflow_id TEXT,
  workflow_version INTEGER,
  session_id TEXT,
  status TEXT NOT NULL,
  display_status TEXT,
  current_run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  workflow_id TEXT,
  workflow_version INTEGER,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  node_type TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  owner_epoch INTEGER,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  started_at TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  boot_id TEXT,
  monotonic_ns INTEGER,
  run_id TEXT,
  node_run_id TEXT,
  decision_id TEXT,
  payload_redacted TEXT,
  payload_ref TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS node_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (node_run_id, seq)
);
;
CREATE TABLE IF NOT EXISTS inbox (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_expired_at TEXT
);
;
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  node_run_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  evidence_index TEXT,
  retain_until TEXT,
  created_at TEXT NOT NULL
);
;
CREATE TABLE IF NOT EXISTS report_registry (
  report_id TEXT PRIMARY KEY,
  node_run_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
;
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
;
CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id, seq, attempt);
;
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
;
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
;
CREATE INDEX IF NOT EXISTS idx_node_run_events_chain ON node_run_events(node_run_id, seq);
