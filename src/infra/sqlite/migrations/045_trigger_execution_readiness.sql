-- 触发执行就绪态：把"规则已配置 / 触发已发生 / 执行器未就绪 / 运行已派发"落成可查询的一行。
-- occurrence_key 为空串表示规则当前就绪态，非空表示某一次触发（occurrence）的历史态；
-- 状态迁移幂等，同一个触发重放不会多出一行。
CREATE TABLE task_trigger_execution_state (
  trigger_id TEXT NOT NULL REFERENCES task_triggers(trigger_id),
  occurrence_key TEXT NOT NULL DEFAULT '',
  run_id TEXT REFERENCES runs(run_id),
  state TEXT NOT NULL CHECK (state IN ('configured', 'fired', 'executor_not_ready', 'dispatched')),
  reason TEXT,
  fired_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, occurrence_key)
);
;
CREATE INDEX task_trigger_execution_state_run ON task_trigger_execution_state(run_id);
