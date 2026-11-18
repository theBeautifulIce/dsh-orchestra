/** Outstanding effects for a node_runs row aliased as n. */
export const UNVERIFIED_EFFECT = `n.side_effect_policy <> 'pure'
  AND NOT (n.side_effect_verified_none = 1 AND COALESCE(length(trim(n.stop_evidence)), 0) > 0)
  AND NOT EXISTS (SELECT 1 FROM unverified_resolutions ur WHERE ur.node_run_id = n.node_run_id)
  AND NOT (n.node_id = 'mem_apply' AND n.status = 'done' AND EXISTS (
    SELECT 1 FROM memory_batches b WHERE b.apply_node_run_id = n.node_run_id
      AND b.memory_run_id = n.run_id AND b.status = 'applied'
  ))
  AND NOT (n.node_type = 'subworkflow' AND n.status = 'done' AND n.side_effect_verified_none = 1 AND EXISTS (
    SELECT 1 FROM runs child WHERE child.parent_node_run_id = n.node_run_id
      AND child.parent_run_id = n.run_id AND child.status IN ('succeeded','succeeded_with_unverified')
  ))`
