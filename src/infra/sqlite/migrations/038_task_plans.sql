CREATE TABLE task_plans (
  plan_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
  quality_json TEXT NOT NULL CHECK(json_valid(quality_json)),
  workflow_hash TEXT,
  content_hash TEXT NOT NULL,
  launch_operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
;
CREATE INDEX start_run_operations_task ON start_run_operations(task_id);
;
CREATE TRIGGER task_plans_no_update BEFORE UPDATE ON task_plans BEGIN
  SELECT RAISE(ABORT, 'a reviewed task plan is immutable');
END;
;
CREATE TRIGGER task_plans_no_delete BEFORE DELETE ON task_plans BEGIN
  SELECT RAISE(ABORT, 'a reviewed task plan is immutable');
END;
