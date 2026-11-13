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
    const invalid = requiredHashes.filter((h) => {
      const value = provided[h]
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return true
      // 键语义必须绑定到 output 的同名字段：没有产物、或产物哈希不等于证据值，都不算。
      if (outputObject === null || !Object.prototype.hasOwnProperty.call(outputObject, h)) return true
      // 产物为 null/undefined 时没有可核验内容，不能拿 sha256("null") 当凭据（S2 第二十六轮 P2-1）。
      const product = outputObject[h]
      if (product === null || product === undefined) return true
      const expected = sha256Hex(canonicalJson(product))
      return value.toLowerCase() !== expected.toLowerCase()
    })
    if (invalid.length > 0) {
      return { ok: false, reason: 'verification_too_weak', strength, digest, normalized }
    }
    // 每个 required key 必须对应一份独立产物：两个键共用同一份内容时，
    // 一个产物只能证明一个 key，不能同时充当两份凭据（S2 第二十六轮 P2-2）。
    const productDigests = requiredHashes.map((h) => sha256Hex(canonicalJson(outputObject![h])))
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
