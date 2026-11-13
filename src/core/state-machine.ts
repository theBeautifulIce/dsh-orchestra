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
