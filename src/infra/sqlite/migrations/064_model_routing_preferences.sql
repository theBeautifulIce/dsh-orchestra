ALTER TABLE model_routing_settings ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(preferences_json) AND json_type(preferences_json) = 'object');
