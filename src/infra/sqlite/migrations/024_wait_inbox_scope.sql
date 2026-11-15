-- 024：等待事件幂等键按 run 作用域（G3 r11 P2-6）
-- 018 把 idempotency_key 做成全表唯一：两个 run 用同一个键时，第二个事件被当成第一个，
-- 第二个 run 的 inbox 永远收不到这条事件。改成 (run_id, idempotency_key) 唯一。
-- SQLite 不能改列约束，只能重建表；inbox_seq 原样搬过去，回放游标不受影响。
CREATE TABLE wait_event_inbox_next (
  inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (run_id, idempotency_key)
);

INSERT INTO wait_event_inbox_next (inbox_seq, run_id, event_type, payload_json, idempotency_key, received_at)
  SELECT inbox_seq, run_id, event_type, payload_json, idempotency_key, received_at FROM wait_event_inbox;

DROP TABLE wait_event_inbox;

ALTER TABLE wait_event_inbox_next RENAME TO wait_event_inbox;

CREATE INDEX IF NOT EXISTS idx_wait_event_inbox_run ON wait_event_inbox(run_id, inbox_seq);
