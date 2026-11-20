CREATE TABLE chat_task_receipts (
  message_key TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL UNIQUE REFERENCES task_plans(plan_id),
  reported_key TEXT
);
