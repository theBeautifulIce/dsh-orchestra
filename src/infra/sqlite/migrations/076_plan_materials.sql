CREATE TABLE plan_materials (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, draft TEXT NOT NULL,
  name TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, expires_ms INTEGER NOT NULL,
  run_id TEXT REFERENCES runs(run_id), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  UNIQUE(actor,scope,draft,name,digest)
);
;
CREATE TABLE plan_material_nodes (
  material_id TEXT NOT NULL REFERENCES plan_materials(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id), node_id TEXT NOT NULL,
  PRIMARY KEY(material_id,run_id,node_id)
);
;

CREATE TABLE task_plan_draft_end (
  plan_id TEXT PRIMARY KEY REFERENCES task_plans(plan_id),
  successor_id TEXT UNIQUE REFERENCES task_plans(plan_id),
  request_hash TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  CHECK (successor_id IS NULL OR successor_id <> plan_id)
);
;
CREATE INDEX task_plan_draft_page ON task_plans(created_by, created_at DESC, plan_id DESC);
;
CREATE TRIGGER refuse_closed_plan_start BEFORE INSERT ON start_run_operations
WHEN EXISTS (SELECT 1 FROM task_plans p JOIN task_plan_draft_end e USING (plan_id)
             WHERE p.launch_operation_id=NEW.operation_id)
BEGIN
  SELECT RAISE(ABORT, 'task plan is no longer active');
END;

;
CREATE INDEX plan_materials_expiry ON plan_materials(expires_ms) WHERE body<>'';
