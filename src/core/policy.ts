// src/core/policy.ts —— 证据门与判定规则（规格 4.7 行 371-391）
import { OrchError } from './errors.ts'
import { canonicalJson, sha256Hex } from './canonical.ts'
import type { Report, ReportEvidence } from './report.ts'

export type EvidenceEvaluation = {
  ok: boolean
  reason?: string
  // 强证据还是弱证据：run_tool 强，模型侧 tool_result 弱（规格 4.7 行 380-383）
  strength: 'strong' | 'weak'
  digest: string
  normalized: Record<string, unknown>
}

// passCondition 只许引用这几个字段（规格 4.7 行 386）
export const ALLOWED_EVIDENCE_FIELDS = ['exitCode', 'stdoutHash', 'stderrHash', 'hashes', 'producedAt'] as const

export type EvidenceGateOptions = {
  // 产物本体：requiredHashes 的每个键都必须在 output 里有同名字段，
  // 且证据值必须等于该字段的 sha256(canonicalJson(value))。
  // 这样 commandHash / stdoutHash / 整个 output 的摘要都不能冒充某个具名产物，
  // 两个 required key 也不能填同一个哈希（S2 第二十五轮 P1-1）。
  output?: unknown
  // A verified ledger can retain the digest of each product instead of its contents.
  registeredProductDigests?: Readonly<Record<string, string>>
}

export function evaluateEvidence(
  report: Report,
  requiredHashes: string[],
  options: EvidenceGateOptions,
): EvidenceEvaluation {
  const ev: ReportEvidence | undefined = report.evidence
  if (!ev) {
    return { ok: false, reason: 'evidence_missing', strength: 'weak', digest: sha256Hex(canonicalJson({})), normalized: {} }
  }
  const strength: 'strong' | 'weak' = ev.source === 'run_tool' ? 'strong' : 'weak'
  const normalized: Record<string, unknown> = {
    exitCode: ev.exitCode,
    stdoutHash: ev.stdoutHash,
    stderrHash: ev.stderrHash,
    hashes: ev.hashes ?? {},
    producedAt: ev.producedAt,
  }
  const digest = sha256Hex(canonicalJson(normalized))
  // 不可逆节点的通过凭据必须是产物哈希，只有 exitCode 不够（规格 4.7 行 380）
  // 哈希值本身也要是 sha256 形态：只给键名、值写 not-a-real-hash 不算证据（S2 第二十三轮 P0-4）
  if (requiredHashes.length > 0) {
    const provided = ev.hashes ?? {}
    const output = options.output
    const outputObject = output !== null && typeof output === 'object' && !Array.isArray(output)
      ? output as Record<string, unknown>
      : null
    const productDigest = (key: string): string | undefined => {
      const registered = options.registeredProductDigests
      if (registered) return Object.hasOwn(registered, key) ? registered[key] : undefined
      if (!outputObject || !Object.hasOwn(outputObject, key)) return undefined
      const product = outputObject[key]
      return product === null || product === undefined ? undefined : sha256Hex(canonicalJson(product))
    }
    const productDigests = requiredHashes.map(productDigest)
    const invalid = requiredHashes.some((h, index) => {
      const value = provided[h]
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return true
      return value.toLowerCase() !== productDigests[index]
    })
    if (invalid) {
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
    // 每个 required key 必须对应一份独立产物：两个键共用同一份内容时，
    // 一个产物只能证明一个 key，不能同时充当两份凭据（S2 第二十六轮 P2-2）。
    if (new Set(productDigests).size !== productDigests.length) {
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
    if (strength === 'weak') {
      // 弱证据不能充当不可逆节点的通过凭据（规格 4.7 行 383-384）
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
  }
  return { ok: true, strength, digest, normalized }
}

export type PassCondition = {
  // 形如 { path: 'evidence.exitCode', op: 'eq', value: 0 }
  path: string
  op: 'eq' | 'ne' | 'exists' | 'hashContains'
  value?: unknown
}

export type Verdict = { pass: boolean; reason?: string }

// 条件里的路径只许引用证据字段；引用 policy.requiredHashes 这类非法（规格 4.7 行 386）
export function validateCondition(condition: PassCondition): void {
  if (!condition.path.startsWith('evidence.')) {
    throw new OrchError('VERDICT_UNSUPPORTED', '判定条件只能引用 evidence 下的字段', { path: condition.path })
  }
  const field = condition.path.slice('evidence.'.length)
  if (!(ALLOWED_EVIDENCE_FIELDS as readonly string[]).includes(field)) {
    throw new OrchError('VERDICT_UNSUPPORTED', '判定条件引用了不许引用的字段', { path: condition.path })
  }
}

// 模板 passCondition 是 mandatory baseline，节点只能 and 追加（规格 4.7 行 390）
// 模板条件是基线，节点只能追加更严的条件，不许覆盖模板值（规格 4.7 行 390）
// 求值时逐条 AND，所以同路径不同值两条都留着，效果是“两个都要满足”
export function mergePassConditions(template: PassCondition[], node: PassCondition[]): PassCondition[] {
  const merged = template.map((c) => ({ ...c }))
  for (const cond of node) {
    const identical = merged.find((c) => c.path === cond.path && c.op === cond.op
      && canonicalJson(c.value ?? null) === canonicalJson(cond.value ?? null))
    if (identical) continue
    merged.push({ ...cond })
  }
  return merged
}

export function evaluatePassConditions(conditions: PassCondition[], evidence: Record<string, unknown>): Verdict {
  for (const cond of conditions) {
    validateCondition(cond)
    const field = cond.path.slice('evidence.'.length)
    const actual = evidence[field]
    if (cond.op === 'exists') {
      if (actual === undefined || actual === null) return { pass: false, reason: 'verdict_unmet:' + cond.path }
      continue
    }
    if (cond.op === 'eq' && actual !== cond.value) {
      return { pass: false, reason: 'verdict_unmet:' + cond.path }
    }
    if (cond.op === 'ne' && actual === cond.value) {
      return { pass: false, reason: 'verdict_unmet:' + cond.path }
    }
    if (cond.op === 'hashContains') {
      const hashes = (actual ?? {}) as Record<string, unknown>
      const key = String(cond.value ?? '')
      if (!Object.prototype.hasOwnProperty.call(hashes, key)) {
        return { pass: false, reason: 'verdict_unmet:' + cond.path }
      }
    }
  }
  return { pass: true }
}

export type EvidenceGapDecision = {
  next_status: 'blocked_post'
  // 证据不足不是失败，是等人来核（规格 4.7 行 389）
  request: { kind: 'verify_human'; reason: string; missing: string[] }
}

// 缺哪些必留哈希
export function missingHashes(evidence: ReportEvidence | undefined, requiredHashes: string[]): string[] {
  if (!evidence) return requiredHashes.slice()
  const provided = new Set(Object.keys(evidence.hashes ?? {}))
  return requiredHashes.filter((h) => !provided.has(h))
}


// ── S3 Task 7：声明式 policy 求值与 branch 路由（规格 5.4、设计稿 §5）──────

export type PolicyOperator =
  | 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'match'

export type PolicyCondition =
  | { all: readonly PolicyCondition[] }
  | { any: readonly PolicyCondition[] }
  | { not: PolicyCondition }
  | { path: string; op: PolicyOperator; value?: unknown }

export type PolicyMustPassItem = {
  id: string
  result: 'pass' | 'fail'
  evidence_ids: string[]
}

export type PolicyOutcome = {
  schema_version: 1
  matched: boolean
  ruleId: string | null
  decision: 'pass' | 'fail'
  must_pass_items: PolicyMustPassItem[]
  failed_items: string[]
  evidence_ids: string[]
  reason: string
}

const POLICY_OPERATORS: readonly PolicyOperator[] = [
  'eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'exists', 'match',
]
const MAX_POLICY_DEPTH = 32

function policyError(message: string, details?: Record<string, unknown>): never {
  throw new OrchError('VERDICT_UNSUPPORTED', message, details)
}

function readPath(input: unknown, path: string): unknown {
  let current: unknown = input
  for (const segment of path.split('.')) {
    if (segment.length === 0) policyError('policy 路径含空段', { path })
    if (current === null || typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

function compareNumbers(actual: unknown, expected: unknown, op: string): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') {
    policyError('gt/gte/lt/lte 只接受数字', { op, actual, expected })
  }
  if (op === 'gt') return actual > expected
  if (op === 'gte') return actual >= expected
  if (op === 'lt') return actual < expected
  return actual <= expected
}

/** 编译期校验：只认白名单算子与显式 all/any/not，不许 eval、脚本、读文件。 */
export function validatePolicy(condition: PolicyCondition, depth = 0): void {
  if (depth > MAX_POLICY_DEPTH) policyError('policy 嵌套过深', { depth })
  if (condition === null || typeof condition !== 'object') policyError('policy 条件必须是对象')
  if ('all' in condition || 'any' in condition) {
    const key = 'all' in condition ? 'all' : 'any'
    const list = (condition as Record<string, unknown>)[key]
    if (!Array.isArray(list) || list.length === 0) policyError(`policy ${key} 必须是非空数组`)
    for (const child of list) validatePolicy(child as PolicyCondition, depth + 1)
    return
  }
  if ('not' in condition) {
    validatePolicy((condition as { not: PolicyCondition }).not, depth + 1)
    return
  }
  const cond = condition as { path?: unknown; op?: unknown; value?: unknown }
  if (typeof cond.path !== 'string' || cond.path.length === 0) policyError('policy 条件缺 path')
  if (cond.path.split('.').some((segment) => !segment)) policyError('policy 路径含空段', { path: cond.path })
  if (typeof cond.op !== 'string' || !(POLICY_OPERATORS as readonly string[]).includes(cond.op)) {
    policyError('policy 算子不在白名单', { op: cond.op })
  }
  if (cond.op === 'match' && typeof cond.value !== 'string') {
    policyError('match 的 value 必须是正则字符串', { path: cond.path })
  }
  if (cond.op === 'in' && !Array.isArray(cond.value)) policyError('in 的 value 必须是数组', { path: cond.path })
  if (['gt', 'gte', 'lt', 'lte'].includes(cond.op) && (typeof cond.value !== 'number' || !Number.isFinite(cond.value))) {
    policyError('gt/gte/lt/lte 只接受数字', { path: cond.path })
  }
  if ((cond.op === 'eq' || cond.op === 'ne') && cond.value === undefined) policyError('比较条件缺少 value', { path: cond.path })
  if (cond.op === 'match') {
    try {
      new RegExp(String(cond.value))
    } catch {
      policyError('match 的正则非法', { path: cond.path })
    }
  }
}

function evaluateConditionNode(condition: PolicyCondition, input: unknown): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateConditionNode(child, input))
  if ('any' in condition) return condition.any.some((child) => evaluateConditionNode(child, input))
  if ('not' in condition) return !evaluateConditionNode(condition.not, input)
  const actual = readPath(input, condition.path)
  if (actual === undefined && condition.op !== 'exists') return false
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'eq':
      return sameValue(actual, condition.value)
    case 'ne':
      return !sameValue(actual, condition.value)
    case 'in':
      if (!Array.isArray(condition.value)) policyError('in 的 value 必须是数组', { path: condition.path })
      return condition.value.some((candidate) => sameValue(actual, candidate))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumbers(actual, condition.value, condition.op)
    case 'match':
      return typeof actual === 'string' && new RegExp(String(condition.value)).test(actual)
  }
}

export type EvaluatePolicyOptions = {
  ruleId?: string
  evidenceIds?: string[]
}

/**
 * 返回固定形状：decision 由 matched 确定性映射，branch 只读 decision。
 * 不返回 artifact；求值事件由调用方追加到 node_run_events。
 */
export function evaluatePolicy(
  condition: PolicyCondition | readonly PolicyCondition[],
  input: unknown,
  options: EvaluatePolicyOptions = {},
): PolicyOutcome {
  const root: PolicyCondition = Array.isArray(condition)
    ? { all: condition as readonly PolicyCondition[] }
    : condition as PolicyCondition
  validatePolicy(root)
  const matched = evaluateConditionNode(root, input)
  const ruleId = options.ruleId ?? 'inline'
  const evidenceIds = options.evidenceIds?.slice() ?? []
  return {
    schema_version: 1,
    matched,
    ruleId: matched ? ruleId : null,
    decision: matched ? 'pass' : 'fail',
    must_pass_items: [{ id: ruleId, result: matched ? 'pass' : 'fail', evidence_ids: evidenceIds }],
    failed_items: matched ? [] : [ruleId],
    evidence_ids: evidenceIds,
    reason: matched ? '全部必过项通过' : `必过项未通过：${ruleId}`,
  }
}

export type BranchEdge = {
  to: string
  when?: PolicyCondition
  // 每条出边必须二选一：0–999 的优先级，或 default=true（全局最多一条）
  priority?: number
  default?: boolean
}

export type BranchChoice =
  | { kind: 'selected'; to: string; ruleId: string }
  | { kind: 'blocked'; reason: 'no_match' | 'ambiguous'; matched: string[] }

/** 静态校验出边声明，加载期也要走同一条。 */
export function validateBranchEdges(edges: readonly BranchEdge[]): void {
  const seen = new Set<string>()
  let defaults = 0
  for (const edge of edges) {
    if (!edge.to) policyError('branch 出边缺 to')
    if (seen.has(edge.to)) policyError('branch 出边重复', { to: edge.to })
    seen.add(edge.to)
    const hasPriority = edge.priority !== undefined
    const hasDefault = edge.default === true
    if (hasPriority === hasDefault) policyError('branch 出边必须二选一：priority 或 default', { to: edge.to })
    if (hasPriority && (!Number.isInteger(edge.priority) || edge.priority! < 0 || edge.priority! > 999)) {
      policyError('branch priority 必须在 0–999', { to: edge.to, priority: edge.priority })
    }
    if (hasDefault) defaults += 1
    if (hasDefault && edge.when !== undefined) {
      policyError('default 出边不能带条件', { to: edge.to })
    }
  }
  if (defaults > 1) policyError('branch 只能有一条 default 出边', { defaults })
}

/** 运行期路由：多命中一律 BRANCH_AMBIGUOUS，不按 priority 猜。 */
export function chooseBranch(edges: readonly BranchEdge[], input: unknown): BranchChoice {
  validateBranchEdges(edges)
  const matched: string[] = []
  let defaultEdge: BranchEdge | undefined
  for (const edge of edges) {
    if (edge.default === true) {
      defaultEdge = edge
      continue
    }
    if (edge.when === undefined) policyError('非 default 出边必须有 when', { to: edge.to })
    if (evaluatePolicy(edge.when, input, { ruleId: edge.to }).matched) matched.push(edge.to)
  }
  if (matched.length > 1) return { kind: 'blocked', reason: 'ambiguous', matched }
  if (matched.length === 1) return { kind: 'selected', to: matched[0]!, ruleId: matched[0]! }
  if (defaultEdge) return { kind: 'selected', to: defaultEdge.to, ruleId: defaultEdge.to }
  return { kind: 'blocked', reason: 'no_match', matched: [] }
}
