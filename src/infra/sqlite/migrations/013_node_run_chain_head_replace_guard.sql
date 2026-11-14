-- 013：链头只能由追加创建一次，重复 INSERT 与 INSERT OR REPLACE 都不许
-- 012 的 DELETE 触发器挡不住 REPLACE：SQLite 的 REPLACE 冲突路径不触发 BEFORE DELETE，
-- 会先把旧链头删掉再插一条 seq=1 的新链头。这里在 BEFORE INSERT 上看同一 node_run 是否已有链头，
-- 有就拒；正常追加只在没有链头时 INSERT，不受影响。
CREATE TRIGGER IF NOT EXISTS trg_node_run_chain_heads_insert_once
BEFORE INSERT ON node_run_chain_heads
BEGIN
  SELECT RAISE(ABORT, '链头只能由追加创建，不能重复插入或替换')
  WHERE EXISTS (
    SELECT 1 FROM node_run_chain_heads h
    WHERE h.node_run_id = NEW.node_run_id
  );
END;
;
