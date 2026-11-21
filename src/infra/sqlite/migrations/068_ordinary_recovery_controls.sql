ALTER TABLE node_runs ADD COLUMN wait_extensions INTEGER NOT NULL DEFAULT 0 CHECK (wait_extensions >= 0);
ALTER TABLE node_runs ADD COLUMN action_start_source TEXT CHECK (action_start_source IN ('human_confirmed', 'human_attested'));
