export const ATTENTION_ORDER = ['decision', 'unverified', 'failed', 'orphaned', 'running', 'none'] as const
export type Attention = (typeof ATTENTION_ORDER)[number]

export const DELIVERY_ACCEPTANCE = ['passed', 'failed', 'unverifiable', 'not_applicable', 'pending'] as const
export type DeliveryAcceptance = (typeof DELIVERY_ACCEPTANCE)[number]

export const SIDE_EFFECT_LEVEL = ['pure', 'compensable', 'irreversible'] as const
export type SideEffectLevel = (typeof SIDE_EFFECT_LEVEL)[number]

export type TaskAggregates = {
  open_decision_count: number
  oldest_open_decision_age_seconds: number | null
  unverified_count: number
  max_side_effect_level: SideEffectLevel | null
  max_heartbeat_age_ms: number | null
}

export type AttentionInput = {
  openDecisionCount: number
  oldestOpenDecisionAgeSeconds: number | null
  unverifiedCount: number
  currentRunStatus: string | null
  orphanedNodeCount: number
  taskStatus: string
  deliveryAcceptance?: DeliveryAcceptance
}

/** 高优先级返回更大的权重，供服务端稳定排序；未知档位排在已知档位之后。 */
export function attentionWeight(attention: string): number {
  const index = ATTENTION_ORDER.indexOf(attention as Attention)
  return index < 0 ? 0 : ATTENTION_ORDER.length - index
}

export function sideEffectWeight(level: string): number {
  const index = SIDE_EFFECT_LEVEL.indexOf(level as SideEffectLevel)
  return index < 0 ? -1 : index
}

export function maxSideEffectLevel(levels: readonly string[]): SideEffectLevel | null {
  let max: SideEffectLevel | null = null
  for (const level of levels) {
    if (sideEffectWeight(level) > sideEffectWeight(max ?? '')) max = level as SideEffectLevel
  }
  return max
}

export function deriveAttention(input: AttentionInput): { attention: Attention; attention_reason: string | null } {
  if (input.openDecisionCount > 0) {
    const age = input.oldestOpenDecisionAgeSeconds
    const minutes = age === null ? null : Math.max(1, Math.floor(age / 60))
    return {
      attention: 'decision',
      attention_reason: minutes === null ? `${input.openDecisionCount} 项待审批` : `${input.openDecisionCount} 项待审批，最早已等待 ${minutes} 分钟`,
    }
  }
  if (input.unverifiedCount > 0) {
    return { attention: 'unverified', attention_reason: `${input.unverifiedCount} 项外部操作待核验` }
  }
  if (input.currentRunStatus === 'failed' || input.currentRunStatus === 'failed_with_unverified') {
    return { attention: 'failed', attention_reason: '最近一次运行未成功' }
  }
  // 执行失败优先于交付结论：run 已经失败时先报执行失败，再报交付待核验 / 交付验收失败
  if (input.deliveryAcceptance === 'unverifiable') {
    return { attention: 'unverified', attention_reason: '交付待核验' }
  }
  if (input.deliveryAcceptance === 'failed') {
    return { attention: 'failed', attention_reason: '交付验收失败' }
  }
  if (input.currentRunStatus === 'orphaned' || input.orphanedNodeCount > 0) {
    return { attention: 'orphaned', attention_reason: '有节点尚未由新的执行尝试接手' }
  }
  if (input.taskStatus === 'running' || (input.currentRunStatus !== null && !RUN_TERMINAL.has(input.currentRunStatus))) {
    return { attention: 'running', attention_reason: '任务仍在执行' }
  }
  return { attention: 'none', attention_reason: null }
}

const RUN_TERMINAL = new Set(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled'])
