-- 留验身份与代次（D04）：每轮留验一个不可复用的 hold_id，撤销与重建都不复用旧标识，
-- 旧页签提交的结论只能落到它读到的那一代上。
ALTER TABLE delivery_review_holds ADD COLUMN hold_id TEXT;
;

UPDATE delivery_review_holds SET hold_id=lower(hex(randomblob(16))) WHERE hold_id IS NULL;
;

CREATE UNIQUE INDEX delivery_hold_id ON delivery_review_holds(hold_id);
;

-- 旧 held 快照按「当轮实际成果」重新封存（D03）：留验早于交付时旧快照是空数组，
-- 清空后由验收事务按当前已完成尝试与计划必交件重算，而不是当成「无需核对」。
UPDATE delivery_review_holds SET review_set_json=NULL WHERE status='held';
;
