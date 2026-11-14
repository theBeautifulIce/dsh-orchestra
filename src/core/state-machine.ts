// src/core/state-machine.ts —— node_run 状态集合与合法迁移表（规格 3.5 行 177-179、4.8 行 401-417）
export const NON_TERMINAL_STATUSES = [
  'queued',
  'leased',
  'dispatched',
  'started',
  'waiting',
  'verifying',
  'timing_out',
  'stopping',
  'startup_unknown',
  'paused_bridge_missing',
  'blocked_pre',
  'blocked_post',
  'indeterminate_side_effect',
] as const

export const TERMINAL_STATUSES = [
  'done',
  'failed',
  'timeout',
  'abandoned_unverified',
  'failed_with_unverified',
  'orphaned',
  'superseded',
] as const

export type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number]
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]
export type NodeStatus = NonTerminalStatus | TerminalStatus

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

// 合法迁移表：从哪个状态能去哪儿；终态没有出边（规格 3.5 行 179）
export const ALLOWED_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  queued: ['leased', 'blocked_pre', 'superseded'],
  leased: ['dispatched', 'queued', 'blocked_pre', 'superseded'],
  dispatched: ['started', 'stopping', 'startup_unknown', 'timing_out', 'paused_bridge_missing', 'blocked_pre', 'superseded'],
  started: ['verifying', 'stopping', 'startup_unknown', 'timing_out', 'indeterminate_side_effect', 'blocked_pre', 'blocked_post', 'superseded'],
  waiting: ['dispatched', 'started', 'stopping', 'blocked_pre', 'blocked_post', 'superseded'],
  verifying: ['done', 'failed', 'blocked_post', 'timeout', 'failed_with_unverified', 'stopping', 'superseded'],
  timing_out: ['stopping', 'timeout', 'done', 'failed', 'orphaned'],
  stopping: ['timeout', 'failed', 'orphaned', 'indeterminate_side_effect', 'done', 'failed_with_unverified'],
  startup_unknown: ['started', 'stopping', 'orphaned', 'indeterminate_side_effect', 'blocked_post'],
  paused_bridge_missing: ['dispatched', 'started', 'stopping', 'orphaned'],
  blocked_pre: ['dispatched', 'queued', 'started', 'blocked_post'],
  blocked_post: ['dispatched', 'verifying', 'failed', 'timeout', 'orphaned'],
  indeterminate_side_effect: ['verifying', 'failed_with_unverified', 'abandoned_unverified', 'orphaned'],
  done: [],
  failed: [],
  timeout: [],
  abandoned_unverified: [],
  failed_with_unverified: [],
  orphaned: [],
  superseded: [],
}

export function canTransition(from: string, to: string): boolean {
  const edges = ALLOWED_TRANSITIONS[from as NodeStatus]
  if (!edges) return false
  return edges.includes(to as NodeStatus)
}

// 八种 decision（规格 3.6 行 188-198）
export type DecisionKind =
  | 'pre_execution'
  | 'action_overrun'
  | 'abandon_ack'
  | 'verify_human'
  | 'audit_result'
  | 'rule_ambiguous'
  | 'startup_unknown'
  | 'report_contradicted'

// cancel 的四个结果（规格 4.5 行 350-353）
export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

// 迁移的触发语义：同一对 from/to 可能因触发不同而落到不同规则（如 M-08 与 M-09）
export type TransitionTrigger =
  | 'create'
  | 'lease'
  | 'dispatch'
  | 'start-observed'
  | 'startup-timeout'
  | 'startup-timeout-unobserved'
  | 'confirm-not-started-retry'
  | 'confirm-not-started-fail'
  | 'confirm-started'
  | 'confirm-started-attested'
  | 'confirm-started-with-tool'
  | 'abandon'
  | 'late-report'
  | 'unknown-executor'
  | 'unloaded-reattach'
  | 'bridge-lost'
  | 'verifier-dispatched'
  | 'verdict'
  | 'verify-timeout'
  | 'verify-timeout-fail-on-timeout'
  | 'wait-entered'
  | 'wait-event'
  | 'wait-timeout'
  | 'action-timeout-interrupted'
  | 'timing-out-pure'
  | 'timing-out-unknown'
  | 'timing-out-still-running'
  | 'cannot-stop'
  | 'interrupted-no-tool'
  | 'already-stopped-verifiable'
  | 'already-stopped-unknown'
  | 'late-report-stopping'
  | 'confirm-applied'
  | 'continue-wait'
  | 'stopping-unknown'
  | 'abandon-stopping'
  | 'abandon-ack-rejected'
  | 'confirm-stopped'
  | 'pre-approval'
  | 'approval-granted'
  | 'approval-rejected'
  | 'post-verification'
  | 'decision-closed'
  | 'report-started'
  | 'bridge-restored'
  | 'liveness-replayable'
  | 'liveness-unreplayable'
  | 'redispatch-orphaned'
  | 'executor-stopped-unknown'
  | 'confirm-applied-unknown'
  | 'confirm-not-applied'
  | 'abandon-unknown'
  | 'compensation-failed'
  | 'no-compensation'
  | 'continue-tracking'
  | 'uphold-report'
  | 'uphold-decision'

// 迁移守卫的上下文。除状态/目标/触发出处外，其余字段只服务具体规则。
export type TransitionContext = {
  status: NodeStatus
  target: NodeStatus
  trigger: TransitionTrigger
  hasToolCall: boolean
  cancelResult: CancelResult | null
  hangReason: 'report_contradicted' | null
  sideEffectVerifiedNone: boolean
}

export type TransitionRule = {
  id: `M-${string}`
  from: readonly NodeStatus[]
  to: readonly NodeStatus[]
  trigger: TransitionTrigger
  // 终态源的特殊边：orphaned 重投、failed → failed_with_unverified、abandoned 确认
  allowTerminal?: boolean
  // 挂起时只允许两条 resolution 与桥断边
  allowHung?: boolean
  requires?: (ctx: TransitionContext) => boolean
}

export const HANG_REASON_REPORT_CONTRADICTED = 'report_contradicted' as const

const A = ALLOWED_TRANSITIONS
const NON_TERMINAL = [...NON_TERMINAL_STATUSES]

// M-01…M-61 逐行迁移规则（设计稿 §8 迁移表）。from/to 用数组保留一行的多目标语义。
export const TRANSITIONS: readonly TransitionRule[] = [
  { id: 'M-02', from: ['queued'], to: ['leased'], trigger: 'lease' },
  { id: 'M-03', from: ['leased'], to: ['dispatched'], trigger: 'dispatch' },
  { id: 'M-04', from: ['dispatched'], to: ['started'], trigger: 'start-observed' },
  { id: 'M-05', from: ['dispatched', 'started'], to: ['startup_unknown'], trigger: 'startup-timeout' },
  { id: 'M-06', from: ['startup_unknown'], to: ['superseded'], trigger: 'confirm-not-started-retry', requires: (c) => !c.hasToolCall },
  { id: 'M-07', from: ['startup_unknown'], to: ['failed'], trigger: 'confirm-not-started-fail', requires: (c) => !c.hasToolCall },
  { id: 'M-08', from: ['startup_unknown'], to: ['stopping'], trigger: 'confirm-started' },
  { id: 'M-09', from: ['startup_unknown'], to: ['stopping'], trigger: 'confirm-started-attested' },
  { id: 'M-10', from: ['startup_unknown'], to: ['abandoned_unverified'], trigger: 'abandon' },
  { id: 'M-11', from: ['startup_unknown'], to: ['done', 'failed'], trigger: 'late-report' },
  { id: 'M-12', from: ['startup_unknown'], to: ['indeterminate_side_effect'], trigger: 'unknown-executor' },
  { id: 'M-13', from: ['startup_unknown'], to: ['startup_unknown'], trigger: 'unloaded-reattach' },
  { id: 'M-14', from: ['startup_unknown'], to: ['paused_bridge_missing'], trigger: 'bridge-lost' },
  { id: 'M-15', from: ['started'], to: ['verifying'], trigger: 'verifier-dispatched' },
  { id: 'M-16', from: ['verifying'], to: ['done', 'failed'], trigger: 'verdict' },
  { id: 'M-17', from: ['verifying'], to: ['blocked_post'], trigger: 'verify-timeout' },
  { id: 'M-18', from: ['verifying'], to: ['failed'], trigger: 'verify-timeout-fail-on-timeout', requires: (c) => c.sideEffectVerifiedNone },
  { id: 'M-19', from: ['verifying'], to: ['failed_with_unverified'], trigger: 'verify-timeout-fail-on-timeout', requires: (c) => !c.sideEffectVerifiedNone },
  { id: 'M-20', from: ['started'], to: ['waiting'], trigger: 'wait-entered' },
  { id: 'M-21', from: ['waiting'], to: ['dispatched'], trigger: 'wait-event' },
  { id: 'M-22', from: ['waiting'], to: ['timeout'], trigger: 'wait-timeout' },
  { id: 'M-23', from: ['started'], to: ['timing_out'], trigger: 'action-timeout-interrupted', requires: (c) => c.cancelResult === 'interrupted' },
  { id: 'M-24', from: ['timing_out'], to: ['timeout'], trigger: 'timing-out-pure' },
  { id: 'M-25', from: ['timing_out'], to: ['indeterminate_side_effect'], trigger: 'timing-out-unknown' },
  { id: 'M-26', from: ['timing_out'], to: ['stopping'], trigger: 'timing-out-still-running' },
  { id: 'M-27', from: ['dispatched', 'started'], to: ['stopping'], trigger: 'cannot-stop', requires: (c) => c.cancelResult === 'not_interruptible' || c.cancelResult === 'unknown' },
  { id: 'M-28', from: ['dispatched', 'started'], to: ['timeout'], trigger: 'interrupted-no-tool', requires: (c) => !c.hasToolCall && c.cancelResult === 'interrupted' },
  { id: 'M-29', from: ['dispatched', 'started'], to: ['done', 'failed'], trigger: 'already-stopped-verifiable', requires: (c) => c.cancelResult === 'already_stopped' },
  { id: 'M-30', from: ['dispatched', 'started'], to: ['indeterminate_side_effect'], trigger: 'already-stopped-unknown', requires: (c) => c.cancelResult === 'already_stopped' },
  { id: 'M-31', from: ['dispatched', 'started'], to: ['startup_unknown'], trigger: 'startup-timeout-unobserved' },
  { id: 'M-32', from: ['stopping'], to: ['done', 'failed'], trigger: 'late-report-stopping' },
  { id: 'M-33', from: ['stopping'], to: ['done'], trigger: 'confirm-applied' },
  { id: 'M-34', from: ['stopping'], to: ['stopping'], trigger: 'continue-wait' },
  { id: 'M-35', from: ['stopping'], to: ['indeterminate_side_effect'], trigger: 'stopping-unknown' },
  { id: 'M-36', from: ['stopping'], to: ['abandoned_unverified'], trigger: 'abandon-stopping' },
  { id: 'M-37', from: ['abandoned_unverified'], to: ['stopping'], trigger: 'abandon-ack-rejected', allowTerminal: true },
  { id: 'M-38', from: ['abandoned_unverified'], to: ['abandoned_unverified'], trigger: 'confirm-stopped', allowTerminal: true },
  { id: 'M-39', from: ['queued', 'leased'], to: ['blocked_pre'], trigger: 'pre-approval' },
  { id: 'M-40', from: ['blocked_pre'], to: ['queued'], trigger: 'approval-granted' },
  { id: 'M-41', from: ['blocked_pre'], to: ['failed'], trigger: 'approval-rejected' },
  { id: 'M-42', from: ['started', 'verifying'], to: ['blocked_post'], trigger: 'post-verification' },
  { id: 'M-43', from: ['blocked_post'], to: ['done', 'failed'], trigger: 'decision-closed' },
  { id: 'M-44', from: ['started'], to: ['done'], trigger: 'report-started' },
  { id: 'M-45', from: ['dispatched', 'started', 'verifying', 'timing_out', 'stopping', 'startup_unknown'], to: ['paused_bridge_missing'], trigger: 'bridge-lost', allowHung: true },
  { id: 'M-46', from: ['paused_bridge_missing'], to: ['dispatched', 'started', 'verifying', 'timing_out', 'stopping', 'startup_unknown'], trigger: 'bridge-restored' },
  { id: 'M-47', from: NON_TERMINAL, to: ['orphaned'], trigger: 'liveness-replayable' },
  { id: 'M-48', from: NON_TERMINAL, to: ['failed'], trigger: 'liveness-unreplayable' },
  { id: 'M-49', from: ['orphaned'], to: ['orphaned'], trigger: 'redispatch-orphaned', allowTerminal: true },
  { id: 'M-50', from: NON_TERMINAL, to: ['indeterminate_side_effect'], trigger: 'executor-stopped-unknown' },
  { id: 'M-51', from: ['indeterminate_side_effect'], to: ['done'], trigger: 'confirm-applied-unknown' },
  { id: 'M-52', from: ['indeterminate_side_effect'], to: ['superseded', 'failed'], trigger: 'confirm-not-applied' },
  { id: 'M-53', from: ['indeterminate_side_effect'], to: ['abandoned_unverified'], trigger: 'abandon-unknown' },
  { id: 'M-54', from: ['indeterminate_side_effect', 'abandoned_unverified'], to: ['failed_with_unverified'], trigger: 'compensation-failed', allowTerminal: true },
  { id: 'M-55', from: ['failed', 'indeterminate_side_effect'], to: ['failed_with_unverified'], trigger: 'no-compensation', allowTerminal: true },
  { id: 'M-57', from: ['startup_unknown'], to: ['startup_unknown'], trigger: 'continue-tracking' },
  { id: 'M-59', from: ['startup_unknown', 'indeterminate_side_effect'], to: ['done', 'failed'], trigger: 'uphold-report', allowHung: true },
  { id: 'M-60', from: ['startup_unknown', 'indeterminate_side_effect'], to: ['superseded', 'failed'], trigger: 'uphold-decision', allowHung: true },
  { id: 'M-61', from: ['startup_unknown'], to: ['stopping'], trigger: 'confirm-started-with-tool', requires: (c) => c.hasToolCall },
]

// 建行规则与跨行闸门：它们不是状态迁移，但属于 M-01…M-61 的必过项。
export const CREATION_RULES = [
  { id: 'M-01', to: 'queued', trigger: 'create' },
  { id: 'M-58', to: 'queued', trigger: 'create' },
] as const

export const HANG_GUARD = {
  id: 'M-56',
  trigger: 'late-report',
  // 挂起时普通出口一律拒；只有 uphold_report / uphold_decision 与桥断边能过。
  allows: (rule: TransitionRule): boolean => rule.allowHung === true,
} as const

export const MIGRATION_CASE_IDS = [
  'M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08', 'M-09', 'M-10',
  'M-11', 'M-12', 'M-13', 'M-14', 'M-15', 'M-16', 'M-17', 'M-18', 'M-19', 'M-20',
  'M-21', 'M-22', 'M-23', 'M-24', 'M-25', 'M-26', 'M-27', 'M-28', 'M-29', 'M-30',
  'M-31', 'M-32', 'M-33', 'M-34', 'M-35', 'M-36', 'M-37', 'M-38', 'M-39', 'M-40',
  'M-41', 'M-42', 'M-43', 'M-44', 'M-45', 'M-46', 'M-47', 'M-48', 'M-49', 'M-50',
  'M-51', 'M-52', 'M-53', 'M-54', 'M-55', 'M-56', 'M-57', 'M-58', 'M-59', 'M-60',
  'M-61',
] as const

export function allows(rule: TransitionRule, ctx: TransitionContext): boolean {
  if (!rule.from.includes(ctx.status)) return false
  if (!rule.to.includes(ctx.target)) return false
  if ((TERMINAL_STATUSES as readonly string[]).includes(ctx.status) && !rule.allowTerminal) return false
  if (ctx.hangReason !== null && !rule.allowHung) return false
  if (rule.trigger !== ctx.trigger) return false
  return rule.requires?.(ctx) ?? true
}

// 给业务层用的便捷判定：找第一条命中的规则；找不到即非法迁移。
export function findTransition(ctx: TransitionContext): TransitionRule | null {
  return TRANSITIONS.find((rule) => allows(rule, ctx)) ?? null
}

// Ga 跟动作走、Gr 跟续期走，两者不许合并（规格 4.3 行 309-310）
export type GenerationBump =
  | { kind: 'redispatch'; actionGeneration: number }
  | { kind: 'rearm'; rearmGeneration: number }
  | { kind: 'none' }

export function nextGenerationBump(current: {
  actionGeneration: number
  rearmGeneration: number
}, bump: GenerationBump): { actionGeneration: number; rearmGeneration: number } {
  if (bump.kind === 'redispatch') {
    return { actionGeneration: bump.actionGeneration, rearmGeneration: current.rearmGeneration }
  }
  if (bump.kind === 'rearm') {
    return { actionGeneration: current.actionGeneration, rearmGeneration: bump.rearmGeneration }
  }
  return { actionGeneration: current.actionGeneration, rearmGeneration: current.rearmGeneration }
}
