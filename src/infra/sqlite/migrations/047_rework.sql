-- Rework is independent of execution failures; prior attempts and artifacts stay immutable.
CREATE TABLE rework_requests (
 request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
 requester_node_run_id TEXT REFERENCES node_runs(node_run_id), requester_actor TEXT NOT NULL, owner_actor TEXT NOT NULL,
 target_node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id), target_attempt INTEGER NOT NULL,
 source_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), source_artifact_hash TEXT NOT NULL,
 reason TEXT NOT NULL, expected_result TEXT NOT NULL, preserve_requirements_json TEXT NOT NULL,
 suggested_scope TEXT NOT NULL, approved_scope TEXT,
 status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 round_no INTEGER NOT NULL DEFAULT 1, max_rounds INTEGER NOT NULL DEFAULT 3, budget_remaining INTEGER NOT NULL DEFAULT 3,
 new_node_run_id TEXT REFERENCES node_runs(node_run_id), evidence_ids_json TEXT NOT NULL,
 verification_request_id TEXT REFERENCES collaboration_requests(request_id),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
;
CREATE UNIQUE INDEX rework_active_target ON rework_requests(target_node_run_id)
 WHERE status NOT IN ('closed','declined','cancelled');
;
CREATE INDEX rework_run_status ON rework_requests(run_id,status);
;
CREATE TABLE rework_attempts (
 attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES rework_requests(request_id), round_no INTEGER NOT NULL,
 old_node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id), new_node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
 source_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), source_artifact_hash TEXT NOT NULL,
 result_artifact_id TEXT REFERENCES artifacts(artifact_id), result_artifact_hash TEXT,
 status TEXT NOT NULL, feedback TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT,
 UNIQUE(request_id,round_no), UNIQUE(new_node_run_id)
);
;
CREATE TABLE rework_reviews (
 review_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES rework_requests(request_id), round_no INTEGER NOT NULL,
 reviewer_actor TEXT NOT NULL, artifact_id TEXT REFERENCES artifacts(artifact_id), artifact_hash TEXT,
 action TEXT NOT NULL, note TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
);
;
CREATE TRIGGER rework_attempt_identity BEFORE UPDATE ON rework_attempts
 WHEN NEW.attempt_id<>OLD.attempt_id OR NEW.request_id<>OLD.request_id OR NEW.round_no<>OLD.round_no
 OR NEW.old_node_run_id<>OLD.old_node_run_id OR NEW.new_node_run_id<>OLD.new_node_run_id
 OR NEW.source_artifact_id<>OLD.source_artifact_id OR NEW.source_artifact_hash<>OLD.source_artifact_hash
 OR NEW.feedback<>OLD.feedback OR NEW.created_at<>OLD.created_at
 OR (OLD.result_artifact_id IS NOT NULL AND (NEW.result_artifact_id IS NOT OLD.result_artifact_id OR NEW.result_artifact_hash IS NOT OLD.result_artifact_hash))
 BEGIN SELECT RAISE(ABORT,'immutable rework attempt identity'); END;
;
CREATE TRIGGER rework_attempt_no_delete BEFORE DELETE ON rework_attempts BEGIN SELECT RAISE(ABORT,'immutable rework attempt'); END;
;
CREATE TRIGGER rework_reviews_no_update BEFORE UPDATE ON rework_reviews BEGIN SELECT RAISE(ABORT,'immutable rework review'); END;
;
CREATE TRIGGER rework_reviews_no_delete BEFORE DELETE ON rework_reviews BEGIN SELECT RAISE(ABORT,'immutable rework review'); END;
