import type { Resolution } from '../commands/decisions.ts'

export type DecisionChoiceContext = {
  kind: unknown
  status: unknown
  approver: unknown
  expires_at: unknown
  memory_approval_status: unknown
  memory_recovery: unknown
  registered_report?: unknown
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
    ? { choices: ['uphold_report'], unavailableReason: null }
    : unavailable('这张冲突卡缺少可核验的报告登记。')
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
  + ") ELSE 0 END AS registered_report"
