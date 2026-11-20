-- Keep task rank and filters in the same write transaction as their source rows.
-- Decision and heartbeat ages are calculated at read time and cannot alter rank.
CREATE INDEX tasks_current_run_idx ON tasks(current_run_id) WHERE current_run_id IS NOT NULL;
;

CREATE TABLE task_attention_order (
  task_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  trigger_kind TEXT,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  current_run_status TEXT,
  trigger_enabled INTEGER,
  attention_weight INTEGER NOT NULL CHECK (attention_weight BETWEEN 1 AND 6),
  archived INTEGER GENERATED ALWAYS AS (archived_at IS NOT NULL) STORED,
  sort_at TEXT GENERATED ALWAYS AS (COALESCE(archived_at, updated_at)) STORED,
  sort_weight INTEGER GENERATED ALWAYS AS (
    CASE WHEN archived_at IS NULL THEN attention_weight ELSE 1 END
  ) STORED,
  lane TEXT GENERATED ALWAYS AS (
    CASE
      WHEN attention_weight >= 3 OR status IN ('paused', 'orphaned', 'failed', 'failed_with_unverified') THEN 'attention'
      WHEN trigger_enabled = 1 AND (current_run_status IS NULL OR current_run_status IN ('succeeded', 'cancelled')) THEN 'upcoming'
      WHEN status IN ('succeeded', 'succeeded_with_unverified', 'cancelled') THEN 'finished'
      WHEN status IN ('reserved', 'queued') THEN 'upcoming'
      WHEN attention_weight = 2 OR status IN ('running', 'settling', 'waiting') THEN 'running'
      ELSE 'upcoming'
    END
  ) STORED
);
;

CREATE INDEX task_attention_order_default
  ON task_attention_order(archived, sort_weight DESC, sort_at DESC, task_id DESC);
;
CREATE INDEX task_attention_order_status
  ON task_attention_order(archived, status, sort_weight DESC, sort_at DESC, task_id DESC);
;
CREATE INDEX task_attention_order_weight
  ON task_attention_order(archived, attention_weight, sort_weight DESC, sort_at DESC, task_id DESC);
;
CREATE INDEX task_attention_order_lane
  ON task_attention_order(archived, lane, sort_weight DESC, sort_at DESC, task_id DESC);
;
CREATE INDEX task_attention_order_trigger
  ON task_attention_order(archived, trigger_kind, sort_weight DESC, sort_at DESC, task_id DESC);
;

-- Keep the exclusions equivalent to UNVERIFIED_EFFECT in src/infra/db/unverified-effects.ts.
CREATE VIEW task_attention_facts AS
  SELECT t.task_id, t.status, t.trigger_kind, t.updated_at, t.archived_at,
    r.status AS current_run_status, tr.enabled AS trigger_enabled,
    CASE
      WHEN EXISTS (SELECT 1 FROM decisions d WHERE d.run_id = t.current_run_id
        AND d.status IN ('pending', 'acknowledged', 'blocked_for_human')) THEN 6
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

INSERT INTO task_attention_order (task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight)
  SELECT task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight FROM task_attention_facts;
;

-- Refresh a single task by key. All source triggers feed this view, which stores no state.
CREATE VIEW task_attention_refresh AS SELECT task_id FROM task_attention_order WHERE 0;
;
CREATE TRIGGER task_attention_refresh_insert INSTEAD OF INSERT ON task_attention_refresh
BEGIN
  INSERT INTO task_attention_order (task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight)
    SELECT task_id, status, trigger_kind, updated_at, archived_at, current_run_status, trigger_enabled, attention_weight
    FROM task_attention_facts WHERE task_id = NEW.task_id
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

CREATE VIEW task_attention_refresh_run AS SELECT current_run_id AS run_id FROM tasks WHERE 0;
;
CREATE TRIGGER task_attention_refresh_run_insert INSTEAD OF INSERT ON task_attention_refresh_run
BEGIN
  INSERT INTO task_attention_refresh SELECT task_id FROM tasks WHERE current_run_id = NEW.run_id;
END;
;

CREATE TRIGGER task_attention_tasks_insert AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_attention_refresh VALUES (NEW.task_id);
END;
;
CREATE TRIGGER task_attention_tasks_update
AFTER UPDATE OF task_id, status, current_run_id, updated_at, archived_at, trigger_kind ON tasks
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.status IS NOT NEW.status OR OLD.current_run_id IS NOT NEW.current_run_id
  OR OLD.updated_at IS NOT NEW.updated_at OR OLD.archived_at IS NOT NEW.archived_at OR OLD.trigger_kind IS NOT NEW.trigger_kind
BEGIN
  DELETE FROM task_attention_order WHERE task_id = OLD.task_id AND OLD.task_id IS NOT NEW.task_id;
  INSERT INTO task_attention_refresh VALUES (NEW.task_id);
END;
;
CREATE TRIGGER task_attention_tasks_delete AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_attention_order WHERE task_id = OLD.task_id;
END;
;

-- A subworkflow terminal change also changes its parent's effect classification.
CREATE TRIGGER task_attention_runs_insert
AFTER INSERT ON runs
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run VALUES (NEW.parent_run_id);
END;
;
CREATE TRIGGER task_attention_runs_update
AFTER UPDATE OF run_id, parent_run_id, status, parent_node_run_id ON runs
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.parent_run_id IS NOT NEW.parent_run_id
  OR OLD.status IS NOT NEW.status
  OR OLD.parent_node_run_id IS NOT NEW.parent_node_run_id
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.run_id WHERE OLD.run_id IS NOT NEW.run_id;
  INSERT INTO task_attention_refresh_run VALUES (NEW.parent_run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.parent_run_id WHERE OLD.parent_run_id IS NOT NEW.parent_run_id;
END;
;
CREATE TRIGGER task_attention_runs_delete
AFTER DELETE ON runs
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.run_id);
  INSERT INTO task_attention_refresh_run VALUES (OLD.parent_run_id);
END;
;

CREATE TRIGGER task_attention_node_runs_insert
AFTER INSERT ON node_runs
WHEN NEW.side_effect_policy <> 'pure' OR NEW.status = 'orphaned'
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
CREATE TRIGGER task_attention_node_runs_update
AFTER UPDATE OF run_id, node_run_id, node_id, node_type, status, replacement_node_run_id, side_effect_policy, side_effect_verified_none, stop_evidence ON node_runs
WHEN (OLD.side_effect_policy <> 'pure' OR NEW.side_effect_policy <> 'pure'
      OR OLD.status = 'orphaned' OR NEW.status = 'orphaned')
  AND (OLD.run_id IS NOT NEW.run_id
  OR OLD.node_run_id IS NOT NEW.node_run_id
  OR OLD.node_id IS NOT NEW.node_id
  OR OLD.node_type IS NOT NEW.node_type
  OR OLD.status IS NOT NEW.status
  OR OLD.replacement_node_run_id IS NOT NEW.replacement_node_run_id
  OR OLD.side_effect_policy IS NOT NEW.side_effect_policy
  OR OLD.side_effect_verified_none IS NOT NEW.side_effect_verified_none
  OR OLD.stop_evidence IS NOT NEW.stop_evidence)
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.run_id WHERE OLD.run_id IS NOT NEW.run_id;
END;
;
CREATE TRIGGER task_attention_node_runs_delete
AFTER DELETE ON node_runs
WHEN OLD.side_effect_policy <> 'pure' OR OLD.status = 'orphaned'
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.run_id);
END;
;

CREATE TRIGGER task_attention_decisions_insert
AFTER INSERT ON decisions
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
CREATE TRIGGER task_attention_decisions_update
AFTER UPDATE OF run_id, status ON decisions
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.run_id WHERE OLD.run_id IS NOT NEW.run_id;
END;
;
CREATE TRIGGER task_attention_decisions_delete
AFTER DELETE ON decisions
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.run_id);
END;
;

CREATE TRIGGER task_attention_unverified_resolutions_insert
AFTER INSERT ON unverified_resolutions
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
END;
;
CREATE TRIGGER task_attention_unverified_resolutions_update
AFTER UPDATE OF run_id, node_run_id ON unverified_resolutions
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.node_run_id IS NOT NEW.node_run_id
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.run_id WHERE OLD.run_id IS NOT NEW.run_id;
END;
;
CREATE TRIGGER task_attention_unverified_resolutions_delete
AFTER DELETE ON unverified_resolutions
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.run_id);
END;
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

CREATE TRIGGER task_attention_memory_batches_insert
AFTER INSERT ON memory_batches
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.memory_run_id);
END;
;
CREATE TRIGGER task_attention_memory_batches_update
AFTER UPDATE OF memory_run_id, apply_node_run_id, status ON memory_batches
WHEN OLD.memory_run_id IS NOT NEW.memory_run_id
  OR OLD.apply_node_run_id IS NOT NEW.apply_node_run_id
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (NEW.memory_run_id);
  INSERT INTO task_attention_refresh_run SELECT OLD.memory_run_id WHERE OLD.memory_run_id IS NOT NEW.memory_run_id;
END;
;
CREATE TRIGGER task_attention_memory_batches_delete
AFTER DELETE ON memory_batches
BEGIN
  INSERT INTO task_attention_refresh_run VALUES (OLD.memory_run_id);
END;
;

CREATE TRIGGER task_attention_memory_write_recoveries_insert
AFTER INSERT ON memory_write_recoveries
BEGIN
  INSERT INTO task_attention_refresh_run
    SELECT run_id FROM node_runs WHERE node_run_id = NEW.node_run_id;
END;
;
CREATE TRIGGER task_attention_memory_write_recoveries_update
AFTER UPDATE OF node_run_id, status ON memory_write_recoveries
WHEN OLD.node_run_id IS NOT NEW.node_run_id
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO task_attention_refresh_run
    SELECT run_id FROM node_runs WHERE node_run_id = NEW.node_run_id;
  INSERT INTO task_attention_refresh_run
    SELECT run_id FROM node_runs WHERE node_run_id = OLD.node_run_id AND OLD.node_run_id IS NOT NEW.node_run_id;
END;
;
CREATE TRIGGER task_attention_memory_write_recoveries_delete
AFTER DELETE ON memory_write_recoveries
BEGIN
  INSERT INTO task_attention_refresh_run
    SELECT run_id FROM node_runs WHERE node_run_id = OLD.node_run_id;
END;
;

CREATE TRIGGER task_attention_task_triggers_insert
AFTER INSERT ON task_triggers
BEGIN
  INSERT INTO task_attention_refresh VALUES (NEW.task_id);
END;
;
CREATE TRIGGER task_attention_task_triggers_update
AFTER UPDATE OF task_id, enabled ON task_triggers
WHEN OLD.task_id IS NOT NEW.task_id
  OR OLD.enabled IS NOT NEW.enabled
BEGIN
  INSERT INTO task_attention_refresh VALUES (NEW.task_id);
  INSERT INTO task_attention_refresh SELECT OLD.task_id WHERE OLD.task_id IS NOT NEW.task_id;
END;
;
CREATE TRIGGER task_attention_task_triggers_delete
AFTER DELETE ON task_triggers
BEGIN
  INSERT INTO task_attention_refresh VALUES (OLD.task_id);
END;
;
