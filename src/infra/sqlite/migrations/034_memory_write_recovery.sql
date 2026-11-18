-- One reconciliation per apply attempt, bound to the writer fence and ledger evidence.
CREATE TABLE memory_write_recoveries (
  node_run_id TEXT PRIMARY KEY REFERENCES node_runs(node_run_id),
  batch_id TEXT NOT NULL REFERENCES memory_batches(batch_id),
  evidence_id TEXT NOT NULL UNIQUE,
  stopped_at TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id),
  abandon_ack_id TEXT UNIQUE REFERENCES decisions(decision_id),
  status TEXT NOT NULL CHECK (status IN (
    'inspected', 'confirmed_applied', 'confirmed_not_applied', 'abandoned', 'acknowledged'
  ))
);
;
