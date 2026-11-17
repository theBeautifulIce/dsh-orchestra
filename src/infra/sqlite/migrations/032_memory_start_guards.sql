-- 032_memory_start_guards.sql —— S5-E：记忆发起与批次的数据库硬约束
--
-- ① 同一个源运行同时只允许一条未终结的记忆批次（对应 MEMORY_RUN_ACTIVE）
-- ② 批次只能挂在已经成功收口的源运行上（对应 MEMORY_SOURCE_RUN_NOT_SETTLED）

CREATE UNIQUE INDEX IF NOT EXISTS memory_batches_active_source_uq
  ON memory_batches(source_run_id)
  WHERE status NOT IN ('applied','empty','blocked','declined','expired','failed','indeterminate')
;
;

CREATE TRIGGER memory_batches_source_run_settled
BEFORE INSERT ON memory_batches
WHEN (SELECT status FROM runs WHERE run_id = NEW.source_run_id) <> 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_SOURCE_RUN_NOT_SETTLED');
END;
;
