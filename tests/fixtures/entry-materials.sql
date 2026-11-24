CREATE TABLE plan_materials (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, draft TEXT NOT NULL,
  name TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, expires_ms INTEGER NOT NULL,
  run_id TEXT REFERENCES runs(run_id), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  UNIQUE(actor,scope,draft,name,digest)
);
CREATE TABLE plan_material_nodes (
  material_id TEXT NOT NULL REFERENCES plan_materials(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id), node_id TEXT NOT NULL,
  PRIMARY KEY(material_id,run_id,node_id)
);
