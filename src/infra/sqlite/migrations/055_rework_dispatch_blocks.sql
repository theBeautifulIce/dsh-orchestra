CREATE TABLE rework_dispatch_blocks (
 request_id TEXT NOT NULL REFERENCES rework_requests(request_id),
 node_run_id TEXT NOT NULL REFERENCES node_runs(node_run_id),
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 node_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at TEXT NOT NULL,
 resolved_at TEXT,
 PRIMARY KEY(request_id,node_run_id)
);
;
CREATE INDEX rework_dispatch_blocks_pending ON rework_dispatch_blocks(run_id,node_id,resolved_at);
