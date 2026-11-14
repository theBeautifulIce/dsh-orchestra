-- 007：node_run_events 只追加 + 链头投影（第二次意见 P1：哈希链没有数据库级只追加保护、整条链被删校验就失效）
-- 应用层本来只有 appendNodeRunEvent 一个写入口；触发器是防绕过应用直接改库的第二道锁。
CREATE TRIGGER IF NOT EXISTS trg_node_run_events_no_update
BEFORE UPDATE ON node_run_events
BEGIN
  SELECT RAISE(ABORT, 'node_run_events 只追加');
END;
;
CREATE TRIGGER IF NOT EXISTS trg_node_run_events_no_delete
BEFORE DELETE ON node_run_events
BEGIN
  SELECT RAISE(ABORT, 'node_run_events 只追加');
END;
;
-- 链头投影：每条链记到第几条、链尾哈希是多少、一共几条。
-- 校验端拿它跟账本里的链对账：链被截断或整条被删掉时，只看链本身看不出缺口。
CREATE TABLE IF NOT EXISTS node_run_chain_heads (
  node_run_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  last_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
;
-- 存量库回填：升级前就在的链按当前链尾补上链头，升级后校验才不会把老账判成缺口
INSERT OR REPLACE INTO node_run_chain_heads (node_run_id, last_seq, last_hash, event_count, updated_at)
SELECT e.node_run_id, e.seq, e.hash, c.n, e.created_at
FROM node_run_events e
JOIN (
  SELECT node_run_id, MAX(seq) AS max_seq, COUNT(*) AS n
  FROM node_run_events
  GROUP BY node_run_id
) c ON c.node_run_id = e.node_run_id AND c.max_seq = e.seq;
;
