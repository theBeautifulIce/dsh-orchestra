-- src/infra/sqlite/migrations/002_s2_agent_loop.sql
-- S2：单节点闭环要用的列与语义列。001 一行不动，要改就新开编号。
-- 分隔规矩：单独一行一个分号（S1 的 loadSteps 按 /^;\s*$/m 切句）。

ALTER TABLE node_runs ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN rearm_generation INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN lease_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN executor_session_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN executor_agent_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_state TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_armed_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_grace_until TEXT;
;
ALTER TABLE node_runs ADD COLUMN cancel_requested_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN cancel_result TEXT;
;
ALTER TABLE node_runs ADD COLUMN tool_start_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN deadline_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN deadline_monotonic_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN startup_unknown_deadline_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN startup_unknown_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN verify_deadline_at TEXT;
;
ALTER TABLE node_runs ADD COLUMN verify_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN side_effect_verified_none INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE node_runs ADD COLUMN stop_evidence TEXT;
;

-- report_registry：S1 建表时那列叫 status，本批改成 state 并补语义列（规格 4.2 行 301）
ALTER TABLE report_registry RENAME COLUMN status TO state;
;
ALTER TABLE report_registry ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
;
ALTER TABLE report_registry ADD COLUMN report_seq INTEGER NOT NULL DEFAULT 0;
;

CREATE INDEX IF NOT EXISTS idx_report_registry_node ON report_registry(node_run_id, attempt, report_seq);
;
CREATE INDEX IF NOT EXISTS idx_node_runs_lease ON node_runs(lease_expires_at, status);
;
