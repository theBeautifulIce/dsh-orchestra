-- Preserve existing plan JSON and canonical hashes. New structured plans use version 2.
ALTER TABLE task_plans ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
