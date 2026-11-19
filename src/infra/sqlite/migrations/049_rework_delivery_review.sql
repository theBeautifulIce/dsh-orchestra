CREATE TABLE delivery_review_holds (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  owner_actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','accepted')),
  artifact_id TEXT REFERENCES artifacts(artifact_id),
  sha256 TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id,node_id),
  CHECK ((status='accepted') = (artifact_id IS NOT NULL AND sha256 IS NOT NULL))
);

CREATE TABLE rework_local_plans (
  request_id TEXT NOT NULL REFERENCES rework_requests(request_id),
  revision INTEGER NOT NULL,
  plan_hash TEXT NOT NULL UNIQUE,
  proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  approved_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(request_id,revision)
);
