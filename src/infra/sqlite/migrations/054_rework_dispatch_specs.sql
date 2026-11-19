CREATE TABLE rework_dispatch_specs (
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 node_id TEXT NOT NULL,
 workflow_definition_hash TEXT NOT NULL,
 spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
 tool_bindings_json TEXT NOT NULL CHECK(json_valid(tool_bindings_json)),
 spec_hash TEXT NOT NULL,
 authority_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,node_id)
);
;
CREATE TRIGGER rework_dispatch_specs_no_update BEFORE UPDATE ON rework_dispatch_specs
BEGIN SELECT RAISE(ABORT,'manual dispatch grants are immutable'); END;
;
CREATE TRIGGER rework_dispatch_specs_no_delete BEFORE DELETE ON rework_dispatch_specs
BEGIN SELECT RAISE(ABORT,'manual dispatch grants are immutable'); END;

;
CREATE TABLE rework_dispatch_invalidations (
 run_id TEXT NOT NULL,
 node_id TEXT NOT NULL,
 observed_spec_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,node_id),
 FOREIGN KEY(run_id,node_id) REFERENCES rework_dispatch_specs(run_id,node_id)
);
;
CREATE TRIGGER rework_dispatch_invalidations_no_update BEFORE UPDATE ON rework_dispatch_invalidations
BEGIN SELECT RAISE(ABORT,'manual dispatch invalidations are immutable'); END;
;
CREATE TRIGGER rework_dispatch_invalidations_no_delete BEFORE DELETE ON rework_dispatch_invalidations
BEGIN SELECT RAISE(ABORT,'manual dispatch invalidations are immutable'); END;
