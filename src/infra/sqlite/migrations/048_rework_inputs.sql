CREATE TABLE input_snapshots (
  consumer_node_run_id TEXT PRIMARY KEY REFERENCES node_runs(node_run_id),
  consumer_attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
;
CREATE TABLE artifact_consumptions (
  consumer_node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  upstream_node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  artifact_hash TEXT NOT NULL,
  consumer_attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (consumer_node_run_id, artifact_id)
);
;
CREATE INDEX artifact_consumptions_upstream ON artifact_consumptions(upstream_node_run_id);
;
CREATE TRIGGER artifact_consumptions_immutable_update BEFORE UPDATE ON artifact_consumptions BEGIN SELECT RAISE(ABORT, 'immutable artifact consumption'); END;
;
CREATE TRIGGER artifact_consumptions_immutable_delete BEFORE DELETE ON artifact_consumptions BEGIN SELECT RAISE(ABORT, 'immutable artifact consumption'); END;
;
CREATE TABLE rework_impacts (
  request_id TEXT NOT NULL REFERENCES rework_requests(request_id),
  node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  reason TEXT NOT NULL,
  replacement_node_run_id TEXT REFERENCES node_runs(node_run_id),
  released_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, node_run_id)
);
;
CREATE INDEX rework_impacts_active ON rework_impacts(node_run_id, released_at);

;
CREATE TRIGGER input_snapshots_immutable_update BEFORE UPDATE ON input_snapshots BEGIN SELECT RAISE(ABORT, 'immutable input snapshot'); END;
;
CREATE TRIGGER input_snapshots_immutable_delete BEFORE DELETE ON input_snapshots BEGIN SELECT RAISE(ABORT, 'immutable input snapshot'); END;
