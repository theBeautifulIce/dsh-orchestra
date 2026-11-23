-- 未启动的任务专属计划不再占任务表（P01）。
-- 任务表只纳入正式受理的任务：reserved 且从未启动、又有专属计划归属的预留任务不进看板。
-- 定时任务的合法预留没有 task_plans 行，继续展示。
DROP TRIGGER task_attention_refresh_insert;
;

CREATE TRIGGER task_attention_refresh_insert INSTEAD OF INSERT ON task_attention_refresh
BEGIN
  DELETE FROM task_attention_order
    WHERE task_id = NEW.task_id
      AND NOT EXISTS (SELECT 1 FROM task_attention_facts f WHERE f.task_id = NEW.task_id);
  DELETE FROM task_attention_order
    WHERE task_id = NEW.task_id
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = NEW.task_id AND t.status = 'reserved'
        AND NOT EXISTS (SELECT 1 FROM start_run_operations o WHERE o.task_id = t.task_id)
        AND EXISTS (SELECT 1 FROM task_plans p WHERE p.owner_task_id = t.task_id));
  INSERT INTO task_attention_order (task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight)
    SELECT task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight
    FROM task_attention_facts WHERE task_id = NEW.task_id
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = NEW.task_id AND t.status = 'reserved'
        AND NOT EXISTS (SELECT 1 FROM start_run_operations o WHERE o.task_id = t.task_id)
        AND EXISTS (SELECT 1 FROM task_plans p WHERE p.owner_task_id = t.task_id))
  ON CONFLICT(task_id) DO UPDATE SET
    status = excluded.status, trigger_kind = excluded.trigger_kind, updated_at = excluded.updated_at,
    archived_at = excluded.archived_at, current_run_status = excluded.current_run_status,
    trigger_enabled = excluded.trigger_enabled, attention_weight = excluded.attention_weight
  WHERE task_attention_order.status IS NOT excluded.status
     OR task_attention_order.trigger_kind IS NOT excluded.trigger_kind
     OR task_attention_order.updated_at IS NOT excluded.updated_at
     OR task_attention_order.archived_at IS NOT excluded.archived_at
     OR task_attention_order.current_run_status IS NOT excluded.current_run_status
     OR task_attention_order.trigger_enabled IS NOT excluded.trigger_enabled
     OR task_attention_order.attention_weight IS NOT excluded.attention_weight;
END;
;

-- 计划落库或启动记录出现时，重新判定这条预留任务是否该进任务表。
CREATE TRIGGER task_attention_plans_insert AFTER INSERT ON task_plans
BEGIN
  INSERT INTO task_attention_refresh SELECT owner_task_id FROM task_plans
    WHERE plan_id = NEW.plan_id AND owner_task_id IS NOT NULL;
END;
;
CREATE TRIGGER task_attention_start_ops_insert AFTER INSERT ON start_run_operations
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM start_run_operations WHERE operation_id = NEW.operation_id;
END;
;

-- 清掉已经挂在任务表里的未启动计划，再按新规则重排已受理任务。
DELETE FROM task_attention_order
  WHERE task_id IN (SELECT t.task_id FROM tasks t WHERE t.status = 'reserved'
    AND NOT EXISTS (SELECT 1 FROM start_run_operations o WHERE o.task_id = t.task_id)
    AND EXISTS (SELECT 1 FROM task_plans p WHERE p.owner_task_id = t.task_id));
;
INSERT INTO task_attention_refresh SELECT task_id FROM tasks;
;
