-- Snapshot whether a decision asks for human attention when it opens.
-- NULL keeps existing human-actionable entries in the inbox and preserves timeout behavior.
ALTER TABLE decisions ADD COLUMN human_attention INTEGER CHECK (human_attention IN (0, 1));
;

CREATE VIEW human_decision_inbox AS
  SELECT decision_id, run_id, created_at FROM decisions
  WHERE status IN ('pending', 'acknowledged', 'blocked_for_human')
    AND approver IN ('human', 'either')
    AND (human_attention IS NOT 0 OR status = 'blocked_for_human');
;

DROP VIEW task_attention_facts;
;
-- The pending predicate is shared by task ranking, counts, and the approval center.
-- Keep the other facts and exclusions equivalent to migration 059.
CREATE VIEW task_attention_facts AS
  SELECT t.task_id, t.status, t.trigger_kind, t.updated_at, t.archived_at,
    r.status AS current_run_status, tr.enabled AS trigger_enabled,
    CASE
      WHEN EXISTS (SELECT 1 FROM human_decision_inbox d WHERE d.run_id = t.current_run_id) THEN 6
      WHEN EXISTS (
        SELECT 1 FROM node_runs n WHERE n.run_id = t.current_run_id
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

-- Under 059, weight 6 meant the current run had an active decision. Refresh the
-- materialized rank only where the new inbox has no active human decision.
INSERT INTO task_attention_refresh
  SELECT t.task_id
  FROM task_attention_order a JOIN tasks t ON t.task_id = a.task_id
  WHERE a.archived IN (0, 1) AND a.attention_weight = 6
    AND NOT EXISTS (SELECT 1 FROM human_decision_inbox d WHERE d.run_id = t.current_run_id);
;
