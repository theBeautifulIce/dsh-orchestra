-- R5-C：Agent 发起的工具调用先落 outbox，再执行。
-- 目的不是重放成功，而是崩溃后能证明「这次调用到底做没做」：pending 不许盲目重跑，
-- completed 只能把已结算的结果重发给 Agent。
CREATE TABLE bridge_tool_outbox (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  executor_agent_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_run_id, attempt, executor_agent_id, call_id)
);

CREATE INDEX bridge_tool_outbox_status
  ON bridge_tool_outbox (node_run_id, attempt, executor_agent_id, status);
