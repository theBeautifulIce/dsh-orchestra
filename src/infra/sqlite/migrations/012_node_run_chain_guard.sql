-- 012：链头只由追加维护，事件、链头、序号与哈希必须同一条链上逐条前进
-- 应用层只有 appendNodeRunEvent 一个入口；这里是绕过应用直接改库时的第二道锁。
-- 事件 INSERT：有链头就只接 last_seq+1 / last_hash，没有链头就必须从 seq=1 的零哈希开始
CREATE TRIGGER IF NOT EXISTS trg_node_run_events_chain_guard
BEFORE INSERT ON node_run_events
BEGIN
  SELECT RAISE(ABORT, 'node_run_events 必须接在链头之后')
  WHERE NEW.seq < 1;
  SELECT RAISE(ABORT, 'node_run_events 必须接在链头之后')
  WHERE EXISTS (SELECT 1 FROM node_run_chain_heads h WHERE h.node_run_id = NEW.node_run_id)
    AND (NEW.seq != (SELECT h.last_seq + 1 FROM node_run_chain_heads h WHERE h.node_run_id = NEW.node_run_id)
      OR NEW.prev_hash != (SELECT h.last_hash FROM node_run_chain_heads h WHERE h.node_run_id = NEW.node_run_id));
  SELECT RAISE(ABORT, '新链必须从 seq=1 的零哈希开始')
  WHERE NOT EXISTS (SELECT 1 FROM node_run_chain_heads h WHERE h.node_run_id = NEW.node_run_id)
    AND (NEW.seq != 1 OR NEW.prev_hash != '0000000000000000000000000000000000000000000000000000000000000000');
END;
;
-- 链头 INSERT：新链头必须恰好对应 seq=1 的首条事件
CREATE TRIGGER IF NOT EXISTS trg_node_run_chain_heads_insert_guard
BEFORE INSERT ON node_run_chain_heads
BEGIN
  SELECT RAISE(ABORT, '新链头必须恰好对应首条事件')
  WHERE NEW.last_seq != 1 OR NEW.event_count != 1;
  SELECT RAISE(ABORT, '新链头缺少对应的首条事件')
  WHERE NOT EXISTS (
    SELECT 1 FROM node_run_events e
    WHERE e.node_run_id = NEW.node_run_id
      AND e.seq = 1
      AND e.hash = NEW.last_hash
      AND e.prev_hash = '0000000000000000000000000000000000000000000000000000000000000000'
  );
END;
;
-- 链头 UPDATE：只能 +1，且必须能对上刚刚追加的那条事件
CREATE TRIGGER IF NOT EXISTS trg_node_run_chain_heads_update_guard
BEFORE UPDATE ON node_run_chain_heads
BEGIN
  SELECT RAISE(ABORT, '链头序号必须逐条递增')
  WHERE NEW.last_seq != OLD.last_seq + 1;
  SELECT RAISE(ABORT, '链头条数必须逐条递增')
  WHERE NEW.event_count != OLD.event_count + 1;
  SELECT RAISE(ABORT, '链头更新缺少对应事件')
  WHERE NOT EXISTS (
    SELECT 1 FROM node_run_events e
    WHERE e.node_run_id = NEW.node_run_id
      AND e.seq = NEW.last_seq
      AND e.hash = NEW.last_hash
      AND e.prev_hash = OLD.last_hash
  );
END;
;
-- 链头 DELETE：链头只由追加维护，整条链要消失也必须留下可校验的缺口
CREATE TRIGGER IF NOT EXISTS trg_node_run_chain_heads_no_delete
BEFORE DELETE ON node_run_chain_heads
BEGIN
  SELECT RAISE(ABORT, '链头只由追加维护，不许删除');
END;
;
