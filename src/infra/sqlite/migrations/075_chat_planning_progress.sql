CREATE TABLE chat_planning_progress (
  request_key TEXT PRIMARY KEY, actor TEXT NOT NULL, scope TEXT NOT NULL,
  input_hash TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN
  ('planning','approval','started','failed','declined','cancelled','blocked')),
  run_id TEXT, plan_id TEXT REFERENCES task_plans(plan_id), title TEXT NOT NULL DEFAULT '', updated_ms INTEGER NOT NULL
);
;
CREATE INDEX chat_planning_progress_scope ON chat_planning_progress(actor,scope,updated_ms DESC);
;
