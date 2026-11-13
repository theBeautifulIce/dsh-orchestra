import { describe, expect, it } from 'vitest'
import {
  evaluateEvidence, evaluatePassConditions, mergePassConditions, missingHashes, validateCondition,
  type PassCondition,
} from '../src/core/policy.ts'
import type { Report } from '../src/core/report.ts'

const report = (over: Partial<Report> = {}): Report => ({
  report_id: 'rep_1', node_run_id: 'nr1', attempt: 1, status: 'done',
  evidence: { source: 'run_tool', exitCode: 0, hashes: { artifact: 'a'.repeat(64) } },
  ...over,
})

describe('证据门', () => {
  it('没有 evidence → ok=false、reason=evidence_missing', () => {
    const out = evaluateEvidence(report({ evidence: undefined }), [])
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('evidence_missing')
  })

  it('来源决定强弱：run_tool 强、tool_result 弱', () => {
    expect(evaluateEvidence(report(), []).strength).toBe('strong')
    expect(evaluateEvidence(report({ evidence: { source: 'tool_result' } }), []).strength).toBe('weak')
  })

  it('必留哈希缺失 → verification_too_weak；补齐强证据 → ok', () => {
    const onlyExit = report({ evidence: { source: 'run_tool', exitCode: 0 } })
    expect(evaluateEvidence(onlyExit, ['artifact']).reason).toBe('verification_too_weak')
    expect(evaluateEvidence(report(), ['artifact']).ok).toBe(true)
  })

  it('弱证据不做不可逆凭据', () => {
    const weak = report({ evidence: { source: 'tool_result', hashes: { artifact: 'a'.repeat(64) } } })
    expect(evaluateEvidence(weak, ['artifact']).reason).toBe('verification_too_weak')
  })
})

describe('判定规则', () => {
  it('validateCondition 只认 evidence 下五个字段', () => {
    expect(() => validateCondition({ path: 'policy.requiredHashes', op: 'exists' })).toThrowError(/只能引用 evidence/)
    expect(() => validateCondition({ path: 'evidence.unknownField', op: 'exists' })).toThrowError(/不许引用的字段/)
    expect(() => validateCondition({ path: 'evidence.exitCode', op: 'eq' })).not.toThrow()
  })

  it('mergePassConditions：模板保留，节点追加；同路径同运算符取节点值', () => {
    const tmpl: PassCondition[] = [{ path: 'evidence.exitCode', op: 'eq', value: 0 }]
    const merged = mergePassConditions(tmpl, [
      { path: 'evidence.exitCode', op: 'eq', value: 1 },
      { path: 'evidence.hashes', op: 'hashContains', value: 'artifact' },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]?.value).toBe(1)
    expect(merged[1]?.op).toBe('hashContains')
    expect(tmpl[0]?.value).toBe(0)
  })

  it('evaluatePassConditions：命中 pass，不命中 reason 以 verdict_unmet 开头', () => {
    const cond: PassCondition[] = [{ path: 'evidence.exitCode', op: 'eq', value: 0 }]
    expect(evaluatePassConditions(cond, { exitCode: 0 }).pass).toBe(true)
    const bad = evaluatePassConditions(cond, { exitCode: 1 })
    expect(bad.pass).toBe(false)
    expect(bad.reason?.startsWith('verdict_unmet')).toBe(true)
  })

  it('exists 与 hashContains 都按字段判', () => {
    expect(evaluatePassConditions([{ path: 'evidence.producedAt', op: 'exists' }], {}).pass).toBe(false)
    expect(evaluatePassConditions([{ path: 'evidence.producedAt', op: 'exists' }], { producedAt: 'x' }).pass).toBe(true)
    expect(evaluatePassConditions([{ path: 'evidence.hashes', op: 'hashContains', value: 'artifact' }], { hashes: { artifact: 'x' } }).pass).toBe(true)
    expect(evaluatePassConditions([{ path: 'evidence.hashes', op: 'hashContains', value: 'artifact' }], { hashes: {} }).pass).toBe(false)
  })

  it('missingHashes 返回缺的那几个', () => {
    expect(missingHashes(undefined, ['a', 'b'])).toEqual(['a', 'b'])
    expect(missingHashes({ source: 'run_tool', hashes: { a: 'x' } }, ['a', 'b'])).toEqual(['b'])
  })
})
