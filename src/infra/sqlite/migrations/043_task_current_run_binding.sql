-- 043_task_current_run_binding.sql —— 补齐历史任务的 current_run_id 绑定（审计 P1-04）
--
-- 口径（宁缺勿猜）：
-- 1. 候选根 run = COALESCE(root_run_id, run_id) = run_id 的行。子流程 run 与记忆整理 run 的
--    root_run_id 指向别的 run，不算本任务的根 run。
-- 2. 名下恰好一条候选根 run 的任务才补绑定；status='reserved' 的预留任务本来就没有当前 run，保持 NULL。
-- 3. 历史不明（多条候选根 run，或一条候选根 run 都没有）不猜：current_run_id 继续留空，
--    候选 run 与原因写进 task_run_binding_review，等人工核对，不盲目取"最新一条"。
-- 4. 补上绑定后，若这条 run 已是终态，按 closeRun 的同一口径把任务状态同步成 run 终态
--    （display_status 一并清空）；否则任务会永远停在 running，看起来像还在跑。
-- 5. 迁移可重复执行：绑定只动仍为 NULL 的行，核对记录用 INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS task_run_binding_review (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  candidate_run_id TEXT NOT NULL REFERENCES runs(run_id),
  reason TEXT NOT NULL CHECK (reason IN ('multiple_root_runs', 'no_root_run')),
  run_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, candidate_run_id)
)
;
-- 情况一：名下有 run，但一条根 run 都找不到（历史数据缺 root_run_id，或根 run 记在别的任务名下）
INSERT OR IGNORE INTO task_run_binding_review (task_id, candidate_run_id, reason, run_count, created_at)
SELECT t.task_id, r.run_id, 'no_root_run',
  (SELECT COUNT(*) FROM runs r3 WHERE r3.task_id = t.task_id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks t
JOIN runs r ON r.task_id = t.task_id
WHERE t.current_run_id IS NULL
  AND t.status <> 'reserved'
  AND NOT EXISTS (
    SELECT 1 FROM runs rr
    WHERE rr.task_id = t.task_id AND COALESCE(rr.root_run_id, rr.run_id) = rr.run_id
  )
;
-- 情况二：名下有多条根 run，先后不明，不盲目绑定
INSERT OR IGNORE INTO task_run_binding_review (task_id, candidate_run_id, reason, run_count, created_at)
SELECT t.task_id, r.run_id, 'multiple_root_runs',
  (SELECT COUNT(*) FROM runs r3 WHERE r3.task_id = t.task_id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks t
JOIN runs r ON r.task_id = t.task_id
WHERE t.current_run_id IS NULL
  AND t.status <> 'reserved'
  AND COALESCE(r.root_run_id, r.run_id) = r.run_id
  AND (
    SELECT COUNT(*) FROM runs rr
    WHERE rr.task_id = t.task_id AND COALESCE(rr.root_run_id, rr.run_id) = rr.run_id
  ) > 1
;
-- 情况三：唯一可判定的任务补绑定，并按 closeRun 的同一口径同步已终态的任务状态
UPDATE tasks
SET current_run_id = (
      SELECT r.run_id FROM runs r
      WHERE r.task_id = tasks.task_id AND COALESCE(r.root_run_id, r.run_id) = r.run_id
      ORDER BY r.run_id LIMIT 1
    ),
  status = CASE
    WHEN tasks.status IN ('running', 'queued', 'settling', 'waiting')
      AND (
        SELECT r.status FROM runs r WHERE r.run_id = (
          SELECT r2.run_id FROM runs r2
          WHERE r2.task_id = tasks.task_id AND COALESCE(r2.root_run_id, r2.run_id) = r2.run_id
          ORDER BY r2.run_id LIMIT 1
        )
      ) IN ('succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled')
    THEN (
      SELECT r.status FROM runs r WHERE r.run_id = (
        SELECT r2.run_id FROM runs r2
        WHERE r2.task_id = tasks.task_id AND COALESCE(r2.root_run_id, r2.run_id) = r2.run_id
        ORDER BY r2.run_id LIMIT 1
      )
    )
    ELSE tasks.status
  END,
  display_status = CASE
    WHEN tasks.status IN ('running', 'queued', 'settling', 'waiting')
      AND (
        SELECT r.status FROM runs r WHERE r.run_id = (
          SELECT r2.run_id FROM runs r2
          WHERE r2.task_id = tasks.task_id AND COALESCE(r2.root_run_id, r2.run_id) = r2.run_id
          ORDER BY r2.run_id LIMIT 1
        )
      ) IN ('succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled')
    THEN NULL
    ELSE tasks.display_status
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  revision = tasks.revision + 1
WHERE tasks.current_run_id IS NULL
  AND tasks.status <> 'reserved'
  AND EXISTS (SELECT 1 FROM runs r0 WHERE r0.task_id = tasks.task_id)
  AND (
    SELECT COUNT(*) FROM runs rr
    WHERE rr.task_id = tasks.task_id AND COALESCE(rr.root_run_id, rr.run_id) = rr.run_id
  ) = 1
;
