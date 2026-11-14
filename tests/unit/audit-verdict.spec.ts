import { describe, expect, it } from 'vitest'
import {
  AUDIT_VERDICT_SCHEMA,
  VERDICT_BEGIN,
  VERDICT_END,
  extractVerdictJson,
  parseAuditVerdict,
  validateAuditVerdict,
  verdictProblems,
  type AuditVerdict,
} from '../../src/core/audit-verdict.ts'

const COMMIT = 'a'.repeat(40)
const TICK = String.fromCharCode(96)
const FENCE = TICK + TICK + TICK

const base = {
  schema: AUDIT_VERDICT_SCHEMA,
  gate: 'G2',
  audit_round: 34,
  candidate_commit: COMMIT,
  conclusion: 'pass',
  p0: 0,
  p1: 0,
  p2: 3,
  must_pass_total: 2,
  must_pass_passed: 2,
  must_pass_ids: ['G2-01', 'G2-02'],
  failed_items: [],
} satisfies Omit<AuditVerdict, 'notes'>

const report = (value: unknown): string =>
  [
    '# S2 第四轮独立审计报告',
    '',
    VERDICT_BEGIN,
    FENCE + 'json',
    JSON.stringify(value, null, 2),
    FENCE,
    VERDICT_END,
    '',
    '结论：pass',
    '',
  ].join('\n')

const ctx = { gate: 'G2', auditRound: 34, commit: COMMIT, requiredItems: ['G2-01', 'G2-02'] }
const errorOf = (r: { error: string } | { verdict: AuditVerdict } | null): string =>
  r && 'error' in r ? r.error : ''

describe('结构化审计裁决：解析', () => {
  it('没有裁决块时返回 null（走词法兜底，不当成坏块）', () => {
    expect(parseAuditVerdict('# 报告\n\n结论：pass\n')).toBeNull()
    expect(extractVerdictJson('# 报告')).toBeNull()
  })

  it('裁决块不是合法 JSON 时报 error，不静默放过', () => {
    const parsed = parseAuditVerdict(
      [VERDICT_BEGIN, FENCE + 'json', '{ 不是 JSON', FENCE, VERDICT_END].join('\n'),
    )
    expect(parsed).not.toBeNull()
    expect(errorOf(parsed)).toMatch(/不是合法 JSON/)
  })

  it('哨兵之间没有 json 围栏时当作没有裁决块', () => {
    expect(extractVerdictJson(VERDICT_BEGIN + '\n{"a":1}\n' + VERDICT_END)).toBeNull()
  })

  it('合法裁决块解析成结构体，notes 可选', () => {
    expect(parseAuditVerdict(report(base))).toEqual({ verdict: base })
    const withNotes = parseAuditVerdict(report({ ...base, notes: '本轮遗留 3 条 P2' }))
    const v = withNotes && 'verdict' in withNotes ? withNotes.verdict : null
    expect(v && v.notes).toBe('本轮遗留 3 条 P2')
  })
})

describe('结构化审计裁决：字段校验', () => {
  it('schema 必须对', () => {
    expect(errorOf(validateAuditVerdict({ ...base, schema: 'audit-verdict/2' }))).toMatch(/schema/)
  })

  it('候选提交必须是 40 位 commit', () => {
    expect(errorOf(validateAuditVerdict({ ...base, candidate_commit: 'abc123' }))).toMatch(/candidate_commit/)
  })

  it('结论只能是 pass 或 fail', () => {
    expect(errorOf(validateAuditVerdict({ ...base, conclusion: 'maybe' }))).toMatch(/conclusion/)
  })

  it('问题数必须是非负整数', () => {
    expect(errorOf(validateAuditVerdict({ ...base, p0: -1 }))).toMatch(/p0/)
    expect(errorOf(validateAuditVerdict({ ...base, p1: 1.5 }))).toMatch(/p1/)
  })

  it('必过项与失败项必须是字符串数组', () => {
    expect(errorOf(validateAuditVerdict({ ...base, must_pass_ids: [1, 2] }))).toMatch(/must_pass_ids/)
    expect(errorOf(validateAuditVerdict({ ...base, failed_items: 'G2-01' }))).toMatch(/failed_items/)
  })

  it('不是对象就报错', () => {
    expect(errorOf(validateAuditVerdict('pass'))).toMatch(/JSON 对象/)
  })
})

describe('结构化审计裁决：与门记录对账', () => {
  it('全对时没有问题', () => {
    expect(verdictProblems(base as AuditVerdict, ctx)).toEqual([])
  })

  it('门名、轮次、提交对不上都要报出来', () => {
    const problems = verdictProblems(
      { ...base, gate: 'G1', audit_round: 33, candidate_commit: 'b'.repeat(40) } as AuditVerdict,
      ctx,
    )
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/门/)
    expect(problems.join('\n')).toMatch(/轮次/)
    expect(problems.join('\n')).toMatch(/提交/)
  })

  it('结论 fail、P0/P1 未清零都要拦', () => {
    expect(verdictProblems({ ...base, conclusion: 'fail' } as AuditVerdict, ctx).join('\n')).toMatch(/fail/)
    expect(verdictProblems({ ...base, p0: 1 } as AuditVerdict, ctx).join('\n')).toMatch(/P0/)
    expect(verdictProblems({ ...base, p1: 2 } as AuditVerdict, ctx).join('\n')).toMatch(/P1/)
  })

  it('必过项没过完、数量对不上、失败项非空都要拦', () => {
    expect(verdictProblems({ ...base, must_pass_passed: 1 } as AuditVerdict, ctx).join('\n')).toMatch(/必过项没过完/)
    expect(verdictProblems({ ...base, must_pass_total: 3 } as AuditVerdict, ctx).join('\n')).toMatch(/must_pass_total/)
    expect(verdictProblems({ ...base, failed_items: ['G2-07'] } as AuditVerdict, ctx).join('\n')).toMatch(/failed_items/)
  })

  it('门固定必过项没被审计覆盖要拦', () => {
    const problems = verdictProblems({ ...base, must_pass_ids: ['G2-01'] } as AuditVerdict, ctx)
    expect(problems.join('\n')).toMatch(/没覆盖/)
    expect(problems.join('\n')).toMatch(/G2-02/)
  })

  it('must_pass_ids 重复列同一项把总数抬高要拦（S1 第三十轮 P2-2）', () => {
    const problems = verdictProblems(
      { ...base, must_pass_total: 3, must_pass_passed: 3, must_pass_ids: ['G2-01', 'G2-02', 'G2-01'] } as AuditVerdict,
      ctx,
    )
    expect(problems.join('\n')).toMatch(/重复/)
    expect(problems.join('\n')).toMatch(/门规格的必过项数/)
  })

  it('must_pass_ids 混进规格外的项要拦（不是只比条数）', () => {
    const problems = verdictProblems(
      { ...base, must_pass_total: 3, must_pass_passed: 3, must_pass_ids: ['G2-01', 'G2-02', 'G2-99'] } as AuditVerdict,
      ctx,
    )
    expect(problems.join('\n')).toMatch(/门规格之外/)
    expect(problems.join('\n')).toMatch(/G2-99/)
  })
})

describe('结构化审计裁决：裁决块唯一', () => {
  it('两个裁决块时判为坏块，不按位置取第一个', () => {
    const one = [VERDICT_BEGIN, FENCE + 'json', JSON.stringify(base), FENCE, VERDICT_END].join('\n')
    const parsed = parseAuditVerdict(one + '\n' + one)
    expect(errorOf(parsed)).toMatch(/正好一个/)
  })

  it('两个块一 pass 一 fail 同样判为坏块', () => {
    const pass = [VERDICT_BEGIN, FENCE + 'json', JSON.stringify(base), FENCE, VERDICT_END].join('\n')
    const fail = [VERDICT_BEGIN, FENCE + 'json', JSON.stringify({ ...base, conclusion: 'fail' }), FENCE, VERDICT_END].join('\n')
    const parsed = parseAuditVerdict(pass + '\n' + fail)
    expect(errorOf(parsed)).toMatch(/正好一个/)
  })

  it('只有一个块时照旧解析（阳性对照）', () => {
    const parsed = parseAuditVerdict(report(base))
    expect(parsed && 'verdict' in parsed && parsed.verdict.conclusion).toBe('pass')
  })
})
