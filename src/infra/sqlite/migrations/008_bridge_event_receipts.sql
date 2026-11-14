-- R5-B：桥事件收据与按 attempt/agent 隔离的持久确认游标
-- 游标只在账本事务提交时推进；receipt 用来做同 seq 幂等与 payload 冲突检测。

CREATE TABLE bridge_stream_cursors (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  executor_agent_id TEXT NOT NULL,
  last_persisted_ack_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_run_id, attempt, executor_agent_id)
);

CREATE TABLE bridge_event_receipts (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  executor_agent_id TEXT NOT NULL,
  bridge_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  ledger_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_run_id, attempt, executor_agent_id, bridge_seq)
);
