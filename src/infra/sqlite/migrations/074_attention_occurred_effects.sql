-- 外部操作待核验只看真的发生过的动作（T03）：只领到租约、既没开始也没工具执行记录的步骤
-- 不再算“未结算的不可逆动作”。结算账本的保守规则不变，这里只是人读投影与排序依据。
-- 谓词与 src/infra/db/unverified-effects.ts 的 EXTERNAL_EFFECT_OCCURRED 保持一致。
DROP VIEW task_attention_facts;
;

CREATE VIEW task_attention_facts AS
  SELECT t.task_id, t.status, t.trigger_kind, t.updated_at, t.archived_at,
    r.status AS current_run_status, tr.enabled AS trigger_enabled,
    CASE
      WHEN EXISTS (SELECT 1 FROM human_decision_inbox d WHERE d.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION ALL SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (SELECT 1 FROM delivery_review_holds h
        JOIN node_runs hn ON hn.run_id = h.run_id AND hn.node_id = h.node_id AND hn.replacement_node_run_id IS NULL
        WHERE h.status = 'held' AND hn.status = 'done' AND h.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION ALL SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (SELECT 1 FROM rework_requests q WHERE q.status IN ('proposed', 'needs_human_approval', 'escalated')
        AND q.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION ALL SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (
        SELECT 1 FROM node_runs n WHERE n.run_id IN (
          WITH RECURSIVE tree(run_id) AS (
            SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
            UNION ALL SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id
          ) SELECT run_id FROM tree)
          AND n.status NOT IN ('queued', 'blocked_pre', 'dispatched', 'waiting')
          AND NOT (n.status = 'leased' AND n.started_at IS NULL AND n.heartbeat_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM tool_executions e WHERE e.node_run_id = n.node_run_id AND e.attempt = n.attempt))
          AND n.side_effect_policy <> 'pure'
          AND NOT (n.side_effect_verified_none = 1 AND COALESCE(length(trim(n.stop_evidence)), 0) > 0)
          AND NOT EXISTS (SELECT 1 FROM unverified_resolutions ur WHERE ur.node_run_id = n.node_run_id)
          AND NOT (n.node_id = 'mem_apply' AND n.status = 'superseded' AND EXISTS (
            SELECT 1 FROM memory_write_recoveries mw WHERE mw.node_run_id = n.node_run_id
              AND mw.status = 'confirmed_not_applied'
          ))
          AND NOT (n.node_id = 'mem_apply' AND n.status = 'done' AND EXISTS (
            SELECT 1 FROM memory_batches b WHERE b.apply_node_run_id = n.node_run_id
              AND b.memory_run_id = n.run_id AND b.status = 'applied'
          ))
          AND NOT (n.node_type = 'subworkflow' AND n.status = 'done' AND n.side_effect_verified_none = 1 AND EXISTS (
            SELECT 1 FROM runs child WHERE child.parent_node_run_id = n.node_run_id
              AND child.parent_run_id = n.run_id AND child.status IN ('succeeded', 'succeeded_with_unverified')
          ))
      ) THEN 5
      WHEN r.status IN ('failed', 'failed_with_unverified') THEN 4
      WHEN EXISTS (SELECT 1 FROM run_acceptance_results a WHERE a.run_id = t.current_run_id AND a.outcome = 'failed') THEN 4
      WHEN EXISTS (SELECT 1 FROM run_acceptance_results a WHERE a.run_id = t.current_run_id AND a.outcome = 'unverifiable') THEN 5
      WHEN r.status = 'orphaned' OR EXISTS (SELECT 1 FROM node_runs n WHERE n.run_id = t.current_run_id
        AND n.status = 'orphaned' AND n.replacement_node_run_id IS NULL) THEN 3
      WHEN t.status = 'running' OR r.status NOT IN
        ('succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled') THEN 2
      ELSE 1
    END AS attention_weight
  FROM tasks t
  LEFT JOIN runs r ON r.run_id = t.current_run_id
  LEFT JOIN task_triggers tr ON tr.task_id = t.task_id;
;
