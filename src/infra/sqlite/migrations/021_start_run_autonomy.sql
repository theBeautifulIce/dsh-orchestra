-- 021：任务自治档位、升级规则、决策批准人与起运行幂等键（规格 18.3 / 18.4）
ALTER TABLE tasks ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'autonomous'
  CHECK (autonomy IN ('autonomous', 'assisted', 'supervised'));
ALTER TABLE tasks ADD COLUMN escalations_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE decisions ADD COLUMN approver TEXT NOT NULL DEFAULT 'either'
  CHECK (
    approver = 'human' OR approver = 'either' OR
    (approver LIKE 'agent:%' AND length(approver) > 6)
  );
ALTER TABLE decisions ADD COLUMN resolved_by TEXT;
ALTER TABLE decisions ADD COLUMN confirm_required INTEGER NOT NULL DEFAULT 0
  CHECK (confirm_required IN (0, 1));

CREATE TABLE start_run_operations (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
