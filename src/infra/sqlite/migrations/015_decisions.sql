-- 015：把八种 decision 落成表里的一等行（规格 3.6）
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'pre_execution', 'action_overrun', 'abandon_ack', 'verify_human',
    'audit_result', 'rule_ambiguous', 'startup_unknown', 'report_contradicted'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'acknowledged', 'blocked_for_human', 'resolved', 'superseded'
  )),
  revision INTEGER NOT NULL,
  closed_reason TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

-- 同一 run 的同一 run 级 kind 只能有一张活跃卡；node_run_id 为 NULL 的普通 UNIQUE 不生效
CREATE UNIQUE INDEX decisions_run_kind_uq ON decisions(run_id, kind)
  WHERE node_run_id IS NULL AND status IN ('pending', 'acknowledged', 'blocked_for_human');

-- 同一节点的同一 kind 只能有一张活跃卡
CREATE UNIQUE INDEX decisions_node_kind_uq ON decisions(node_run_id, kind)
  WHERE node_run_id IS NOT NULL AND status IN ('pending', 'acknowledged', 'blocked_for_human');

CREATE INDEX decisions_run_status_idx ON decisions(run_id, status);
