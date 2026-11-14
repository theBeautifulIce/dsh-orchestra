-- 判定开始时间：桥恢复回 verifying 时要重置，不能拿旧值冒充新一轮
ALTER TABLE node_runs ADD COLUMN verify_started_at TEXT;
