-- 014：node_run 迁移所需的挂起原因与新 attempt 链（规格 3.4 行 159-173、M-58）
ALTER TABLE node_runs ADD COLUMN hang_reason TEXT;
ALTER TABLE node_runs ADD COLUMN contradiction_decision_id TEXT;
ALTER TABLE node_runs ADD COLUMN origin_node_run_id TEXT;
ALTER TABLE node_runs ADD COLUMN replacement_node_run_id TEXT;

-- 同一 (run, node, attempt) 只能有一行；重投必须换 attempt 或 node_run_id
CREATE UNIQUE INDEX node_runs_attempt_uq ON node_runs(run_id, node_id, attempt);
-- 每个新 attempt 只能有一个来源（M-58 断言）
CREATE UNIQUE INDEX node_runs_origin_uq ON node_runs(origin_node_run_id)
  WHERE origin_node_run_id IS NOT NULL;
