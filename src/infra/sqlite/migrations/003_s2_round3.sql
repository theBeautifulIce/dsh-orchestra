-- src/infra/sqlite/migrations/003_s2_round3.sql
-- S2 第三轮审计整改：verify 判定的两列（boot_id + 单调纳秒）与工具执行痕迹表。
-- 002 一行不动，要改就新开编号。
-- 分隔规矩：单独一行一个分号（loadSteps 按 /^;\s*$/m 切句）。

ALTER TABLE node_runs ADD COLUMN verify_deadline_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN verify_deadline_monotonic_ns INTEGER;
;
-- 工具执行痕迹：每个工具跑完留一行，收口时拿它核对「这条 done 报告的证据是不是真跑出来的」
CREATE TABLE tool_executions (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  tool TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_hash TEXT,
  stderr_hash TEXT,
  command_hash TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (node_run_id, attempt, tool)
);
;
CREATE INDEX IF NOT EXISTS idx_tool_executions_node ON tool_executions(node_run_id, attempt);
;
