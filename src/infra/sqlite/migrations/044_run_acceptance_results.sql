-- P1-05 交付验收结果表：逐条交付物的验收结论（passed / failed / unverifiable）
-- 交付验收与执行终态解耦：验收不通过不改变 runs.status / node_runs.status，终态取值不变。
-- 幂等：同一 (run_id, plan_id, content_hash, deliverable_key) 重放只更新同一行。
CREATE TABLE IF NOT EXISTS run_acceptance_results (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_id TEXT NOT NULL REFERENCES task_plans(plan_id),
  content_hash TEXT NOT NULL,
  -- 验收规则版本：对验收规则 JSON 规范化后的 sha256，可复算，用于审计追溯
  rule_version TEXT NOT NULL,
  deliverable_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('artifact','tool_evidence')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','unverifiable')),
  reason TEXT,
  -- 评测证据 + 重验历史（每次重验追加一条 {outcome, evaluated_at, evidence_digest}）
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evaluated_at TEXT NOT NULL,
  UNIQUE (run_id, plan_id, content_hash, deliverable_key)
);
;

CREATE INDEX IF NOT EXISTS idx_run_acceptance_results_run ON run_acceptance_results(run_id);
;

CREATE INDEX IF NOT EXISTS idx_run_acceptance_results_plan ON run_acceptance_results(plan_id);
;
