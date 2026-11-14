// M-01…M-61 逐条用例：每条规则都有正例，终态源、挂起源、错误触发与错误目标都被拒。
import { describe, expect, it } from 'vitest'
import {
  CREATION_RULES, HANG_GUARD, MIGRATION_CASE_IDS, TRANSITIONS,
  allows, findTransition, type TransitionContext, type TransitionRule,
} from '../../src/core/state-machine.ts'

function contextFor(rule: TransitionRule): TransitionContext {
  return {
    status: rule.from[0]!,
    target: rule.to[0]!,
    trigger: rule.trigger,
    hasToolCall: rule.id !== 'M-06' && rule.id !== 'M-07' && rule.id !== 'M-28',
    cancelResult:
      rule.id === 'M-23' || rule.id === 'M-28' ? 'interrupted'
        : rule.id === 'M-27' ? 'not_interruptible'
          : rule.id === 'M-29' || rule.id === 'M-30' ? 'already_stopped'
            : null,
    hangReason: rule.allowHung ? 'report_contradicted' : null,
    sideEffectVerifiedNone: rule.id === 'M-18',
  }
}

describe('M-01…M-61 迁移用例', () => {
  it('61 个迁移 id 全覆盖，且没有表外规则', () => {
    const ids = [
      ...TRANSITIONS.map((rule) => rule.id),
      ...CREATION_RULES.map((rule) => rule.id),
      HANG_GUARD.id,
    ]
    expect(new Set(ids).size).toBe(61)
    expect([...ids].sort()).toEqual([...MIGRATION_CASE_IDS].sort())
  })

  for (const rule of TRANSITIONS) {
    it(`${rule.id} 正例命中，错误触发与错误目标被拒`, () => {
      const ctx = contextFor(rule)
      expect(allows(rule, ctx)).toBe(true)
      expect(findTransition(ctx)?.id).toBe(rule.id)
      expect(allows(rule, { ...ctx, trigger: rule.trigger === 'lease' ? 'verdict' : 'lease' })).toBe(false)
      expect(allows(rule, { ...ctx, target: rule.to.includes('queued') ? 'done' : 'queued' })).toBe(false)
    })
  }

  it('M-01 / M-58 建行规则只落 queued', () => {
    expect(CREATION_RULES).toEqual([
      { id: 'M-01', to: 'queued', trigger: 'create' },
      { id: 'M-58', to: 'queued', trigger: 'create' },
    ])
  })

  it('M-56 挂起闸只放行 allowHung 的规则', () => {
    expect(HANG_GUARD.allows(TRANSITIONS.find((rule) => rule.id === 'M-45')!)).toBe(true)
    expect(HANG_GUARD.allows(TRANSITIONS.find((rule) => rule.id === 'M-59')!)).toBe(true)
    expect(HANG_GUARD.allows(TRANSITIONS.find((rule) => rule.id === 'M-02')!)).toBe(false)
  })

  it('终态源没有 allowTerminal 时一律拒绝', () => {
    expect(findTransition({
      status: 'done', target: 'queued', trigger: 'lease', hasToolCall: false,
      cancelResult: null, hangReason: null, sideEffectVerifiedNone: false,
    })).toBeNull()
  })
})
