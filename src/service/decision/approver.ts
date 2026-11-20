// src/service/decision/approver.ts —— 批准人三档与审计能力位校验（规格 18.4）。
import { OrchError } from '../../core/errors.ts'
import type { DecisionKind } from '../../core/state-machine.ts'

export type Approver = 'human' | 'either' | `agent:${string}`

export type Actor = {
  kind: 'human' | 'agent'
  id: string
  capabilities?: readonly string[]
}

export type ApproverCheck = {
  approver: Approver
  actor: Actor
  // 这张 decision 的证据产出者；Agent 不能批准自己产出的证据。
  evidenceProducers?: readonly string[]
}

const AUDIT_CAPABILITY = 'orchestra.audit'

export function validateApprover(value: string): Approver {
  if (value === 'human' || value === 'either') return value
  if (value.startsWith('agent:') && value.length > 6) return value as Approver
  throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知的批准人档位', { approver: value })
}

// 默认分工：不可逆/人工确认类到人；审计结论允许审计 Agent 或人；其余先到先收。
export function defaultApprover(kind: DecisionKind, actionCategory?: string): Approver {
  if (actionCategory === 'irreversible') return 'human'
  if (kind === 'pre_execution' || kind === 'action_overrun' || kind === 'verify_human') return 'human'
  if (kind === 'audit_result') return 'either'
  return 'either'
}

export function assertApprover(p: ApproverCheck): void {
  const approver = validateApprover(p.approver)
  if (approver === 'either') {
    if (p.actor.kind === 'agent' && (p.evidenceProducers ?? []).includes(p.actor.id)) {
      throw new OrchError('FORBIDDEN', 'Agent 不能批准自己产出的证据', { approver, actor: p.actor.id })
    }
    return
  }
  if (approver === 'human') {
    if (p.actor.kind !== 'human') {
      throw new OrchError('FORBIDDEN', '这张 decision 只能由人批准', { approver, actor: p.actor.kind })
    }
    return
  }
  if (p.actor.kind !== 'agent') {
    throw new OrchError('FORBIDDEN', '这张 decision 只能由审计 Agent 批准', { approver, actor: p.actor.kind })
  }
  if (!(p.actor.capabilities ?? []).includes(AUDIT_CAPABILITY)) {
    throw new OrchError('FORBIDDEN', '审计 Agent 缺 orchestra.audit 能力位', { approver, actor: p.actor.id })
  }
  if ((p.evidenceProducers ?? []).includes(p.actor.id)) {
    throw new OrchError('FORBIDDEN', 'Agent 不能批准自己产出的证据', { approver, actor: p.actor.id })
  }
}
