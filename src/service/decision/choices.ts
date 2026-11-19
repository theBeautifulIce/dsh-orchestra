import type { Resolution } from '../commands/decisions.ts'

export type DecisionChoiceContext = {
  kind: unknown
  status: unknown
  approver: unknown
  expires_at: unknown
  memory_approval_status: unknown
  memory_recovery: unknown
}

export function panelDecisionOptions(decision: DecisionChoiceContext, now: number, memoryEnabled: boolean): {
  choices: Resolution[]; unavailableReason: string | null
} {
  const unavailable = (unavailableReason: string) => ({ choices: [], unavailableReason })
  const restricted = panelDecisionRestriction(decision, now)
  if (restricted) return unavailable(restricted)
  if (isEffectDecision(decision)) return unavailable('此裁决必须提交对应节点的系统核验证据。')
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
