CREATE TABLE rework_inspections (
 inspection_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
 artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
 artifact_hash TEXT NOT NULL,
 reviewer_actor TEXT NOT NULL,
 criteria TEXT NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('pass','request_changes')),
 summary TEXT NOT NULL,
 request_id TEXT REFERENCES rework_requests(request_id),
 snapshot_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK((verdict='request_changes')=(request_id IS NOT NULL))
);
;
CREATE INDEX rework_inspections_run ON rework_inspections(run_id,created_at DESC,inspection_id DESC);
;
CREATE TRIGGER rework_inspections_no_update BEFORE UPDATE ON rework_inspections BEGIN SELECT RAISE(ABORT,'immutable rework inspection'); END;
;
CREATE TRIGGER rework_inspections_no_delete BEFORE DELETE ON rework_inspections BEGIN SELECT RAISE(ABORT,'immutable rework inspection'); END;
