-- S3 半态时钟锚点：墙钟只展示，判定看 boot_id 与单调纳秒（规格 4.4 行 328-342）
-- 已有 deadline/verify 锚点不动，这里只补 startup_unknown、围栏宽限与等待三只钟。
ALTER TABLE node_runs ADD COLUMN startup_unknown_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN startup_unknown_monotonic_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN fence_grace_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN fence_grace_monotonic_ns INTEGER;
;
ALTER TABLE node_runs ADD COLUMN wait_deadline_boot_id TEXT;
;
ALTER TABLE node_runs ADD COLUMN wait_deadline_monotonic_ns INTEGER;
;
