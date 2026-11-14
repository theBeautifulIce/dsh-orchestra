-- R5-E：把「已落账」与「已处理」拆成两个游标。
-- last_persisted_ack_seq 只表示事件与 receipt 已提交；last_handled_seq 表示 onEvent
-- 已成功返回。重连必须从 handled 之后重放，否则 onEvent 抛错后游标已越过该事件，
-- 事件会被永久跳过。
ALTER TABLE bridge_stream_cursors ADD COLUMN last_handled_seq INTEGER NOT NULL DEFAULT 0;
