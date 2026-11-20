CREATE TABLE shared_project_versions (
  version TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);

CREATE TABLE shared_project_observations (
  fingerprint TEXT PRIMARY KEY,
  version TEXT NOT NULL REFERENCES shared_project_versions(version)
);

CREATE TABLE shared_run_projects (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  version TEXT NOT NULL REFERENCES shared_project_versions(version),
  as_of_seq INTEGER NOT NULL
);
