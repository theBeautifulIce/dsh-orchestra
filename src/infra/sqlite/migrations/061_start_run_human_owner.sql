-- Existing and automatic starts have no verified human provenance.
ALTER TABLE start_run_operations ADD COLUMN started_by TEXT CHECK (
  started_by IS NULL OR (length(started_by) BETWEEN 1 AND 256
    AND started_by = trim(started_by) AND lower(started_by) NOT LIKE 'service:%'
    AND lower(started_by) NOT LIKE 'agent:%' AND lower(started_by) NOT LIKE 'system:%')
);
CREATE TRIGGER start_run_human_owner_immutable
BEFORE UPDATE OF started_by ON start_run_operations
WHEN OLD.started_by IS NOT NEW.started_by
BEGIN
  SELECT RAISE(ABORT, 'start_run_human_owner_immutable');
END;
