import { describe, expect, it } from 'vitest'
import {
  HALF_STATES,
  bridgeClockPolicy,
  isHalfState,
  rearmFromRemaining,
  remainingNs,
} from '../../src/core/half-state.ts'

describe('半态时钟与桥断冻结矩阵', () => {
  it('跨 boot 剩余量扣掉停机时间，墙钟回拨夹到 0', () => {
    const prev = {
      deadlineMonotonicNs: 120_000_000_000,
      lastEventMonotonicNs: 20_000_000_000,
      lastEventAtMs: 1_000_000,
    }
    expect(remainingNs(prev, { bootId: 'b2', startedAtMs: 1_010_000, startedMonotonicNs: 0 })).toBe(90_000_000_000)
    expect(remainingNs(prev, { bootId: 'b2', startedAtMs: 1_200_000, startedMonotonicNs: 0 })).toBe(0)
    expect(remainingNs(prev, { bootId: 'b2', startedAtMs: 900_000, startedMonotonicNs: 0 })).toBe(100_000_000_000)
  })

  it('同一 boot 内墙钟前后跳十分钟，剩余量不变', () => {
    const prev = {
      deadlineMonotonicNs: 60_000_000_000,
      lastEventMonotonicNs: 10_000_000_000,
      lastEventAtMs: 5_000_000,
    }
    const before = remainingNs(prev, { bootId: 'b1', startedAtMs: 5_000_000, startedMonotonicNs: 0 })
    const after = remainingNs(prev, { bootId: 'b1', startedAtMs: 5_000_000, startedMonotonicNs: 0 })
    expect(after).toBe(before)
  })

  it('桥断矩阵：启动/动作继续走，unknown/verify 冻结，timing_out 不累计', () => {
    expect(bridgeClockPolicy('startup_timeout')).toBe('continue')
    expect(bridgeClockPolicy('action_deadline')).toBe('continue')
    expect(bridgeClockPolicy('unknown_watchdog')).toBe('freeze')
    expect(bridgeClockPolicy('verify_timeout')).toBe('freeze')
    expect(bridgeClockPolicy('timing_out_grace')).toBe('pause_no_accumulate')
  })

  it('冻结值重挂：有剩余按剩余、0 立即到点、NULL 才补满额', () => {
    expect(rearmFromRemaining(1_000, 30_000_000_000, 120_000_000_000)).toEqual({
      deadlineMonotonicNs: 30_000_001_000, remainingNs: 30_000_000_000, refilled: false,
    })
    expect(rearmFromRemaining(1_000, 0, 120_000_000_000)).toEqual({
      deadlineMonotonicNs: 1_000, remainingNs: 0, refilled: false,
    })
    expect(rearmFromRemaining(1_000, null, 120_000_000_000)).toEqual({
      deadlineMonotonicNs: 120_000_001_000, remainingNs: 120_000_000_000, refilled: true,
    })
  })

  it('半态集合与 isHalfState 一致', () => {
    for (const state of HALF_STATES) expect(isHalfState(state)).toBe(true)
    expect(isHalfState('started')).toBe(false)
    expect(isHalfState('done')).toBe(false)
  })
})
