CREATE TABLE collaboration_scopes (
  scope_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_actor TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
;
CREATE INDEX collaboration_scope_owner ON collaboration_scopes (owner_actor, created_at DESC, scope_id DESC);
;
CREATE TABLE collaboration_members (
  scope_id TEXT NOT NULL REFERENCES collaboration_scopes(scope_id),
  node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  PRIMARY KEY (scope_id, node_run_id)
);
;
CREATE INDEX collaboration_members_by_node ON collaboration_members (node_run_id, scope_id);
;
CREATE TABLE collaboration_findings (
  finding_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES collaboration_scopes(scope_id),
  source_node_run_id TEXT NOT NULL,
  source_attempt INTEGER NOT NULL CHECK (source_attempt > 0),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES tool_executions(execution_id),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_id, fingerprint),
  UNIQUE (scope_id, finding_id),
  FOREIGN KEY (scope_id, source_node_run_id) REFERENCES collaboration_members(scope_id, node_run_id)
);
;
CREATE INDEX collaboration_findings_by_source ON collaboration_findings (source_node_run_id, source_attempt, source_generation, created_at DESC, finding_id DESC);
;
CREATE TABLE collaboration_requests (
  request_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES collaboration_scopes(scope_id),
  finding_id TEXT NOT NULL,
  target_node_run_id TEXT NOT NULL,
  target_attempt INTEGER CHECK (target_attempt > 0),
  target_generation INTEGER CHECK (target_generation >= 0),
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','authorized','delivered','accepted','completed','rejected','denied','expired')),
  revision INTEGER NOT NULL DEFAULT 1,
  authorization_note TEXT,
  delivered_at TEXT,
  accepted_at TEXT,
  accepted_chain_seq INTEGER CHECK (accepted_chain_seq >= 0),
  result TEXT,
  evidence_id TEXT REFERENCES tool_executions(execution_id),
  verdict TEXT CHECK (verdict IN ('confirmed','refuted','inconclusive')),
  adoption TEXT CHECK (adoption IN ('adopted', 'dismissed')),
  adoption_note TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scope_id, target_node_run_id) REFERENCES collaboration_members(scope_id, node_run_id),
  FOREIGN KEY (scope_id, finding_id) REFERENCES collaboration_findings(scope_id, finding_id),
  UNIQUE (finding_id, target_node_run_id),
  CHECK ((target_attempt IS NULL) = (target_generation IS NULL)),
  CHECK (status NOT IN ('delivered','accepted','completed','rejected') OR (target_attempt IS NOT NULL AND delivered_at IS NOT NULL)),
  CHECK (status NOT IN ('accepted','completed') OR (accepted_at IS NOT NULL AND accepted_chain_seq IS NOT NULL)),
  CHECK (status <> 'completed' OR (result IS NOT NULL AND verdict IS NOT NULL AND evidence_id IS NOT NULL)),
  CHECK (adoption IS NULL OR (status = 'completed' AND adoption_note IS NOT NULL))
);
;
CREATE INDEX collaboration_requests_inbox ON collaboration_requests (target_node_run_id, status, expires_at);
;
CREATE INDEX collaboration_requests_due ON collaboration_requests (expires_at, request_id) WHERE status IN ('proposed','authorized','delivered','accepted');
