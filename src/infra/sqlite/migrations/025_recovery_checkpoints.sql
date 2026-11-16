-- 跨 boot 恢复检查点：剩余预算在服务存活时按单调钟递减并落库，重启后按检查点续算（停机不累计）
-- 墙钟只作展示，跨 boot 判定不再依赖墙钟差值（评审 P1-2，路径 B）
ALTER TABLE node_runs ADD COLUMN action_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN wait_remaining_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN fence_remaining_ns INTEGER;
;
-- 换算不出可信剩余时的不确定状态：宿主可查，扫描不再自动推进
ALTER TABLE node_runs ADD COLUMN recovery_uncertain TEXT;
;
ALTER TABLE node_runs ADD COLUMN recovery_uncertain_at TEXT;
;
