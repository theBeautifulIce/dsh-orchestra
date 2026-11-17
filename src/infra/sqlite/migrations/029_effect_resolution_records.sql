-- S5 Task 3: durable human attestations and immutable resolution facts for uncertain side effects.
CREATE TABLE attestations (
  attestation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  claim TEXT NOT NULL CHECK (length(trim(claim)) BETWEEN 1 AND 256),
  attested_by TEXT NOT NULL CHECK (length(trim(attested_by)) BETWEEN 1 AND 256),
  attested_at TEXT NOT NULL,
  action_start_source TEXT NOT NULL CHECK (action_start_source = 'human_attested'),
  summary TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 4096),
  created_at TEXT NOT NULL
);
;

CREATE TRIGGER attestations_attempt_guard
BEFORE INSERT ON attestations
WHEN NOT EXISTS (
  SELECT 1 FROM node_runs n
  WHERE n.node_run_id = NEW.node_run_id AND n.run_id = NEW.run_id AND n.attempt = NEW.attempt
)
BEGIN
  SELECT RAISE(ABORT, 'ATTESTATION_ATTEMPT_MISMATCH');
END;
;

CREATE INDEX attestations_node_attempt_created ON attestations(node_run_id, attempt, created_at);
;

CREATE TRIGGER attestations_no_update
BEFORE UPDATE ON attestations
BEGIN
  SELECT RAISE(ABORT, 'ATTESTATION_IMMUTABLE');
END;
;

CREATE TRIGGER attestations_no_delete
BEFORE DELETE ON attestations
BEGIN
  SELECT RAISE(ABORT, 'ATTESTATION_IMMUTABLE');
END;
;

CREATE TABLE unverified_resolutions (
  node_run_id TEXT PRIMARY KEY REFERENCES node_runs(node_run_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  resolution_basis TEXT NOT NULL CHECK (resolution_basis IN ('verified_none', 'evidence', 'decision')),
  evidence_id TEXT,
  decision_id TEXT REFERENCES decisions(decision_id),
  stop_evidence TEXT,
  resolved_at TEXT NOT NULL,
  CHECK (
    (resolution_basis = 'verified_none' AND stop_evidence IS NOT NULL AND length(trim(stop_evidence)) > 0 AND evidence_id IS NULL AND decision_id IS NULL)
    OR (resolution_basis = 'evidence' AND evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0 AND decision_id IS NULL AND stop_evidence IS NULL)
    OR (resolution_basis = 'decision' AND decision_id IS NOT NULL AND evidence_id IS NULL AND stop_evidence IS NULL)
  )
);
;

CREATE TRIGGER unverified_resolution_scope_guard
BEFORE INSERT ON unverified_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM node_runs n
  WHERE n.node_run_id = NEW.node_run_id AND n.run_id = NEW.run_id
)
OR (NEW.resolution_basis = 'verified_none' AND NOT EXISTS (
  SELECT 1 FROM node_runs n
  WHERE n.node_run_id = NEW.node_run_id AND n.run_id = NEW.run_id
    AND n.side_effect_verified_none = 1 AND n.stop_evidence = NEW.stop_evidence
))
OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM decisions d
  WHERE d.decision_id = NEW.decision_id AND d.run_id = NEW.run_id
    AND (d.node_run_id IS NULL OR d.node_run_id = NEW.node_run_id)
))
BEGIN
  SELECT RAISE(ABORT, 'UNVERIFIED_RESOLUTION_SCOPE_MISMATCH');
END;
;

CREATE INDEX unverified_resolutions_run_resolved ON unverified_resolutions(run_id, resolved_at);
;

CREATE TRIGGER unverified_resolutions_no_update
BEFORE UPDATE ON unverified_resolutions
BEGIN
  SELECT RAISE(ABORT, 'UNVERIFIED_RESOLUTION_IMMUTABLE');
END;
;

CREATE TRIGGER unverified_resolutions_no_delete
BEFORE DELETE ON unverified_resolutions
BEGIN
  SELECT RAISE(ABORT, 'UNVERIFIED_RESOLUTION_IMMUTABLE');
END;
;
