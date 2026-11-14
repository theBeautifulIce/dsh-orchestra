-- 020_compensations.sql —— 补偿幂等执行与「无可执行补偿」标记（S3 Task 11，规格 4.7）
CREATE TABLE IF NOT EXISTS compensations (
  compensation_id TEXT,
  node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('executable', 'none')),
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  descriptor_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'applied', 'failed', 'unverified', 'skipped')),
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'executable' AND compensation_id IS NOT NULL)
    OR (kind = 'none' AND compensation_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS compensations_id_uq
  ON compensations(compensation_id) WHERE compensation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS compensations_none_uq
  ON compensations(node_run_id, attempt) WHERE kind = 'none';
CREATE INDEX IF NOT EXISTS compensations_node_idx
  ON compensations(node_run_id, attempt, created_at);
