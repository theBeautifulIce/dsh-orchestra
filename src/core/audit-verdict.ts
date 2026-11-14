// 审计报告里的结构化裁决块（第二次意见 P0 / 外部架构评审 P0）
//
// 以前门记录靠正文里的自然语言判定审计结论："结论：pass" 这类句子靠正则猜，
// 换个说法就误判（第四轮整改 F4 修的就是这个）。现在审计报告必须带一段机器可读的裁决 JSON，
// 门检查以它为放行依据；词法解析器退成兜底（没有裁决块的老报告仍能过）。
//
// 报告里的写法（审计者填，审计者自己算出来的结论，不是人写的）：
//
//   <!-- audit-verdict:begin -->
//   ```json
//   {
//     "schema": "audit-verdict/1",
//     "gate": "G2",
//     "audit_round": 34,
//     "candidate_commit": "<40 位 commit>",
//     "conclusion": "pass",
//     "p0": 0, "p1": 0, "p2": 3,
//     "must_pass_total": 19,
//     "must_pass_passed": 19,
//     "must_pass_ids": ["G2-01", "..."],
//     "failed_items": [],
//     "notes": "可选：这一轮的重点与遗留"
//   }
//   ```
//   <!-- audit-verdict:end -->
//
// 裁决块本身在审计报告文件里，报告的 sha256 已被门记录钉住，所以这块内容改不了也换不掉。
export const AUDIT_VERDICT_SCHEMA = 'audit-verdict/1'
export const VERDICT_BEGIN = '<!-- audit-verdict:begin -->'
export const VERDICT_END = '<!-- audit-verdict:end -->'

export interface AuditVerdict {
  schema: string
  gate: string
  audit_round: number
  candidate_commit: string
  conclusion: 'pass' | 'fail'
  p0: number
  p1: number
  p2: number
  must_pass_total: number
  must_pass_passed: number
  must_pass_ids: string[]
  failed_items: string[]
  notes?: string
}

export type VerdictParse =
  | { verdict: AuditVerdict }
  | { error: string }
  | null

// 取裁决块里的 JSON 原文：哨兵之间必须正好有一个 json 围栏，取不到就当没有裁决块
export function extractVerdictJson(text: string): string | null {
  const begin = text.indexOf(VERDICT_BEGIN)
  const end = text.indexOf(VERDICT_END)
  if (begin < 0 || end < 0 || end < begin) return null
  const inner = text.slice(begin + VERDICT_BEGIN.length, end)
  const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(inner)
  if (!fence) return null
  return fence[1] ?? null
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
}

// 逐字段验裁决块：报错的说法要能直接定位到哪个字段不对
export function validateAuditVerdict(value: unknown): { verdict: AuditVerdict } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: '裁决块必须是 JSON 对象' }
  }
  const v = value as Record<string, unknown>
  if (v.schema !== AUDIT_VERDICT_SCHEMA) {
    return { error: 'schema 必须是 ' + AUDIT_VERDICT_SCHEMA + '，实际 ' + JSON.stringify(v.schema) }
  }
  if (typeof v.gate !== 'string' || v.gate.length === 0) return { error: 'gate 必须是非空字符串' }
  if (!isCount(v.audit_round) || v.audit_round < 1) return { error: 'audit_round 必须是正整数' }
  if (typeof v.candidate_commit !== 'string' || !/^[0-9a-f]{40}$/.test(v.candidate_commit)) {
    return { error: 'candidate_commit 必须是 40 位 commit' }
  }
  if (v.conclusion !== 'pass' && v.conclusion !== 'fail') {
    return { error: 'conclusion 只能是 pass 或 fail' }
  }
  for (const key of ['p0', 'p1', 'p2'] as const) {
    if (!isCount(v[key])) return { error: key + ' 必须是非负整数' }
  }
  if (!isCount(v.must_pass_total)) return { error: 'must_pass_total 必须是非负整数' }
  if (!isCount(v.must_pass_passed)) return { error: 'must_pass_passed 必须是非负整数' }
  if (!isStringArray(v.must_pass_ids)) return { error: 'must_pass_ids 必须是字符串数组' }
  if (!Array.isArray(v.failed_items) || !v.failed_items.every((x) => typeof x === 'string')) {
    return { error: 'failed_items 必须是字符串数组' }
  }
  if (v.notes !== undefined && typeof v.notes !== 'string') return { error: 'notes 必须是字符串' }
  const verdict: AuditVerdict = {
    schema: AUDIT_VERDICT_SCHEMA,
    gate: v.gate,
    audit_round: v.audit_round,
    candidate_commit: v.candidate_commit,
    conclusion: v.conclusion,
    p0: v.p0 as number,
    p1: v.p1 as number,
    p2: v.p2 as number,
    must_pass_total: v.must_pass_total,
    must_pass_passed: v.must_pass_passed,
    must_pass_ids: v.must_pass_ids,
    failed_items: v.failed_items,
  }
  if (typeof v.notes === 'string') verdict.notes = v.notes
  return { verdict }
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1

// 从报告正文里解析裁决块：没有裁决块返回 null（走老的词法兜底），有但坏了返回 error
// 裁决块必须正好一个：多个块时「取第一个」等于让后追加的 fail 块白写，也等于让前一个 pass 块作废（S1 第 29 轮 P2-3）
export function parseAuditVerdict(text: string): VerdictParse {
  const begins = countOf(text, VERDICT_BEGIN)
  const ends = countOf(text, VERDICT_END)
  if (begins === 0 && ends === 0) return null
  if (begins !== 1 || ends !== 1) {
    return { error: '裁决块必须正好一个（找到 ' + String(begins) + ' 个开始标记、' + String(ends) + ' 个结束标记）：多块时谁算数不能靠猜' }
  }
  const raw = extractVerdictJson(text)
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    return { error: '裁决块不是合法 JSON：' + (err instanceof Error ? err.message : String(err)) }
  }
  return validateAuditVerdict(value)
}

export type VerdictContext = {
  // 门记录里写的门名与轮次
  gate: string
  auditRound: number
  // 报告正文里绑定的候选提交
  commit: string
  // 这道门必须过的项（门记录的固定清单）
  requiredItems: string[]
}

// 裁决与门记录对账：把所有不满足的地方一次列全，别一条一条试错
export function verdictProblems(v: AuditVerdict, ctx: VerdictContext): string[] {
  const problems: string[] = []
  if (v.gate !== ctx.gate) problems.push('裁决的门（' + v.gate + '）与门记录（' + ctx.gate + '）不符')
  if (v.audit_round !== ctx.auditRound) {
    problems.push('裁决的轮次（' + String(v.audit_round) + '）与门记录（' + String(ctx.auditRound) + '）不符')
  }
  if (v.candidate_commit !== ctx.commit) {
    problems.push('裁决的候选提交（' + v.candidate_commit.slice(0, 12) + '…）与报告绑定的提交（' + ctx.commit.slice(0, 12) + '…）不符')
  }
  if (v.conclusion !== 'pass') problems.push('审计结论是 fail')
  if (v.p0 > 0) problems.push('还有 ' + String(v.p0) + ' 个 P0')
  if (v.p1 > 0) problems.push('还有 ' + String(v.p1) + ' 个 P1')
  if (v.must_pass_passed !== v.must_pass_total) {
    problems.push('必过项没过完：' + String(v.must_pass_passed) + '/' + String(v.must_pass_total))
  }
  if (v.must_pass_total !== v.must_pass_ids.length) {
    problems.push('must_pass_total（' + String(v.must_pass_total) + '）与 must_pass_ids 的条数（' + String(v.must_pass_ids.length) + '）不符')
  }
  if (v.failed_items.length > 0) problems.push('failed_items 不为空：' + v.failed_items.join(','))
  const covered = new Set(v.must_pass_ids)
  const missing = ctx.requiredItems.filter((id) => !covered.has(id))
  if (missing.length > 0) problems.push('审计没覆盖这些必过项：' + missing.join(','))
  // 只比条数会让清单里混进规格外的 id 凑数：每个 id 都必须是这道门的必过项（S1 第 29 轮 P2-2）
  const allowed = new Set(ctx.requiredItems)
  const unknown = v.must_pass_ids.filter((id) => !allowed.has(id))
  if (unknown.length > 0) problems.push('must_pass_ids 里有门规格之外的项：' + unknown.join(','))
  return problems
}
