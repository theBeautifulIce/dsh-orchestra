/** Outstanding effects for a node_runs row aliased as n. */
export const UNVERIFIED_EFFECT = `n.side_effect_policy <> 'pure'
  AND NOT (n.side_effect_verified_none = 1 AND COALESCE(length(trim(n.stop_evidence)), 0) > 0)
  AND NOT EXISTS (SELECT 1 FROM unverified_resolutions ur WHERE ur.node_run_id = n.node_run_id)
  AND NOT (n.node_id = 'mem_apply' AND n.status = 'superseded' AND EXISTS (
    SELECT 1 FROM memory_write_recoveries mw WHERE mw.node_run_id = n.node_run_id
      AND mw.status = 'confirmed_not_applied'
  ))
  AND NOT (n.node_id = 'mem_apply' AND n.status = 'done' AND EXISTS (
    SELECT 1 FROM memory_batches b WHERE b.apply_node_run_id = n.node_run_id
      AND b.memory_run_id = n.run_id AND b.status = 'applied'
  ))
  AND NOT (n.node_type = 'subworkflow' AND n.status = 'done' AND n.side_effect_verified_none = 1 AND EXISTS (
    SELECT 1 FROM runs child WHERE child.parent_node_run_id = n.node_run_id
      AND child.parent_run_id = n.run_id AND child.status IN ('succeeded','succeeded_with_unverified')
  ))`

/**
 * 这个步骤真的发生过对外动作吗（T03）。
 * 排除的是「还没开始」的形态：排队、等待、已派发未接手，以及只领到租约、
 * 既没有开始执行记录也没有工具执行记录的步骤。一旦有过开始/心跳/工具记录，就按真实动作算。
 * 派发前取消和控制节点取消有明确的账本事件，不能因为收口成 superseded 就反算成已执行。
 * 与 078 迁移里的投影谓词保持一致；未知结果仍按原有保守规则计入。
 */
export const EXTERNAL_EFFECT_OCCURRED = `n.status NOT IN ('queued', 'blocked_pre', 'dispatched', 'waiting')
  AND NOT (n.status = 'leased' AND n.started_at IS NULL AND n.heartbeat_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM tool_executions e WHERE e.node_run_id = n.node_run_id AND e.attempt = n.attempt))
  AND NOT (n.status = 'superseded' AND n.started_at IS NULL AND n.heartbeat_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM tool_executions e WHERE e.node_run_id = n.node_run_id AND e.attempt = n.attempt)
    AND EXISTS (SELECT 1 FROM node_run_events ev WHERE ev.node_run_id = n.node_run_id
      AND (ev.type = 'cancel_before_dispatch'
        OR (ev.type = 'cancel_control_node' AND n.node_type IN ('wait','subworkflow','parallel')))))`

/** 人读投影用：既要有未结算副作用，也必须真的发生过动作。 */
export const UNVERIFIED_EFFECT_OCCURRED = `${UNVERIFIED_EFFECT}\n  AND ${EXTERNAL_EFFECT_OCCURRED}`
