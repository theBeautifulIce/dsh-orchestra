-- S5 Task 11: durable approval ledger for governed memory writes.
CREATE TABLE memory_batches (
  batch_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  source_run_id TEXT NOT NULL REFERENCES runs(run_id),
  memory_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  prepare_node_run_id TEXT REFERENCES node_runs(node_run_id),
  confirm_node_run_id TEXT REFERENCES node_runs(node_run_id),
  apply_node_run_id TEXT REFERENCES node_runs(node_run_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'draft','evaluating','awaiting_human','approved','applying','applied',
    'empty','blocked','declined','expired','failed','indeterminate'
  )),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'written','nothing_to_write','blocked','declined','expired','failed','indeterminate'
  )),
  proposal_hash TEXT,
  approved_proposal_hash TEXT,
  approved_item_hashes_json TEXT CHECK (
    approved_item_hashes_json IS NULL OR (json_valid(approved_item_hashes_json) AND json_type(approved_item_hashes_json) = 'array')
  ),
  policy_json TEXT CHECK (policy_json IS NULL OR json_valid(policy_json)),
  evaluation_id TEXT REFERENCES memory_evaluations(evaluation_id),
  decision_id TEXT REFERENCES decisions(decision_id),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  applied_at TEXT,
  UNIQUE (source_run_id, attempt),
  CHECK (
    (status IN ('draft','evaluating','awaiting_human','approved','applying') AND outcome IS NULL)
    OR (status = 'applied' AND outcome = 'written')
    OR (status = 'empty' AND outcome = 'nothing_to_write')
    OR (status = 'blocked' AND outcome = 'blocked')
    OR (status = 'declined' AND outcome = 'declined')
    OR (status = 'expired' AND outcome = 'expired')
    OR (status = 'failed' AND outcome = 'failed')
    OR (status = 'indeterminate' AND outcome = 'indeterminate')
  ),
  CHECK ((approved_proposal_hash IS NULL) = (approved_item_hashes_json IS NULL)),
  CHECK (
    status NOT IN ('approved','applying','applied','indeterminate')
    OR (approved_proposal_hash IS NOT NULL AND approved_item_hashes_json IS NOT NULL)
  )
);
;

CREATE TABLE memory_items (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES memory_batches(batch_id),
  client_key TEXT NOT NULL CHECK (
    length(client_key) BETWEEN 1 AND 64 AND client_key NOT GLOB '*[^a-z0-9_-]*'
  ),
  action TEXT NOT NULL CHECK (action IN ('create','update')),
  target_id TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('L2','L4','L5','L6')),
  title TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 65536),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(questions_json) AND json_type(questions_json) = 'array'),
  key TEXT,
  importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
  ttl_days INTEGER CHECK (ttl_days IS NULL OR ttl_days > 0),
  quote TEXT,
  reason TEXT,
  content_hash TEXT NOT NULL,
  approved_content_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','skipped','applied','failed')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('approve','reject','merge','needs_user')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  judge_reason TEXT,
  applied_item_id TEXT,
  UNIQUE (batch_id, client_key),
  CHECK ((action = 'create' AND target_id IS NULL) OR (action = 'update' AND target_id IS NOT NULL AND length(trim(target_id)) > 0))
);
;

CREATE TABLE memory_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES memory_batches(batch_id),
  eval_attempt INTEGER NOT NULL CHECK (eval_attempt >= 1),
  request_hash TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response_json TEXT CHECK (
    response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= 65536)
  ),
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('ready','empty','blocked')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, eval_attempt)
);
;

CREATE TABLE memory_run_requests (
  source_run_id TEXT NOT NULL REFERENCES runs(run_id),
  request_key TEXT NOT NULL CHECK (
    length(request_key) BETWEEN 1 AND 64 AND request_key NOT GLOB '*[^a-z0-9_-]*'
  ),
  memory_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_run_id, request_key)
);
;

CREATE INDEX memory_batches_memory_run_idx ON memory_batches(memory_run_id);
;
CREATE INDEX memory_batches_task_created_idx ON memory_batches(task_id, created_at DESC, batch_id DESC);
;
CREATE INDEX memory_items_batch_status_idx ON memory_items(batch_id, status, client_key);
;
CREATE INDEX memory_evaluations_batch_attempt_idx ON memory_evaluations(batch_id, eval_attempt DESC);
;

-- Snapshot fields are set exactly once by the approval transaction.
CREATE TRIGGER memory_batches_approval_snapshot_immutable
BEFORE UPDATE OF approved_proposal_hash, approved_item_hashes_json ON memory_batches
WHEN OLD.status <> 'awaiting_human'
  OR NEW.status <> 'approved'
  OR OLD.approved_proposal_hash IS NOT NULL
  OR OLD.approved_item_hashes_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;
;

CREATE TRIGGER memory_items_no_insert_after_approval
BEFORE INSERT ON memory_items
WHEN EXISTS (
  SELECT 1 FROM memory_batches
  WHERE batch_id = NEW.batch_id AND status IN ('approved','applying','applied','indeterminate')
)
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;
;

CREATE TRIGGER memory_items_no_delete_after_approval
BEFORE DELETE ON memory_items
WHEN EXISTS (
  SELECT 1 FROM memory_batches
  WHERE batch_id = OLD.batch_id AND status IN ('approved','applying','applied','indeterminate')
)
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;
;

CREATE TRIGGER memory_items_proposal_immutable_after_approval
BEFORE UPDATE OF client_key, action, target_id, layer, title, content, tags_json,
  questions_json, key, importance, ttl_days, quote, reason, content_hash,
  approved_content_hash, verdict, confidence, judge_reason ON memory_items
WHEN EXISTS (
  SELECT 1 FROM memory_batches
  WHERE batch_id = OLD.batch_id AND status IN ('approved','applying','applied','indeterminate')
)
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_APPLY_BINDING_INVALID');
END;
;
