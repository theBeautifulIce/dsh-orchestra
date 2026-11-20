ALTER TABLE model_routing_settings
  ADD COLUMN model_notes_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(model_notes_json) AND json_type(model_notes_json) = 'array');
