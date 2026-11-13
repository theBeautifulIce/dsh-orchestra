import { describe, expect, it } from 'vitest'
import {
  evaluateEvidence, evaluatePassConditions, mergePassConditions, missingHashes, validateCondition,
  type PassCondition,
} from '../src/core/policy.ts'
import type { Report } from '../src/core/report.ts'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'

const ARTIFACT = { file: 'build/app.tar', digest: 'a'.repeat(64) }
const ARTIFACT_HASH = sha256Hex(canonicalJson(ARTIFACT))
const OUTPUT = { artifact: ARTIFACT }

const report = (over: Partial<Report> = {}): Report => ({
  report_id: 'rep_1', node_run_id: 'nr1', attempt: 1, status: 'done',
  evidence: { source: 'run_tool', exitCode: 0, hashes: { artifact: ARTIFACT_HASH } },
  ...over,
})

// requiredHashes 的键必须在 output 里有同名字段，值必须等于该字段的产物哈希。
const trusted = { output: OUTPUT }

describe('证据门', () => {
  it('没有 evidence → ok=false、reason=evidence_missing', () => {
    const out = evaluateEvidence(report({ evidence: undefined }), [], trusted)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('evidence_missing')
  })

  it('来源决定强弱：run_tool 强、tool_result 弱', () => {
    expect(evaluateEvidence(report(), [], trusted).strength).toBe('strong')
    expect(evaluateEvidence(report({ evidence: { source: 'tool_result' } }), [], trusted).strength).toBe('weak')
  })

  it('必留哈希缺失 → verification_too_weak；补齐强证据 → ok', () => {
    const onlyExit = report({ evidence: { source: 'run_tool', exitCode: 0 } })
    expect(evaluateEvidence(onlyExit, ['artifact'], trusted).reason).toBe('verification_too_weak')
    expect(evaluateEvidence(report(), ['artifact'], trusted).ok).toBe(true)
  })

  it('形态合法的伪造哈希不算证据', () => {
    const forged = report({ evidence: { source: 'run_tool', exitCode: 0, hashes: { artifact: 'b'.repeat(64) } } })
    expect(evaluateEvidence(forged, ['artifact'], trusted).reason).toBe('verification_too_weak')
  })

  it('命令哈希不能冒充具名产物', () => {
    const forged = report({ evidence: { source: 'run_tool', exitCode: 0, hashes: { artifact: 'c'.repeat(64) } } })
    expect(evaluateEvidence(forged, ['artifact'], trusted).reason).toBe('verification_too_weak')
  })

  it('output 里没有同名产物 → verification_too_weak', () => {
    expect(evaluateEvidence(report(), ['bundle'], trusted).reason).toBe('verification_too_weak')
  })

  it('弱证据不做不可逆凭据', () => {
    const weak = report({ evidence: { source: 'tool_result', hashes: { artifact: ARTIFACT_HASH } } })
    expect(evaluateEvidence(weak, ['artifact'], trusted).reason).toBe('verification_too_weak')
  })
})

describe('判定规则', () => {
  it('validateCondition 只认 evidence 下五个字段', () => {
    expect(() => validateCondition({ path: 'policy.requiredHashes', op: 'exists' })).toThrowError(/只能引用 evidence/)
    expect(() => validateCondition({ path: 'evidence.unknownField', op: 'exists' })).toThrowError(/不许引用的字段/)
    expect(() => validateCondition({ path: 'evidence.exitCode', op: 'eq' })).not.toThrow()
  })

  it('mergePassConditions：模板为基线，同路径同运算符不同值两条都留（AND），不覆盖模板', () => {
    const tmpl: PassCondition[] = [{ path: 'evidence.exitCode', op: 'eq', value: 0 }]
    const merged = mergePassConditions(tmpl, [
      { path: 'evidence.exitCode', op: 'eq', value: 1 },
      { path: 'evidence.hashes', op: 'hashContains', value: 'artifact' },
    ])
    // 模板条件和节点条件必须同时成立：覆盖会悄悄放宽判定（审计 M-04）
    expect(merged).toHaveLength(3)
    expect(merged[0]?.value).toBe(0)
    expect(merged[1]?.value).toBe(1)
    expect(merged[2]?.op).toBe('hashContains')
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
