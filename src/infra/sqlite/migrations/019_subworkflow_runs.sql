-- 019_subworkflow_runs.sql —— 子流程运行关系、pin 深度与取消请求（S3 Task 10）
-- 父运行保留 pin 版本与 resume_from；子运行用 parent_run_id / parent_node_run_id 回指，
-- root_run_id 与 subworkflow_depth 让恢复与终态闸不必递归回溯整棵树。
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(run_id);
ALTER TABLE runs ADD COLUMN parent_node_run_id TEXT;
ALTER TABLE runs ADD COLUMN root_run_id TEXT;
ALTER TABLE runs ADD COLUMN subworkflow_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN resume_from TEXT;
ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE runs ADD COLUMN cancel_result TEXT;

UPDATE runs SET root_run_id = run_id WHERE root_run_id IS NULL;

-- 一个 subworkflow 节点只能起一个子运行；重试回到同一个子运行，不另开一棵树。
CREATE UNIQUE INDEX IF NOT EXISTS runs_parent_node_uq
  ON runs(parent_node_run_id) WHERE parent_node_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
