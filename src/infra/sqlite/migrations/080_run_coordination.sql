-- A bounded, attempt-bound coordination mailbox. No workflow or acceptance state is written here.
CREATE TABLE run_coordination (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  source_node TEXT NOT NULL REFERENCES node_runs(node_run_id),
  source_attempt INTEGER NOT NULL, source_generation INTEGER NOT NULL, source_session TEXT NOT NULL,
  target_node TEXT REFERENCES node_runs(node_run_id), target_attempt INTEGER, target_generation INTEGER, target_session TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('request','finding','handoff','blocker')),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  state TEXT NOT NULL CHECK(state IN ('pending','recorded','reported','answered','expired','unavailable','withdrawn','acknowledged')),
  reply TEXT CHECK(reply IS NULL OR length(reply) BETWEEN 1 AND 500),
  reason TEXT, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  dedup TEXT NOT NULL UNIQUE, mac TEXT NOT NULL,
  CHECK((target_node IS NULL AND target_attempt IS NULL AND target_generation IS NULL AND target_session IS NULL)
     OR (target_node IS NOT NULL AND target_attempt IS NOT NULL AND target_generation IS NOT NULL AND target_session IS NOT NULL)),
  CHECK(source_node <> target_node OR target_node IS NULL)
);
;
CREATE INDEX run_coordination_run ON run_coordination(run_id, created_ms, id);
;
CREATE INDEX run_coordination_pending ON run_coordination(expires_ms, id) WHERE state='pending';
;
CREATE INDEX run_coordination_pending_cursor ON run_coordination(id) WHERE state='pending';
