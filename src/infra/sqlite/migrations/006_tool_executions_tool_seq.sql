-- src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql
-- 工具执行痕迹补唯一身份：tool_seq（同一次 attempt 内的第几次执行）+ execution_id（全局唯一）。
-- 003 的主键是 (node_run_id, attempt, tool)，同一次 attempt 里同名工具只能留一行：
-- 第二次执行撞主键、异常走工具失败处理，正常重复调用会把节点错误阻塞（评审《第二次意见.md》P1）。
-- SQLite 不能改已有表的主键、也不能 ALTER ADD UNIQUE 列，所以这里重建表；003 一行不动。
-- 旧行按稳定顺序（tool、started_at、finished_at、rowid）补 tool_seq（1 起）与 execution_id。
-- 分隔规矩：单独一行一个分号（loadSteps 按 /^;\s*$/m 切句）。

CREATE TABLE tool_executions_new (
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  -- 同一次 attempt 里的第几次工具执行：1 起，按调用次序排
  tool_seq INTEGER NOT NULL DEFAULT 0,
  tool TEXT NOT NULL,
  -- 每次工具执行的唯一身份：tool_started / tool_finished 事件与证据回执都绑它
  execution_id TEXT NOT NULL UNIQUE DEFAULT ('tex_' || lower(hex(randomblob(16)))),
  exit_code INTEGER NOT NULL,
  stdout_hash TEXT,
  stderr_hash TEXT,
  command_hash TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (node_run_id, attempt, tool_seq)
);
;
-- 旧行迁移：tool_seq 按 (node_run_id, attempt) 分区、从 1 起稳定编号；
-- execution_id 由这三段拼出，同一库里不会与新写入的行重号
INSERT INTO tool_executions_new (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at)
SELECT node_run_id, attempt, seq, tool, 'texm_' || node_run_id || '#' || attempt || '#' || seq, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at
FROM (
  SELECT node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at,
         ROW_NUMBER() OVER (PARTITION BY node_run_id, attempt ORDER BY tool ASC, started_at ASC, finished_at ASC, rowid ASC) AS seq
  FROM tool_executions
) AS legacy;
;
DROP TABLE tool_executions;
;
ALTER TABLE tool_executions_new RENAME TO tool_executions;
;
CREATE INDEX IF NOT EXISTS idx_tool_executions_node ON tool_executions(node_run_id, attempt);
