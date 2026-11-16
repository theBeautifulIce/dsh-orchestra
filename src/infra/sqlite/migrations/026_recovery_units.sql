-- 旧单位数据的一次性迁移（评审 P2-2，口径按 S1 r67 P2-1 修正）
-- 修复前的 sweepExpiredLeases 把毫秒直接写进纳秒列 startup_unknown_remaining_ns：
-- 旧库里的 120000（毫秒）在新代码里会被当成 0.12ms，watchdog 一恢复就判到期。
-- 不能用「缺单调锚点」当识别条件：生产上的旧写入路径四列同写，锚点是有的。
-- 改成按数值量级判定：
--   1) 1 ~ 999999  —— 不可能是纳秒预算（<1ms 等于已到期），按毫秒换算；
--   2) 1e6 ~ 1e9   —— 模糊带（可能是纳秒的毫秒级剩余，也可能是旧毫秒的大预算），保留原值只记账；
--   3) >= 1e9      —— 纳秒量级，肯定是新数据，不动也不记账。
-- 只修能可靠识别的行，不无条件乘 1e6。
CREATE TABLE IF NOT EXISTS recovery_unit_fixes (
  fix_id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixed_at TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER,
  reason TEXT NOT NULL
);
;

-- 修复前先记账：可审计到具体节点、旧值与新值
INSERT INTO recovery_unit_fixes (fixed_at, node_run_id, column_name, old_value, new_value, reason)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), node_run_id, 'startup_unknown_remaining_ns',
       startup_unknown_remaining_ns, startup_unknown_remaining_ns * 1000000, 'legacy_ms_to_ns'
FROM node_runs
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_remaining_ns > 0
  AND startup_unknown_remaining_ns < 1000000;
;

-- 模糊带：保留原值，只记账等人工校验（必须在 UPDATE 之前跑，否则修完的行会被误记）
INSERT INTO recovery_unit_fixes (fixed_at, node_run_id, column_name, old_value, new_value, reason)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), node_run_id, 'startup_unknown_remaining_ns',
       startup_unknown_remaining_ns, startup_unknown_remaining_ns, 'unclassified_kept'
FROM node_runs
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_remaining_ns >= 1000000
  AND startup_unknown_remaining_ns < 1000000000;
;

-- 0 与负值也记账但不改：两种解释下都等于到期，改不改都不影响判定
INSERT INTO recovery_unit_fixes (fixed_at, node_run_id, column_name, old_value, new_value, reason)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), node_run_id, 'startup_unknown_remaining_ns',
       startup_unknown_remaining_ns, startup_unknown_remaining_ns, 'unclassified_kept'
FROM node_runs
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_remaining_ns <= 0;
;

UPDATE node_runs
SET startup_unknown_remaining_ns = startup_unknown_remaining_ns * 1000000
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_remaining_ns > 0
  AND startup_unknown_remaining_ns < 1000000;
;
