CREATE TABLE execution_briefs (
  node_run_id TEXT PRIMARY KEY REFERENCES node_runs(node_run_id),
  goal TEXT NOT NULL,
  role TEXT NOT NULL,
  input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
;
CREATE TRIGGER execution_briefs_no_update BEFORE UPDATE ON execution_briefs
BEGIN SELECT RAISE(ABORT, 'immutable execution brief'); END;
;
CREATE TRIGGER execution_briefs_no_delete BEFORE DELETE ON execution_briefs
BEGIN SELECT RAISE(ABORT, 'immutable execution brief'); END;
