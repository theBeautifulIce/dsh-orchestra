-- 018：等待节点（规格 5.8 行 507-513）
-- 事件先落独立 inbox，wait_registrations 与状态迁移同事务；按 cursor 回放补早到事件。
ALTER TABLE node_runs ADD COLUMN wait_started_at TEXT;
ALTER TABLE node_runs ADD COLUMN wait_deadline_at TEXT;

CREATE TABLE IF NOT EXISTS wait_event_inbox (
  inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wait_event_inbox_run ON wait_event_inbox(run_id, inbox_seq);

CREATE TABLE IF NOT EXISTS wait_registrations (
  registration_id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_run_id TEXT NOT NULL UNIQUE REFERENCES node_runs(node_run_id),
  run_id TEXT NOT NULL,
  wait_kind TEXT NOT NULL CHECK (wait_kind IN ('event', 'timer')),
  match_json TEXT NOT NULL,
  from_seq INTEGER NOT NULL DEFAULT 0,
  cursor_seq INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'woken', 'timed_out', 'cancelled')),
  matched_event_seq INTEGER,
  matched_payload_json TEXT,
  woke_at TEXT,
  queued_at TEXT,
  wake_dispatch_starvation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wait_registrations_run_state ON wait_registrations(run_id, state);
