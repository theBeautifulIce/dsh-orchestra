import { describe, expect, it } from 'vitest'
import {
  CREATION_RULES,
  HANG_GUARD,
  MIGRATION_CASE_IDS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  allows,
  findTransition,
  type TransitionContext,
  type TransitionRule,
  type TransitionTrigger,
} from '../../src/core/state-machine.ts'

function baseContext(rule: TransitionRule): TransitionContext {
  const ctx: TransitionContext = {
    status: rule.from[0]!,
    target: rule.to[0]!,
    trigger: rule.trigger,
    hasToolCall: false,
    cancelResult: null,
    hangReason: null,
    sideEffectVerifiedNone: false,
  }
  if (rule.id === 'M-18') ctx.sideEffectVerifiedNone = true
  if (rule.id === 'M-23' || rule.id === 'M-28') ctx.cancelResult = 'interrupted'
  if (rule.id === 'M-27') ctx.cancelResult = 'not_interruptible'
  if (rule.id === 'M-29' || rule.id === 'M-30') ctx.cancelResult = 'already_stopped'
  if (rule.id === 'M-61') ctx.hasToolCall = true
  return ctx
}

describe('M-01…M-61 迁移规则表', () => {
  it('61 个迁移用例 id 全覆盖，58 条状态规则 + 2 条建行 + 1 条挂起闸门', () => {
    const covered = [
      ...TRANSITIONS.map((r) => r.id),
      ...CREATION_RULES.map((r) => r.id),
      HANG_GUARD.id,
    ]
    expect(new Set(covered).size).toBe(61)
    expect([...covered].sort()).toEqual([...MIGRATION_CASE_IDS].sort())
    expect(TRANSITIONS).toHaveLength(58)
  })

  it('每条状态规则在自己的上下文里放行', () => {
    for (const rule of TRANSITIONS) {
      expect(allows(rule, baseContext(rule)), `${rule.id} 正例`).toBe(true)
    }
  })

  it('触发不匹配时全部拒绝', () => {
    for (const rule of TRANSITIONS) {
      const ctx = baseContext(rule)
      ctx.trigger = (rule.trigger === 'verdict' ? 'lease' : 'verdict') as TransitionTrigger
      expect(allows(rule, ctx), `${rule.id} 错 trigger`).toBe(false)
    }
  })

  it('目标不在 to 集合时拒绝', () => {
    for (const rule of TRANSITIONS) {
      const ctx = baseContext(rule)
      ctx.target = 'queued'
      if (rule.to.includes('queued')) continue
      expect(allows(rule, ctx), `${rule.id} 错 target`).toBe(false)
    }
  })

  it('挂起时普通出口拒绝，只放 uphold 与桥断', () => {
    const verdict = TRANSITIONS.find((r) => r.id === 'M-16')!
    const ctx = baseContext(verdict)
    ctx.hangReason = 'report_contradicted'
    expect(allows(verdict, ctx)).toBe(false)

    for (const id of ['M-45', 'M-59', 'M-60']) {
      const rule = TRANSITIONS.find((r) => r.id === id)!
      const hung = baseContext(rule)
      hung.hangReason = 'report_contradicted'
      expect(allows(rule, hung), `${id} 挂起出口`).toBe(true)
    }
    expect(HANG_GUARD.allows(verdict)).toBe(false)
    expect(HANG_GUARD.allows(TRANSITIONS.find((r) => r.id === 'M-59')!)).toBe(true)
  })

  it('终态只允许显式 allowTerminal 的自环/收尾边', () => {
    const normal = TRANSITIONS.find((r) => r.id === 'M-16')!
    const ctx = baseContext(normal)
    ctx.status = 'done'
    expect(allows(normal, ctx)).toBe(false)
    for (const rule of TRANSITIONS) {
      if (!rule.allowTerminal) continue
      const terminal = baseContext(rule)
      terminal.status = TERMINAL_STATUSES[0]
      if (!rule.from.includes(TERMINAL_STATUSES[0])) continue
      expect(allows(rule, terminal), `${rule.id} 终态出口`).toBe(true)
    }
  })

  it('半态分叉：M-18/M-19 与 M-28/M-29/M-30/M-61 各走各的', () => {
    const m18 = TRANSITIONS.find((r) => r.id === 'M-18')!
    const m19 = TRANSITIONS.find((r) => r.id === 'M-19')!
    expect(allows(m18, baseContext(m18))).toBe(true)
    expect(allows(m19, { ...baseContext(m19), sideEffectVerifiedNone: true })).toBe(false)

    const m28 = TRANSITIONS.find((r) => r.id === 'M-28')!
    expect(allows(m28, { ...baseContext(m28), hasToolCall: true })).toBe(false)
    expect(allows(m28, { ...baseContext(m28), cancelResult: 'unknown' })).toBe(false)

    const m61 = TRANSITIONS.find((r) => r.id === 'M-61')!
    expect(allows(m61, { ...baseContext(m61), hasToolCall: false })).toBe(false)
  })

  it('findTransition 按四元组取到唯一规则', () => {
    const ctx: TransitionContext = {
      status: 'verifying',
      target: 'done',
      trigger: 'verdict',
      hasToolCall: true,
      cancelResult: null,
      hangReason: null,
      sideEffectVerifiedNone: false,
    }
    expect(findTransition(ctx)?.id).toBe('M-16')
    expect(findTransition({ ...ctx, trigger: 'lease' })).toBeNull()
  })
})
