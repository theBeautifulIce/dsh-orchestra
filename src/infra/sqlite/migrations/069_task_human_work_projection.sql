-- 任务关注事实（T01/T02/T03/D06/D07）
-- 1. 当前根运行的整棵运行树都算本次任务的关注范围，子流程的人工事项不再漏；
-- 2. 可办理的成果留验、待授权/待升级的返工也属于人工事项；
-- 3. “外部操作待核验”只算真的开始过执行的步骤，未派发的可补偿步骤不再算不可逆。
-- 账本结算语义保持不变，这里只是人读投影。
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

-- 已存在的行按新事实重排：留验与返工首次被纳入人工事项。
INSERT INTO task_attention_refresh SELECT task_id FROM tasks;
;

-- 留验与返工都会改变“是否需要人处理”，各自按所属任务刷新。
CREATE TRIGGER task_attention_review_holds_insert AFTER INSERT ON delivery_review_holds
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = NEW.run_id;
END;
;
CREATE TRIGGER task_attention_review_holds_update AFTER UPDATE ON delivery_review_holds
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = NEW.run_id;
END;
;
CREATE TRIGGER task_attention_review_holds_delete AFTER DELETE ON delivery_review_holds
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = OLD.run_id;
END;
;
CREATE TRIGGER task_attention_rework_insert AFTER INSERT ON rework_requests
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = NEW.run_id;
END;
;
CREATE TRIGGER task_attention_rework_update AFTER UPDATE ON rework_requests
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = NEW.run_id;
END;
;
CREATE TRIGGER task_attention_rework_delete AFTER DELETE ON rework_requests
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = OLD.run_id;
END;
;

-- 子运行上的人工事项也要刷新父任务：按 run 找到所属任务（runs.task_id 与根运行一致）。
DROP TRIGGER task_attention_refresh_run_insert;
;
DROP VIEW task_attention_refresh_run;
;
CREATE VIEW task_attention_refresh_run AS SELECT run_id FROM runs WHERE 0;
;
CREATE TRIGGER task_attention_refresh_run_insert INSTEAD OF INSERT ON task_attention_refresh_run
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM runs WHERE run_id = NEW.run_id;
END;
;
