-- 旧单位数据的一次性迁移（评审 P2-2）
-- 修复前的 sweepExpiredLeases 把毫秒直接写进纳秒列 startup_unknown_remaining_ns：
-- 旧库里的 120000（毫秒）在新代码里会被当成 0.12ms，watchdog 一恢复就判到期。
-- 识别口径：新写入路径四列同写（deadline/boot/monotonic/remaining），
-- 所以「remaining 非空但 monotonic 为空」只可能来自旧路径；再看值是否落在毫秒量级。
-- 只修能可靠识别的行，其余保留原值并记账，不无条件乘 1e6。
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
  AND startup_unknown_remaining_ns <= 86400000
  AND startup_unknown_monotonic_ns IS NULL;
;

-- 无法判断的：同样缺锚点，但值不在毫秒量级（0 或超过一天）。保留原值，只记账等人工校验。
-- 必须在 UPDATE 之前跑：修完的行值会变成纳秒量级，再按「缺锚点」筛会误记成无法判断。
INSERT INTO recovery_unit_fixes (fixed_at, node_run_id, column_name, old_value, new_value, reason)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), node_run_id, 'startup_unknown_remaining_ns',
       startup_unknown_remaining_ns, startup_unknown_remaining_ns, 'unclassified_kept'
FROM node_runs
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_monotonic_ns IS NULL
  AND (startup_unknown_remaining_ns <= 0 OR startup_unknown_remaining_ns > 86400000);
;

UPDATE node_runs
SET startup_unknown_remaining_ns = startup_unknown_remaining_ns * 1000000
WHERE startup_unknown_remaining_ns IS NOT NULL
  AND startup_unknown_remaining_ns > 0
  AND startup_unknown_remaining_ns <= 86400000
  AND startup_unknown_monotonic_ns IS NULL;
;
