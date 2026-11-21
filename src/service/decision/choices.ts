import type { Resolution } from '../commands/decisions.ts'

export type DecisionChoiceContext = {
  kind: unknown
  status: unknown
  approver: unknown
  expires_at: unknown
  memory_approval_status: unknown
  memory_recovery: unknown
  registered_report?: unknown
  report_original_available?: unknown
  workflow_branch?: unknown
}

export type MemoryDecisionAccess = boolean | 'proposal_only'
export function panelDecisionOptions(decision: DecisionChoiceContext, now: number, memoryEnabled: MemoryDecisionAccess): {
  choices: Resolution[]; unavailableReason: string | null
} {
  const unavailable = (unavailableReason: string) => ({ choices: [], unavailableReason })
  const restricted = panelDecisionRestriction(decision, now)
  if (restricted) return unavailable(restricted)
  if (isEffectDecision(decision)) return unavailable('此裁决必须提交对应节点的系统核验证据。')
  if (decision.kind === 'report_contradicted') return decision.registered_report === 1
    ? { choices: decision.report_original_available === 1 ? ['uphold_report', 'uphold_decision'] : ['uphold_report'], unavailableReason: null }
    : unavailable('这张冲突卡缺少可核验的报告登记。')
  if (decision.kind === 'rule_ambiguous' && decision.workflow_branch === 1) {
    return { choices: ['approved', 'rejected'], unavailableReason: null }
  }
  if (memoryEnabled === 'proposal_only' && decision.kind === 'audit_result' && decision.memory_approval_status === 'awaiting_human') {
    return { choices: ['rejected'], unavailableReason: '当前试用圈只开放记忆提议。' }
  }
  if (decision.kind === 'pre_execution' || (decision.kind === 'audit_result' && (decision.memory_approval_status === null
    || (memoryEnabled && decision.memory_approval_status === 'awaiting_human')))) {
    return { choices: ['approved', 'rejected'], unavailableReason: null }
  }
  return unavailable('此裁决类型没有可从审批中心安全执行的操作。')
}

export function isEffectDecision(decision: DecisionChoiceContext): boolean {
  return decision.kind === 'verify_human' || decision.kind === 'action_overrun'
}

export function panelDecisionRestriction(decision: DecisionChoiceContext, now: number): string | null {
  if (!['pending', 'acknowledged', 'blocked_for_human'].includes(String(decision.status))) {
    return '这条裁决已结束。'
  }
  if (decision.approver !== 'human' && decision.approver !== 'either') return '此裁决由授权核验主体处理。'
  if (typeof decision.expires_at === 'string' && !(Date.parse(decision.expires_at) > now)) return '这条裁决已到期。'
  if (decision.memory_recovery === 1) return '请在记忆页完成对账后处理。'
  return null
}

// Both the read model and the write policy use the same batch/decision association.
export const DECISION_CHOICE_COLUMNS = '(SELECT b.status FROM memory_batches b WHERE b.decision_id = d.decision_id) AS memory_approval_status, '
  + 'EXISTS (SELECT 1 FROM memory_write_recoveries m WHERE m.decision_id = d.decision_id OR m.abandon_ack_id = d.decision_id) AS memory_recovery'
  + ", CASE WHEN d.kind = 'report_contradicted' AND json_valid(d.payload_json) THEN EXISTS ("
  + "SELECT 1 FROM report_registry p WHERE p.report_id = json_extract(d.payload_json, '$.report_id')"
  + " AND p.node_run_id = d.node_run_id AND p.attempt = json_extract(d.payload_json, '$.report_attempt') AND p.state = 'rejected'"
  + " AND EXISTS (SELECT 1 FROM node_runs n WHERE n.node_run_id = d.node_run_id AND n.run_id = d.run_id"
  + " AND n.hang_reason = 'report_contradicted' AND n.contradiction_decision_id = d.decision_id"
  + " AND n.status = json_extract(d.payload_json, '$.hung_status') AND n.attempt = p.attempt"
  + " AND n.action_generation = json_extract(d.payload_json, '$.report_generation'))"
  + ") ELSE 0 END AS registered_report, "
  + "CASE WHEN d.kind='report_contradicted' AND json_valid(d.payload_json) THEN EXISTS ("
  + "SELECT 1 FROM decisions o JOIN node_runs n ON n.node_run_id=o.node_run_id AND n.run_id=o.run_id"
  + " JOIN node_run_events e ON e.node_run_id=o.node_run_id AND e.type='decision.original_finding'"
  + " WHERE o.decision_id=json_extract(d.payload_json,'$.original_decision_id') AND o.kind='startup_unknown'"
  + " AND o.node_run_id=d.node_run_id AND o.run_id=d.run_id AND o.status='resolved' AND o.closed_reason='approved'"
  + " AND n.rearm_generation=json_extract(d.payload_json,'$.report_rearm_generation') AND n.fence_state IS NOT 'armed'"
  + " AND json_valid(e.payload) AND json_extract(e.payload,'$.decision_id')=o.decision_id"
  + " AND json_extract(e.payload,'$.actor_kind')='human'"
  + " AND lower(json_extract(e.payload,'$.actor_id')) NOT LIKE 'service:%'"
  + " AND lower(json_extract(e.payload,'$.actor_id')) NOT LIKE 'agent:%'"
  + " AND lower(json_extract(e.payload,'$.actor_id')) NOT LIKE 'system:%'"
  + " AND json_extract(e.payload,'$.resolution')='confirm_not_started'"
  + " AND json_extract(e.payload,'$.revision')=json_extract(d.payload_json,'$.original_decision_revision')"
  + " AND json_extract(e.payload,'$.revision')=o.revision"
  + " AND json_extract(e.payload,'$.attempt')=n.attempt AND json_extract(e.payload,'$.action_generation')=n.action_generation"
  + ") ELSE 0 END AS report_original_available, "
  + "CASE WHEN d.kind='rule_ambiguous' THEN EXISTS(SELECT 1 FROM node_runs n WHERE n.node_run_id=d.node_run_id"
  + " AND n.run_id=d.run_id AND n.node_type='branch' AND n.status='blocked_post' AND n.blocked_decision_id=d.decision_id)"
  + " ELSE 0 END AS workflow_branch"
