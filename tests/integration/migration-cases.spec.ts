// M-01…M-65 逐条用例：每条规则都有正例，终态源、挂起源、错误触发与错误目标都被拒。
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CREATION_RULES, HANG_GUARD, MIGRATION_CASE_IDS, TERMINAL_STATUSES, TRANSITIONS,
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
    controlCompletion: rule.id === 'M-63' || rule.id === 'M-64' || rule.id === 'M-65',
  }
}

describe('M-01…M-65 迁移用例', () => {
  it('65 个迁移 id 全覆盖，且没有表外规则', () => {
    const ids = [
      ...TRANSITIONS.map((rule) => rule.id),
      ...CREATION_RULES.map((rule) => rule.id),
      HANG_GUARD.id,
    ]
    expect(new Set(ids).size).toBe(65)
    expect([...ids].sort()).toEqual([...MIGRATION_CASE_IDS].sort())
  })

  it('迁移表本身被改动时固定清单必须失败', () => {
    // 只遍历 TRANSITIONS 自己时，把来源改掉测试也会跟着改；这里固定整表指纹。
    const canonical = JSON.stringify(TRANSITIONS.map((rule) => ({
      id: rule.id, from: rule.from, to: rule.to, trigger: rule.trigger,
      allowHung: rule.allowHung === true, allowTerminal: rule.allowTerminal === true,
      hasRequires: typeof rule.requires === 'function',
    })))
    expect(createHash('sha256').update(canonical).digest('hex'))
      .toBe('3090dc470b16d12c04fbcb31064d0a107382ccd07ce6d94984a74a9fc5c360a6')
    expect(TRANSITIONS).toHaveLength(62)
    expect(TRANSITIONS.reduce((n, rule) => n + rule.from.length, 0)).toBe(126)
    expect(TRANSITIONS.reduce((n, rule) => n + rule.to.length, 0)).toBe(75)
    expect(TRANSITIONS.filter((rule) => rule.requires).length).toBe(13)
  })

  for (const rule of TRANSITIONS) {
    it(`${rule.id} 的每个来源×目标都命中，错误触发与错误目标被拒`, () => {
      for (const from of rule.from) {
        for (const to of rule.to) {
          const ctx: TransitionContext = { ...contextFor(rule), status: from, target: to }
          expect(allows(rule, ctx), `${rule.id} ${from}→${to}`).toBe(true)
          expect(findTransition(ctx)?.id, `${rule.id} ${from}→${to}`).toBe(rule.id)
        }
      }
      const ctx = contextFor(rule)
      expect(allows(rule, { ...ctx, trigger: rule.trigger === 'lease' ? 'verdict' : 'lease' })).toBe(false)
      expect(allows(rule, { ...ctx, target: rule.to.includes('queued') ? 'done' : 'queued' })).toBe(false)
    })
  }

  it('每条 requires 规则都有被前提拒绝的反例', () => {
    for (const rule of TRANSITIONS) {
      if (!rule.requires) continue
      const bad: TransitionContext = {
        ...contextFor(rule),
        hasToolCall: rule.id === 'M-06' || rule.id === 'M-07' || rule.id === 'M-28',
        cancelResult: null,
        sideEffectVerifiedNone: rule.id === 'M-19',
        controlCompletion: false,
      }
      expect(allows(rule, bad), `${rule.id} 应被 requires 拒绝`).toBe(false)
    }
  })

  it('M-01 / M-58 建行规则只落 queued', () => {
    expect(CREATION_RULES).toEqual([
      { id: 'M-01', to: 'queued', trigger: 'create' },
      { id: 'M-58', to: 'queued', trigger: 'create' },
    ])
  })

  it('M-56 挂起闸对每条 allowHung 规则都放行，普通规则一律拒绝', () => {
    const hung = TRANSITIONS.filter((rule) => rule.allowHung)
    expect(hung.map((rule) => rule.id).sort()).toEqual(['M-45', 'M-59', 'M-60'])
    for (const rule of hung) expect(HANG_GUARD.allows(rule), rule.id).toBe(true)
    const ordinary = TRANSITIONS.filter((rule) => !rule.allowHung)
    expect(ordinary.length).toBeGreaterThan(50)
    for (const rule of ordinary) expect(HANG_GUARD.allows(rule), rule.id).toBe(false)
  })

  it('终态来源必须逐条带 allowTerminal，不能靠整体表放行', () => {
    const terminal = new Set<string>(TERMINAL_STATUSES)
    for (const rule of TRANSITIONS) {
      const fromTerminal = rule.from.filter((from) => terminal.has(from))
      if (fromTerminal.length > 0) {
        expect(rule.allowTerminal, `${rule.id} 的终态来源 ${fromTerminal.join(',')}`).toBe(true)
      }
    }
  })
})
