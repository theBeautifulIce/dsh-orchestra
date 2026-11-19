CREATE TABLE workflow_draft_tests (
  test_id INTEGER PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  revision INTEGER NOT NULL,
  definition_hash TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  tested_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_draft_tests_workflow ON workflow_draft_tests(workflow_id, test_id DESC);
