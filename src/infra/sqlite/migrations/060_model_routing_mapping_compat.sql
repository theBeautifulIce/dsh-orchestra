-- The signed S5 settings reader rejects additional keys in mapping_json.
-- Keep S6-only settings in an additive column so an S5 save preserves them.
ALTER TABLE model_routing_settings
  ADD COLUMN extended_mapping_json TEXT NOT NULL DEFAULT '{"advanced":null,"expert":null}'
  CHECK (json_valid(extended_mapping_json) AND json_type(extended_mapping_json) = 'object');
;

UPDATE model_routing_settings
SET extended_mapping_json = json_object(
      'advanced', json_extract(mapping_json, '$.advanced'),
      'expert', json_extract(mapping_json, '$.expert')
    ),
    mapping_json = json_remove(mapping_json, '$.advanced', '$.expert')
WHERE json_type(mapping_json, '$.advanced') IS NOT NULL
   OR json_type(mapping_json, '$.expert') IS NOT NULL;
