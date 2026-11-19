CREATE TABLE task_triggers (
  trigger_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  workflow_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'event')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  daily_time TEXT,
  time_zone TEXT,
  event_type TEXT,
  next_fire_at TEXT,
  last_fired_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version),
  CHECK ((kind = 'scheduled' AND daily_time IS NOT NULL AND time_zone IS NOT NULL AND event_type IS NULL)
      OR (kind = 'event' AND daily_time IS NULL AND time_zone IS NULL AND next_fire_at IS NULL AND event_type IS NOT NULL))
);
;
CREATE INDEX task_triggers_due ON task_triggers (next_fire_at, trigger_id) WHERE kind = 'scheduled' AND enabled = 1;
;
CREATE INDEX task_triggers_event ON task_triggers (event_type, trigger_id) WHERE kind = 'event' AND enabled = 1;
;
CREATE TABLE task_trigger_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  received_by TEXT NOT NULL
);
;
CREATE TABLE task_trigger_occurrences (
  trigger_id TEXT NOT NULL REFERENCES task_triggers(trigger_id),
  occurrence_key TEXT NOT NULL,
  source_event_id TEXT REFERENCES task_trigger_events(event_id),
  due_at TEXT NOT NULL,
  run_id TEXT UNIQUE REFERENCES runs(run_id),
  status TEXT NOT NULL CHECK (status IN ('started', 'skipped')),
  reason TEXT CHECK (reason IN ('task_archived', 'previous_run_active', 'unresolved_effects', 'workflow_inactive')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, occurrence_key),
  CHECK ((status = 'started' AND run_id IS NOT NULL AND reason IS NULL)
      OR (status = 'skipped' AND run_id IS NULL AND reason IS NOT NULL))
);
;
CREATE INDEX task_trigger_occurrences_event ON task_trigger_occurrences (source_event_id, trigger_id) WHERE source_event_id IS NOT NULL;
