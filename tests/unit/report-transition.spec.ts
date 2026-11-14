import { describe, expect, it } from 'vitest'
import { canReportTransition } from '../../src/core/state-machine.ts'

describe('执行器上报可落的状态', () => {
  it('普通报告不能自报 orphaned / indeterminate_side_effect', () => {
    expect(canReportTransition('started', 'orphaned')).toBe(false)
    expect(canReportTransition('started', 'indeterminate_side_effect')).toBe(false)
    expect(canReportTransition('verifying', 'orphaned')).toBe(false)
  })

  it('执行类终态与阻塞态仍可上报', () => {
    expect(canReportTransition('started', 'done')).toBe(true)
    expect(canReportTransition('started', 'failed')).toBe(true)
    expect(canReportTransition('queued', 'blocked_pre')).toBe(true)
    expect(canReportTransition('verifying', 'blocked_post')).toBe(true)
  })
})
