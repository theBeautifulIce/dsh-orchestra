-- 017：并行扇出与汇聚（规格 3.3 行 153、5.7 行 500-505）
-- 父运行要能挡住终态，子节点要能归组、按副作用分级取消。
ALTER TABLE node_runs ADD COLUMN parent_node_run_id TEXT;
ALTER TABLE node_runs ADD COLUMN side_effect_policy TEXT NOT NULL DEFAULT 'compensable'
  CHECK (side_effect_policy IN ('pure', 'compensable', 'irreversible'));
ALTER TABLE runs ADD COLUMN settling INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN pending_irreversible_children_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_node_runs_parent ON node_runs(parent_node_run_id);
