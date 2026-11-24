-- 当前待办与人读投影同步：返工待验收、当前有效尝试、明确未派发的取消。
-- 核心副作用结算规则不变；与 queries/tasks.ts 和 unverified-effects.ts 等价。
DROP VIEW task_attention_facts;
;

CREATE VIEW task_attention_facts AS
  SELECT t.task_id, t.status, t.trigger_kind, t.updated_at, t.archived_at,
    r.status AS current_run_status, tr.enabled AS trigger_enabled,
    CASE
      WHEN EXISTS (SELECT 1 FROM human_decision_inbox d WHERE d.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (SELECT 1 FROM delivery_review_holds h
        JOIN runs hr ON hr.run_id=h.run_id AND hr.status='running' AND hr.cancel_requested_at IS NULL
        JOIN node_runs hn ON hn.run_id=h.run_id AND hn.node_id=h.node_id
          AND hn.replacement_node_run_id IS NULL AND hn.status='done'
        WHERE (h.status='held' OR h.node_run_id<>hn.node_run_id) AND h.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
        ) SELECT run_id FROM tree)
          AND hn.attempt=(SELECT MAX(m.attempt) FROM node_runs m WHERE m.run_id=hn.run_id
            AND m.node_id=hn.node_id AND m.replacement_node_run_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM rework_requests rq WHERE rq.run_id=h.run_id
            AND (rq.target_node_run_id=hn.node_run_id OR rq.new_node_run_id=hn.node_run_id)
            AND rq.status NOT IN ('closed','declined','cancelled'))) THEN 6
      WHEN EXISTS (SELECT 1 FROM rework_requests rq
        JOIN runs rr ON rr.run_id=rq.run_id AND rr.status='running' AND rr.cancel_requested_at IS NULL
        JOIN rework_attempts rw ON rw.request_id=rq.request_id AND rw.round_no=rq.round_no AND rw.status='awaiting_review'
        JOIN node_runs rn ON rn.node_run_id=rq.new_node_run_id AND rn.node_run_id=rw.new_node_run_id
          AND rn.run_id=rq.run_id AND rn.status='done' AND rn.replacement_node_run_id IS NULL
        WHERE rq.status='awaiting_review' AND rq.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (SELECT 1 FROM rework_requests q
        JOIN runs qr ON qr.run_id=q.run_id AND qr.status='running' AND qr.cancel_requested_at IS NULL
        WHERE q.status IN ('proposed', 'needs_human_approval', 'escalated')
        AND q.run_id IN (
        WITH RECURSIVE tree(run_id) AS (
          SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
          UNION SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
        ) SELECT run_id FROM tree)) THEN 6
      WHEN EXISTS (
        SELECT 1 FROM node_runs n WHERE n.run_id IN (
          WITH RECURSIVE tree(run_id) AS (
            SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
            UNION SELECT c.run_id FROM runs c JOIN tree ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
          ) SELECT run_id FROM tree)
          AND n.status NOT IN ('queued', 'blocked_pre', 'dispatched', 'waiting')
          AND NOT (n.status = 'leased' AND n.started_at IS NULL AND n.heartbeat_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM tool_executions e WHERE e.node_run_id = n.node_run_id AND e.attempt = n.attempt))
          AND NOT (n.status = 'superseded' AND n.started_at IS NULL AND n.heartbeat_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM tool_executions e WHERE e.node_run_id = n.node_run_id AND e.attempt = n.attempt)
            AND EXISTS (SELECT 1 FROM node_run_events ev WHERE ev.node_run_id = n.node_run_id
              AND (ev.type = 'cancel_before_dispatch'
                OR (ev.type = 'cancel_control_node' AND n.node_type IN ('wait','subworkflow','parallel')))))
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

-- 旧行要立即重算；只替换视图不会更新已经物化的排序。
INSERT INTO task_attention_refresh SELECT task_id FROM tasks;
;
-- 明确的未执行证明比状态更新晚写入，同一事务内再刷新一次。
CREATE TRIGGER task_attention_cancel_evidence_insert AFTER INSERT ON node_run_events
WHEN NEW.type IN ('cancel_before_dispatch','cancel_control_node')
BEGIN
  INSERT INTO task_attention_refresh_run SELECT run_id FROM node_runs WHERE node_run_id=NEW.node_run_id;
END;
;
CREATE TRIGGER task_attention_rework_attempts_insert AFTER INSERT ON rework_attempts
BEGIN
  INSERT INTO task_attention_refresh_run SELECT run_id FROM rework_requests WHERE request_id=NEW.request_id;
END;
;
CREATE TRIGGER task_attention_rework_attempts_update AFTER UPDATE ON rework_attempts
BEGIN
  INSERT INTO task_attention_refresh_run SELECT run_id FROM rework_requests WHERE request_id=NEW.request_id;
  INSERT INTO task_attention_refresh_run SELECT run_id FROM rework_requests WHERE request_id=OLD.request_id AND OLD.request_id<>NEW.request_id;
END;
;
CREATE TRIGGER task_attention_rework_attempts_delete AFTER DELETE ON rework_attempts
BEGIN
  INSERT INTO task_attention_refresh_run SELECT run_id FROM rework_requests WHERE request_id=OLD.request_id;
END;
;
-- 留验可以先于交付建立。纯文本步骤由 queued -> done 时，同样要进入待处理列。
CREATE TRIGGER task_attention_review_node_insert AFTER INSERT ON node_runs
WHEN EXISTS (SELECT 1 FROM delivery_review_holds h WHERE h.run_id=NEW.run_id AND h.node_id=NEW.node_id)
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
CREATE TRIGGER task_attention_review_node_update
AFTER UPDATE OF status,replacement_node_run_id,attempt ON node_runs
WHEN (OLD.status IS NOT NEW.status OR OLD.replacement_node_run_id IS NOT NEW.replacement_node_run_id OR OLD.attempt IS NOT NEW.attempt)
 AND (EXISTS (SELECT 1 FROM delivery_review_holds h WHERE h.run_id=NEW.run_id AND h.node_id=NEW.node_id)
   OR EXISTS (SELECT 1 FROM rework_requests q WHERE q.new_node_run_id=NEW.node_run_id))
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
