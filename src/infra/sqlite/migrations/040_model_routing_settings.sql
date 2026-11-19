CREATE TABLE model_routing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  mapping_json TEXT NOT NULL CHECK (json_valid(mapping_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
