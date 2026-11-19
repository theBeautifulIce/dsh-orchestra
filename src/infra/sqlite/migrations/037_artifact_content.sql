-- Trusted host registration stores a bounded file without an external locator.
CREATE TABLE artifact_contents (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 240),
  node_run_id TEXT REFERENCES node_runs(node_run_id),
  bytes BLOB NOT NULL CHECK(typeof(bytes) = 'blob' AND length(bytes) <= 8388608)
);
;
CREATE INDEX artifacts_by_run_created ON artifacts(run_id, created_at DESC, artifact_id DESC);
