-- 005：账本事件表只追加，数据库层直接拒绝 UPDATE/DELETE（S1 第九轮 P2-3）
-- 应用层本来只插入；这一层是防绕过应用直接改库。
CREATE TRIGGER IF NOT EXISTS trg_events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events 只追加，不许改');
END;
;
CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events 只追加，不许删');
END;
;
