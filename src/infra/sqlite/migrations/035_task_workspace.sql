ALTER TABLE tasks ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IN ('manual','scheduled','event','continuous'));
;
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
;
CREATE INDEX IF NOT EXISTS tasks_archive_time ON tasks (archived_at, task_id) WHERE archived_at IS NOT NULL;
;
CREATE INDEX IF NOT EXISTS runs_workflow_created ON runs (workflow_id, created_at DESC, run_id DESC);
