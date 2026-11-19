CREATE TABLE rework_extra_steps (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL UNIQUE REFERENCES node_runs(node_run_id),
  request_id TEXT NOT NULL REFERENCES rework_requests(request_id),
  plan_hash TEXT NOT NULL REFERENCES rework_local_plans(plan_hash),
  before_node_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  workflow_definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,node_id),
  CHECK(node_id <> before_node_id)
);
;
CREATE TRIGGER rework_extra_steps_authority BEFORE INSERT ON rework_extra_steps
WHEN NOT EXISTS (
 SELECT 1 FROM rework_local_plans p JOIN rework_requests q ON q.request_id=p.request_id
 JOIN runs r ON r.run_id=q.run_id JOIN node_runs n ON n.node_run_id=NEW.node_run_id
 WHERE p.plan_hash=NEW.plan_hash AND p.request_id=NEW.request_id AND p.approved_by=q.owner_actor
 AND q.run_id=NEW.run_id AND q.approved_scope='replan_subgraph' AND q.status IN ('authorized','scheduled')
 AND r.status='running' AND r.cancel_requested_at IS NULL AND r.workflow_definition_hash=NEW.workflow_definition_hash
 AND n.run_id=NEW.run_id AND n.node_id=NEW.node_id AND n.node_type='agent' AND n.attempt=1
 AND EXISTS(SELECT 1 FROM json_each(p.proposal_json,'$.insert_steps') s
 WHERE json_extract(s.value,'$.node_id')=NEW.node_id
 AND json_extract(s.value,'$.before_node_id')=NEW.before_node_id
 AND json_extract(s.value,'$.instruction')=NEW.instruction)
)
BEGIN SELECT RAISE(ABORT,'extra step requires exact approved plan lineage'); END;
;
CREATE TRIGGER rework_extra_steps_no_update BEFORE UPDATE ON rework_extra_steps
BEGIN SELECT RAISE(ABORT,'extra step lineage is immutable'); END;
;
CREATE TRIGGER rework_extra_steps_no_delete BEFORE DELETE ON rework_extra_steps
BEGIN SELECT RAISE(ABORT,'extra step lineage is immutable'); END;
