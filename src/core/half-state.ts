// src/core/half-state.ts —— 半态时钟与桥断冻结矩阵（规格 4.4 行 328-342）
import type { NodeStatus } from './state-machine.ts'

export type HalfState =
  | 'blocked_pre'
  | 'blocked_post'
  | 'stopping'
  | 'indeterminate_side_effect'
  | 'startup_unknown'

export const HALF_STATES: readonly HalfState[] = [
  'blocked_pre',
  'blocked_post',
  'stopping',
  'indeterminate_side_effect',
  'startup_unknown',
]

export function isHalfState(status: NodeStatus): status is HalfState {
  return (HALF_STATES as readonly string[]).includes(status)
}

export type BootClock = {
  bootId: string
  startedAtMs: number
  startedMonotonicNs: number
}

// 跨 boot 剩余量：停机那段时间不算进预算，墙钟回拨夹到 0，剩余不超过原预算。
// 单位纳秒；公式与规格 4.4 行 342 同源。
export function remainingNs(prev: {
  deadlineMonotonicNs: number
  lastEventMonotonicNs: number
  lastEventAtMs: number
}, current: BootClock): number {
  const budgetNs = Math.max(0, prev.deadlineMonotonicNs - prev.lastEventMonotonicNs)
  const downtimeNs = Math.max(0, current.startedAtMs - prev.lastEventAtMs) * 1e6
  return Math.max(0, budgetNs - downtimeNs)
}

export type BridgeClockChannel =
  | 'startup_timeout'
  | 'action_deadline'
  | 'unknown_watchdog'
  | 'verify_timeout'
  | 'timing_out_grace'

export type BridgeClockPolicy = 'continue' | 'freeze' | 'pause_no_accumulate'

// 桥断期间的钟表矩阵：启动/动作截止继续走；unknown/verify 冻结剩余量；timing_out 宽限不累计。
export function bridgeClockPolicy(channel: BridgeClockChannel): BridgeClockPolicy {
  switch (channel) {
    case 'startup_timeout':
    case 'action_deadline':
      return 'continue'
    case 'unknown_watchdog':
    case 'verify_timeout':
      return 'freeze'
    case 'timing_out_grace':
      return 'pause_no_accumulate'
  }
}

// 半态恢复时重挂截止点：冻结值为 NULL 才补满额；0 表示立即到点。
export function rearmFromRemaining(
  nowMonotonicNs: number,
  frozenRemainingNs: number | null,
  fullBudgetNs: number,
): { deadlineMonotonicNs: number; remainingNs: number; refilled: boolean } {
  const refilled = frozenRemainingNs === null
  const remaining = refilled ? Math.max(0, fullBudgetNs) : Math.max(0, frozenRemainingNs)
  return { deadlineMonotonicNs: nowMonotonicNs + remaining, remainingNs: remaining, refilled }
}
