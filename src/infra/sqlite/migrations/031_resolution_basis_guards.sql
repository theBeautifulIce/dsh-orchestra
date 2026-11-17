-- Fail closed on resolution rows whose cited facts are not in the same execution scope.
-- Event-chain validation still belongs in the service write transaction, where the ledger secret is available.
CREATE TRIGGER unverified_resolution_basis_guard
BEFORE INSERT ON unverified_resolutions
WHEN (NEW.resolution_basis = 'evidence' AND NOT EXISTS (
  SELECT 1
  FROM tool_executions t
  JOIN node_runs n ON n.node_run_id = t.node_run_id
  WHERE t.execution_id = NEW.evidence_id
    AND t.node_run_id = NEW.node_run_id
    AND t.attempt = n.attempt
    AND n.run_id = NEW.run_id
    AND t.finished_at IS NOT NULL
))
OR (NEW.resolution_basis = 'decision' AND NOT EXISTS (
  SELECT 1 FROM decisions d
  WHERE d.decision_id = NEW.decision_id
    AND d.run_id = NEW.run_id
    AND (d.node_run_id IS NULL OR d.node_run_id = NEW.node_run_id)
    AND d.status = 'resolved'
    AND d.decided_at IS NOT NULL
))
BEGIN
  SELECT RAISE(ABORT, 'UNVERIFIED_RESOLUTION_BASIS_INVALID');
END;
;
