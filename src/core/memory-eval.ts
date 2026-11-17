// src/core/memory-eval.ts —— memory.evaluate 评估端口的纯逻辑层
//
// 规格 9.5（评估口径，docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md:712-724）：
//   判定规则、截断处置、四类失败错误码、唯一键 (batch_id, eval_attempt)、响应 JSON ≤ 64 KiB。
// 规格 9.6（审批，同文件:725-734）：只有 recommendation=ready 才生成审批卡，kind=audit_result，
//   allowed_resolutions 为空、resolve payload 为空对象、卡片文案逐字。
// 规格 9.11（端口字段契约，同文件:778-838）：请求体/响应体字段名以本节为准，本文件逐字照抄。
//
// 纯逻辑层：不 import src/infra/**、不 import src/service/**、不写库、不调端口、不生成审批卡落库。
// 只 import src/core/errors.ts（OrchError）与 src/core/memory-canonical.ts（条目类型与哈希口径）。
import { OrchError } from './errors.ts'
import { MEMORY_LIMITS, contentHash, type MemoryItemInput } from './memory-canonical.ts'

/** 裁判正文上限（字）：正文超过 4000 字只给前 4000 字并标 truncated=true（规格 9.5 行 718） */
export const JUDGE_CONTENT_LIMIT = 4000

/** 裁判响应 JSON 上限（字节）：64 KiB（规格 9.5 行 722） */
export const EVAL_RESPONSE_MAX_BYTES = 64 * 1024

/** 记忆层级白名单（规格 9.11 policy.allowed_layers） */
export type MemoryLayer = 'L2' | 'L4' | 'L5' | 'L6'

export type EvalVerdict = 'approve' | 'reject' | 'merge' | 'needs_user'

export type EvalRecommendation = 'ready' | 'empty' | 'blocked'

export type EvalItem = {
  client_key: string
  verdict: EvalVerdict
  reason: string
  confidence: number
  conflict_with?: string | null
}

export type EvalResult = {
  recommendation: EvalRecommendation
  items: EvalItem[]
  truncated: boolean
  model: { provider: string; name: string; prompt_version: string }
  summary: string
  duration_ms: number
}

const EVAL_VERDICTS: readonly string[] = ['approve', 'reject', 'merge', 'needs_user']

function isEvalVerdict(value: unknown): value is EvalVerdict {
  return typeof value === 'string' && EVAL_VERDICTS.includes(value)
}

/** 评估侧所有失败都走既有错误码 MEMORY_EVAL_INVALID_OUTPUT（502）（src/core/errors.ts:77） */
function invalid(message: string, details: Record<string, unknown> = {}): OrchError {
  return new OrchError('MEMORY_EVAL_INVALID_OUTPUT', message, details)
}

/**
 * 判定规则（规格 9.5 行 719）：
 * 任一条 needs_user → blocked；无 needs_user 且至少一条 approve/merge → ready；全 reject → empty。
 */
export function summarize(items: EvalItem[]): EvalRecommendation {
  if (items.some((item) => item.verdict === 'needs_user')) return 'blocked'
  if (items.some((item) => item.verdict === 'approve' || item.verdict === 'merge')) return 'ready'
  return 'empty'
}

/**
 * 截断处置（规格 9.5 行 720）：truncated=true 且没有 needs_user → MEMORY_EVAL_INVALID_OUTPUT（502）。
 * 截断过的内容不许被当作完整判断。
 */
export function assertEvalShape(items: EvalItem[], truncated: boolean): void {
  if (truncated && !items.some((item) => item.verdict === 'needs_user')) {
    throw invalid('裁判输出被截断了，结论不可用')
  }
}

function parseEvalItem(entry: unknown, index: number): EvalItem {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw invalid('裁判返回的 items 里有一条不是对象', { index })
  }
  const item = entry as Record<string, unknown>
  const client_key = item.client_key
  if (typeof client_key !== 'string' || client_key.length === 0) {
    throw invalid('裁判返回的条目缺 client_key', { index })
  }
  if (!isEvalVerdict(item.verdict)) {
    throw invalid('裁判返回的 verdict 不在四值内', { index, client_key, verdict: String(item.verdict) })
  }
  const confidence = item.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw invalid('裁判返回的 confidence 不是数字', { index, client_key })
  }
  const reason = item.reason === undefined ? '' : item.reason
  if (typeof reason !== 'string') {
    throw invalid('裁判返回的 reason 不是字符串', { index, client_key })
  }
  const conflict_with = item.conflict_with === undefined ? null : item.conflict_with
  if (conflict_with !== null && typeof conflict_with !== 'string') {
    throw invalid('裁判返回的 conflict_with 不是字符串或 null', { index, client_key })
  }
  return { client_key, verdict: item.verdict, reason, confidence, conflict_with }
}

function parseEvalModel(value: unknown): EvalResult['model'] {
  if (value === undefined || value === null) {
    return { provider: '', name: '', prompt_version: '' }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('裁判响应的 model 不是对象')
  }
  const model = value as Record<string, unknown>
  const field = (raw: unknown, name: string): string => {
    if (raw === undefined || raw === null) return ''
    if (typeof raw !== 'string') throw invalid('裁判响应的 model.' + name + ' 不是字符串')
    return raw
  }
  return {
    provider: field(model.provider, 'provider'),
    name: field(model.name, 'name'),
    prompt_version: field(model.prompt_version, 'prompt_version'),
  }
}

/**
 * 裁判响应解析（严格 schema）：
 * 非 JSON、缺 items、verdict 不在四值内、confidence 非数字、响应超过 64 KiB → MEMORY_EVAL_INVALID_OUTPUT（502）
 * （规格 9.5 行 721-722；计划 Task 13 行 1962）。
 * recommendation 一律由逐条判定推导（规格 9.5 行 719），响应里带的 recommendation 对不上也算非法输出。
 */
export function parseJudgeResponse(raw: string): EvalResult {
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > EVAL_RESPONSE_MAX_BYTES) {
    throw invalid('裁判响应超过 64 KiB', { limit_bytes: EVAL_RESPONSE_MAX_BYTES, bytes })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw invalid('裁判响应不是合法 JSON', { message: err instanceof Error ? err.message : String(err) })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('裁判响应不是 JSON 对象')
  }
  const body = parsed as Record<string, unknown>
  if (body.ok === false) {
    throw invalid('裁判端口返回失败')
  }
  const rawItems = body.items
  if (!Array.isArray(rawItems)) {
    throw invalid('裁判响应缺 items')
  }
  const items = rawItems.map((entry, index) => parseEvalItem(entry, index))
  const truncated = body.truncated === true
  const model = parseEvalModel(body.model)
  const summary = body.summary === undefined ? '' : body.summary
  if (typeof summary !== 'string') {
    throw invalid('裁判响应的 summary 不是字符串')
  }
  const duration = body.duration_ms === undefined ? 0 : body.duration_ms
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    throw invalid('裁判响应的 duration_ms 不是数字')
  }
  const recommendation = summarize(items)
  if (body.recommendation !== undefined && body.recommendation !== recommendation) {
    throw invalid('裁判响应的 recommendation 与逐条判定不一致', {
      declared: String(body.recommendation),
      derived: recommendation,
    })
  }
  assertEvalShape(items, truncated)
  return { recommendation, items, truncated, model, summary, duration_ms: duration }
}

// ---------------------------------------------------------------- 请求体组装（规格 9.11 行 782-817）

export type EvalSimilar = { id: string; title: string; summary: string; score: number }

export type EvalRequestSource = {
  run_id: string
  task_title: string
  goal: string
  result_summary: string
  evidence_refs: string[]
}

export type EvalRequestPolicy = {
  allowed_layers: MemoryLayer[]
  max_items: number
  max_content_bytes: number
  allow_update: boolean
  require_quote: boolean
  judge_content_limit: number
}

export type EvalRequestItem = {
  client_key: string
  action: 'create' | 'update'
  target_id: string | null
  layer: MemoryLayer
  title: string
  content: string
  content_hash: string
  quote: string
  similar: EvalSimilar[]
}

export type EvalRequest = {
  batch_id: string
  prepare_node_run_id: string
  source: EvalRequestSource
  policy: EvalRequestPolicy
  items: EvalRequestItem[]
}

/** 待评估条目：规格 9.11 的 items 字段 + 相似条目（相似条目由调用侧查好带进来） */
export type EvalCandidate = MemoryItemInput & { similar?: EvalSimilar[]; content_hash?: string }

export type BuildEvaluateRequestInput = {
  batch_id: string
  prepare_node_run_id: string
  source: EvalRequestSource
  policy?: Partial<EvalRequestPolicy>
  items: EvalCandidate[]
}

export type BuildEvaluateRequestResult = {
  /** 请求体：字段名逐字照抄规格 9.11，不改名不改语义 */
  request: EvalRequest
  /** 服务端是否截断过正文：正文超 4000 字只给前 4000 字（规格 9.5 行 718） */
  truncated: boolean
  /** 被截断条目的 client_key */
  truncated_client_keys: string[]
}

const DEFAULT_ALLOWED_LAYERS: MemoryLayer[] = ['L2', 'L4', 'L5', 'L6']

/** 按字（码点）截断，不切开代理对 */
function truncateByChars(content: string, limit: number): { content: string; truncated: boolean } {
  const chars = Array.from(content)
  if (chars.length <= limit) return { content, truncated: false }
  return { content: chars.slice(0, limit).join(''), truncated: true }
}

/**
 * 组装 memory.evaluate 请求体（规格 9.11 行 782-817）：只组装，不发送。
 * 正文超过 judge_content_limit 只给前 4000 字，并把截断事实带回给调用侧
 * ——调用侧用 assertEvalShape 决定 truncated=true 时不许当完整判断（规格 9.5 行 718、720）。
 */
export function buildEvaluateRequest(input: BuildEvaluateRequestInput): BuildEvaluateRequestResult {
  const limit = input.policy?.judge_content_limit ?? JUDGE_CONTENT_LIMIT
  const policy: EvalRequestPolicy = {
    allowed_layers: input.policy?.allowed_layers ?? [...DEFAULT_ALLOWED_LAYERS],
    max_items: input.policy?.max_items ?? MEMORY_LIMITS.items,
    max_content_bytes: input.policy?.max_content_bytes ?? MEMORY_LIMITS.itemBytes,
    allow_update: input.policy?.allow_update ?? true,
    require_quote: input.policy?.require_quote ?? true,
    judge_content_limit: limit,
  }
  const truncated_client_keys: string[] = []
  const items: EvalRequestItem[] = input.items.map((item) => {
    const cut = truncateByChars(item.content, limit)
    if (cut.truncated) truncated_client_keys.push(item.client_key)
    return {
      client_key: item.client_key,
      action: item.action,
      target_id: item.target_id,
      layer: item.layer,
      title: item.title,
      content: cut.content,
      content_hash: item.content_hash ?? contentHash(item),
      quote: item.quote,
      similar: item.similar ?? [],
    }
  })
  const request: EvalRequest = {
    batch_id: input.batch_id,
    prepare_node_run_id: input.prepare_node_run_id,
    source: {
      run_id: input.source.run_id,
      task_title: input.source.task_title,
      goal: input.source.goal,
      result_summary: input.source.result_summary,
      evidence_refs: [...input.source.evidence_refs],
    },
    policy,
    items,
  }
  return { request, truncated: truncated_client_keys.length > 0, truncated_client_keys }
}

// ---------------------------------------------------------------- 审批卡文案（规格 9.6 行 725-734）

export type ApprovalCardItem = { layer: string; title: string; digest: string; judge_reason: string }

export type ApprovalCardButton = { label: string; resolution: 'approved' | 'rejected' }

export type ApprovalCard = {
  kind: 'audit_result'
  title: string
  summary_line: string
  items: ApprovalCardItem[]
  buttons: ApprovalCardButton[]
  /** allowed_resolutions 为空，只产生 approved / rejected（规格 9.6 行 728） */
  allowed_resolutions: string[]
  /** resolve 的 payload 是空对象（规格 9.6 行 728） */
  resolve_payload: Record<string, unknown>
  /** 展开「为什么记这条」（规格 9.6 行 729） */
  expand_label: string
}

/**
 * 审批卡（规格 9.6 行 729）：只有 recommendation=ready 才生成（由调用侧把关）。
 * 首行「这次整理出 N 条 / 建议写入 M 条 / 不写 K 条」；每条一行层、标题、摘要、裁判理由；
 * 按钮「按这个方案写入」「这次不写」。卡片不展示 session_id / node_run_id / batch_id（规格 9.6 行 730）。
 */
export function buildApprovalCard(prepared: MemoryItemInput[], items: EvalItem[]): ApprovalCard {
  const written = items.filter((item) => item.verdict === 'approve' || item.verdict === 'merge')
  const skipped = items.filter((item) => item.verdict === 'reject')
  return {
    kind: 'audit_result',
    title: '这几条要写进记忆，你看看',
    summary_line: `这次整理出 ${prepared.length} 条 / 建议写入 ${written.length} 条 / 不写 ${skipped.length} 条`,
    items: written.map((item) => {
      const src = prepared.find((candidate) => candidate.client_key === item.client_key)
      return {
        layer: src?.layer ?? '',
        title: src?.title ?? '',
        digest: (src?.content ?? '').slice(0, 80),
        judge_reason: item.reason,
      }
    }),
    buttons: [
      { label: '按这个方案写入', resolution: 'approved' },
      { label: '这次不写', resolution: 'rejected' },
    ],
    allowed_resolutions: [],
    resolve_payload: {},
    expand_label: '为什么记这条',
  }
}
