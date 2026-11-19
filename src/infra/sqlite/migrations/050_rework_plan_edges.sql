-- Approved local plans may only add dependencies; the published base DAG stays immutable.
CREATE TABLE rework_plan_edges (
  request_id TEXT NOT NULL REFERENCES rework_requests(request_id),
  plan_hash TEXT NOT NULL REFERENCES rework_local_plans(plan_hash),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  PRIMARY KEY (request_id, plan_hash, from_node_id, to_node_id),
  CHECK (from_node_id <> to_node_id)
);
;
CREATE INDEX rework_plan_edges_run ON rework_plan_edges(run_id, to_node_id);
;
CREATE TRIGGER rework_plan_edges_authorized BEFORE INSERT ON rework_plan_edges
WHEN NOT EXISTS (
 SELECT 1 FROM rework_local_plans p JOIN rework_requests r ON r.request_id=p.request_id
 WHERE p.plan_hash=NEW.plan_hash AND p.request_id=NEW.request_id
 AND p.approved_by IS NOT NULL AND r.run_id=NEW.run_id
) OR NOT EXISTS (
 SELECT 1 FROM node_runs n WHERE n.run_id=NEW.run_id AND n.node_id=NEW.from_node_id
) OR NOT EXISTS (
 SELECT 1 FROM node_runs n WHERE n.run_id=NEW.run_id AND n.node_id=NEW.to_node_id
)
BEGIN SELECT RAISE(ABORT, 'local dependency requires a matching approved run plan'); END;
;
CREATE TRIGGER rework_plan_edges_no_update BEFORE UPDATE ON rework_plan_edges
BEGIN SELECT RAISE(ABORT, 'approved local dependencies are immutable'); END;
;
CREATE TRIGGER rework_plan_edges_no_delete BEFORE DELETE ON rework_plan_edges
BEGIN SELECT RAISE(ABORT, 'approved local dependencies are immutable'); END;
