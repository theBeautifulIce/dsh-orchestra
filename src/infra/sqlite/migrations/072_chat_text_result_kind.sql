-- 会话文字结果是一等验收类型（P05）：run_acceptance_results.kind 放开到 chat/text_result。
-- SQLite 不能直接改 CHECK。这里把旧表改名留档、新表顶上原名，避免 DROP 触发视图重编译失败；
-- 059 的三个刷新触发器先删掉，表换完再建回新表上。
DROP TRIGGER task_attention_run_acceptance_results_insert;
;

DROP TRIGGER task_attention_run_acceptance_results_update;
;

DROP TRIGGER task_attention_run_acceptance_results_delete;
;

CREATE TABLE run_acceptance_results_new (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_id TEXT NOT NULL REFERENCES task_plans(plan_id),
  content_hash TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  deliverable_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('artifact','tool_evidence','chat/text_result')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','unverifiable')),
  reason TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evaluated_at TEXT NOT NULL,
  UNIQUE (run_id, plan_id, content_hash, deliverable_key)
);
;

INSERT INTO run_acceptance_results_new
  SELECT result_id, run_id, plan_id, content_hash, rule_version, deliverable_key,
    kind, outcome, reason, evidence_json, evaluated_at
  FROM run_acceptance_results;
;

ALTER TABLE run_acceptance_results RENAME TO run_acceptance_results_legacy;
;

ALTER TABLE run_acceptance_results_new RENAME TO run_acceptance_results;
;

CREATE INDEX IF NOT EXISTS idx_run_acceptance_results_run ON run_acceptance_results(run_id);
;

CREATE INDEX IF NOT EXISTS idx_run_acceptance_results_plan ON run_acceptance_results(plan_id);
;

CREATE TRIGGER task_attention_run_acceptance_results_insert
AFTER INSERT ON run_acceptance_results
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
CREATE TRIGGER task_attention_run_acceptance_results_update
AFTER UPDATE OF run_id, outcome ON run_acceptance_results
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.outcome IS NOT NEW.outcome
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.run_id WHERE OLD.run_id IS NOT NEW.run_id;
END;
;
CREATE TRIGGER task_attention_run_acceptance_results_delete
AFTER DELETE ON run_acceptance_results
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.run_id);
END;
;

-- 表改名会让引用它的视图指向旧名，这里把事实视图按新表名重建。
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
;
