/**
 * 记忆端口：evaluate / applyGoverned / inspectBatch 三个处理器。
 *
 * 端口自己不调裁判、也不自己写记忆正文：judge 与 writeMemory 由外部注入（见 MemoryPortDeps），
 * 本模块只负责固定图语义：找批次 → 确定性查重与冲突检查 → 调裁判 → 解析 → 落 memory_evaluations
 * → 逐条建议；受控写的计数落库；以及 inspect_batch 的证据口径。
 */

import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { OrchError, toOrchError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import { contentHash, proposalHash, resolveTargetConflicts, type MemoryItemInput } from '../../core/memory-canonical.ts'
import {
  assertEvalShape,
  buildEvaluateRequest,
  parseJudgeResponse,
  type EvalItem,
  type EvalRecommendation,
  type EvalRequest,
  type EvalRequestPolicy,
  type EvalRequestSource,
} from '../../core/memory-eval.ts'
import { inTx } from '../../infra/db/tx.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'

/** 裁判回调：返回裁判原始文本，由 parseJudgeResponse 解析。 */
export type MemoryJudge = (request: EvalRequest) => Promise<string>

/** 受控写回调的入参：只给已批准的条目。 */
export type GovernedWriteInput = {
  batch_id: string
  run_id: string
  node_run_id: string
  items: readonly MemoryItemInput[]
}

/** 受控写回调逐条回执。 */
export type GovernedWriteApplied = {
  client_key: string
  item_id: string
}

/** 受控写回调的返回值：applied_count / skipped_count / applied_item_ids。 */
export type GovernedWriteResult = {
  applied_count: number
  skipped_count: number
  applied_item_ids: string[]
  /** 可选：逐条对应关系；缺省按已批准条目的顺序对齐 applied_item_ids。 */
  applied?: GovernedWriteApplied[]
}

/** 受控写实现（真实写库由外部注入）。 */
export type MemoryWriteGoverned = (input: GovernedWriteInput) => Promise<GovernedWriteResult | { outcome: 'not_written' }>

/** 端口依赖。 */
export type MemoryPortDeps = {
  db: Db
  /** 裁判：返回原始文本。 */
  judge: MemoryJudge
  /** 受控写：真正写记忆正文。 */
  writeMemory: MemoryWriteGoverned
  /** 评估开关：返回 false 时端口以 MEMORY_EVAL_DISABLED 收口。 */
  evalEnabled?: () => boolean
  /** 裁判超时阈值（毫秒）；缺省不额外计时，由 judge 自己抛超时。 */
  judgeTimeoutMs?: number
}

export type EvaluatePortInput = {
  batch_id: string
  prepare_node_run_id: string
  source: EvalRequestSource
  policy?: Partial<EvalRequestPolicy>
  now?: string
}

export type EvaluatePortResult = {
  batch_id: string
  evaluation_id: string
  eval_attempt: number
  recommendation: EvalRecommendation
  items: EvalItem[]
  truncated: boolean
  duration_ms: number
  request_hash: string
}

export type ApplyGovernedPortInput = {
  decision_id: string
  batch_id: string
  run_id: string
  node_run_id: string
  now?: string
}

export type ApplyGovernedPortResult = {
  batch_id: string
  applied_count: number
  skipped_count: number
  applied_item_ids: string[]
  already_applied: boolean
}

export type InspectBatchPortInput = {
  batch_id: string
}

export type InspectBatchItem = {
  item_id: string
  client_key: string
  status: string
  applied_item_id: string | null
}

export type InspectBatchPortResult = {
  batch_id: string
  batch_status: string
  items: InspectBatchItem[]
  written_count: number
  missing_count: number
  partial: boolean
  evidence_id: string
}

/** 三个端口的集合类型。 */
export type MemoryPorts = {
  evaluate: (input: EvaluatePortInput) => Promise<EvaluatePortResult>
  applyGoverned: (input: ApplyGovernedPortInput) => Promise<ApplyGovernedPortResult>
  inspectBatch: (input: InspectBatchPortInput) => InspectBatchPortResult
}

export type MemoryBatchRow = {
  batch_id: string
  task_id: string
  source_run_id: string
  memory_run_id: string
  prepare_node_run_id: string | null
  confirm_node_run_id: string | null
  apply_node_run_id: string | null
  attempt: number
  status: string
  outcome: string | null
  proposal_hash: string | null
  approved_proposal_hash: string | null
  approved_item_hashes_json: string | null
  evaluation_id: string | null
  decision_id: string | null
  applied_count: number
  skipped_count: number
  error_code: string | null
  error_message: string | null
}

type ItemRow = {
  item_id: string
  batch_id: string
  client_key: string
  action: 'create' | 'update'
  target_id: string | null
  layer: 'L2' | 'L4' | 'L5' | 'L6'
  title: string
  content: string
  tags_json: string | null
  questions_json: string | null
  key: string | null
  importance: number | null
  ttl_days: number | null
  quote: string | null
  reason: string | null
  content_hash: string
  approved_content_hash: string | null
  status: string
  verdict: string | null
  confidence: number | null
  judge_reason: string | null
  applied_item_id: string | null
}

const TERMINAL_BATCH_STATUSES = ['applied', 'empty', 'blocked', 'declined', 'expired', 'failed', 'indeterminate']
const EVALUABLE_BATCH_STATUSES = ['draft', 'evaluating', 'awaiting_human']
/** 端口级失败口径：这些错会让批次 failed。 */
const FAILING_EVAL_CODES = [
  'MEMORY_EVAL_TIMEOUT',
  'MEMORY_EVAL_UNAVAILABLE',
  'MEMORY_EVAL_DISABLED',
  'MEMORY_EVAL_INVALID_OUTPUT',
  'MEMORY_BATCH_CONFLICT',
]

function loadBatch(db: Db, batch_id: string): MemoryBatchRow | undefined {
  const row = db.raw
    .prepare(
      'SELECT batch_id, task_id, source_run_id, memory_run_id, prepare_node_run_id, confirm_node_run_id,' +
        ' apply_node_run_id, attempt, status, outcome, proposal_hash, approved_proposal_hash,' +
        ' approved_item_hashes_json, evaluation_id, decision_id, applied_count, skipped_count, error_code,' +
        ' error_message FROM memory_batches WHERE batch_id = ?',
    )
    .get(batch_id)
  return row === undefined ? undefined : (row as unknown as MemoryBatchRow)
}

function loadItems(db: Db, batch_id: string): ItemRow[] {
  const rows = db.raw
    .prepare(
      'SELECT item_id, batch_id, client_key, action, target_id, layer, title, content, tags_json, questions_json,' +
        ' key, importance, ttl_days, quote, reason, content_hash, approved_content_hash, status, verdict,' +
        ' confidence, judge_reason, applied_item_id FROM memory_items WHERE batch_id = ? ORDER BY client_key',
    )
    .all(batch_id)
  return rows as unknown as ItemRow[]
}

function parseJsonArray(text: string | null): string[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function toMemoryItemInput(row: ItemRow): MemoryItemInput {
  return {
    client_key: row.client_key,
    action: row.action,
    target_id: row.target_id,
    layer: row.layer,
    title: row.title,
    content: row.content,
    tags: parseJsonArray(row.tags_json),
    questions: parseJsonArray(row.questions_json),
    key: row.key,
    importance: row.importance,
    ttl_days: row.ttl_days,
    quote: row.quote ?? '',
    reason: row.reason ?? '',
  }
}

function emptyEvalResult(): { recommendation: EvalRecommendation; items: EvalItem[]; truncated: boolean; model: { provider: string; name: string; prompt_version: string }; summary: string; duration_ms: number } {
  return {
    recommendation: 'empty',
    items: [],
    truncated: false,
    model: { provider: '', name: '', prompt_version: '' },
    summary: '没有待评估条目',
    duration_ms: 0,
  }
}

/** 裁判错误 → 三种可区分的失败口径。 */
function judgeFailure(err: unknown): OrchError {
  if (err instanceof OrchError) {
    if (err.code === 'MEMORY_EVAL_TIMEOUT' || err.code === 'MEMORY_EVAL_UNAVAILABLE' || err.code === 'MEMORY_EVAL_DISABLED') {
      return err
    }
    return new OrchError('MEMORY_EVAL_UNAVAILABLE', '裁判端口不可用', { message: err.message })
  }
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|ETIMEDOUT/i.test(message)) {
    return new OrchError('MEMORY_EVAL_TIMEOUT', '裁判端口超时', { message })
  }
  return new OrchError('MEMORY_EVAL_UNAVAILABLE', '裁判端口不可用', { message })
}

async function callJudge(deps: MemoryPortDeps, request: EvalRequest): Promise<string> {
  let raw: string
  try {
    raw = await deps.judge(request)
  } catch (err) {
    throw judgeFailure(err)
  }
  if (typeof raw !== 'string') {
    throw new OrchError('MEMORY_EVAL_INVALID_OUTPUT', '裁判返回的不是文本', {})
  }
  return raw
}

/**
 * 确定性查重与冲突检查：
 * - update 动作同 target_id 只留一条；内容不同 → MEMORY_BATCH_CONFLICT，内容相同 → 重复条目跳过。
 * - create 动作同 content_hash 视为重复，只留一条。
 */
function dedupeItems(rows: readonly ItemRow[], batch_id: string): { kept: ItemRow[]; duplicates: ItemRow[] } {
  const sorted = [...rows].sort((a, b) => (a.client_key < b.client_key ? -1 : a.client_key > b.client_key ? 1 : 0))
  const kept: ItemRow[] = []
  const duplicates: ItemRow[] = []
  const seen = new Map<string, ItemRow>()
  for (const row of sorted) {
    const identity = row.action === 'update' ? `target:${row.target_id ?? ''}` : `content:${row.content_hash}`
    const prev = seen.get(identity)
    if (!prev) {
      seen.set(identity, row)
      kept.push(row)
      continue
    }
    const previous = toMemoryItemInput(prev)
    const current = toMemoryItemInput(row)
    if (row.action === 'update') resolveTargetConflicts([previous, current])
    if (row.action === 'create' && contentHash({ ...previous, client_key: current.client_key }) !== contentHash(current)) {
      throw new OrchError('MEMORY_BATCH_CONFLICT', '同一目标的记忆内容冲突', {
        batch_id,
        client_key: row.client_key,
        conflict_with: prev.client_key,
      })
    }
    duplicates.push(row)
  }
  return { kept, duplicates }
}

/** 批次失败收口：批次 failed + 剩余 proposed 全部 skipped。没有活跃审批卡时才动批次。 */
function failBatch(deps: MemoryPortDeps, batch_id: string, code: string, message: string, now: string): void {
  inTx(deps.db, (tx: Tx) => {
    const active = tx.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM decisions WHERE run_id = (SELECT memory_run_id FROM memory_batches WHERE batch_id = ?)" +
        " AND kind = 'audit_result' AND status IN ('pending','acknowledged','blocked_for_human')",
      [batch_id],
    )
    if ((active?.n ?? 0) > 0) return
    tx.run(
      "UPDATE memory_batches SET status = 'failed', outcome = 'failed', error_code = ?, error_message = ?, updated_at = ?" +
        ' WHERE batch_id = ? AND status NOT IN (' +
        TERMINAL_BATCH_STATUSES.map(() => '?').join(',') +
        ')',
      [code, message, now, batch_id, ...TERMINAL_BATCH_STATUSES],
    )
    tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [batch_id])
  })
}

/**
 * evaluate 端口：按 batch_id + prepare_node_run_id 找批次，做确定性查重与冲突检查，
 * 调裁判，解析后写 memory_evaluations，逐条建议返回。
 */
export async function evaluateMemoryBatch(deps: MemoryPortDeps, input: EvaluatePortInput): Promise<EvaluatePortResult> {
  const now = input.now ?? new Date().toISOString()
  const batch = loadBatch(deps.db, input.batch_id)
  if (!batch) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次不存在', { batch_id: input.batch_id })
  }
  if (batch.prepare_node_run_id !== input.prepare_node_run_id) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '批次不属于该准备节点', {
      batch_id: input.batch_id,
      prepare_node_run_id: input.prepare_node_run_id,
    })
  }
  if (!EVALUABLE_BATCH_STATUSES.includes(batch.status)) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '批次当前状态不能再评估', {
      batch_id: input.batch_id,
      status: batch.status,
    })
  }
  try {
    if (deps.evalEnabled && !deps.evalEnabled()) {
      throw new OrchError('MEMORY_EVAL_DISABLED', '记忆评估端口已关闭', { batch_id: input.batch_id })
    }
    const proposed = loadItems(deps.db, input.batch_id).filter((row) => row.status === 'proposed')
    const { kept, duplicates } = dedupeItems(proposed, input.batch_id)
    const candidates = kept.map((row) => ({ ...toMemoryItemInput(row), content_hash: row.content_hash }))
    const built = buildEvaluateRequest({
      batch_id: input.batch_id,
      prepare_node_run_id: input.prepare_node_run_id,
      source: input.source,
      policy: input.policy,
      items: candidates,
    })
    const result =
      candidates.length === 0 ? emptyEvalResult() : parseJudgeResponse(await callJudge(deps, built.request))
    assertEvalShape(result.items, built.truncated || result.truncated)

    const responseJson = JSON.stringify(result)
    if (Buffer.byteLength(responseJson, 'utf8') > 64 * 1024) {
      throw new OrchError('MEMORY_EVAL_INVALID_OUTPUT', '裁判响应超过 64KiB', { batch_id: input.batch_id })
    }
    const requestHash = sha256Hex(canonicalJson(built.request))
    const evaluationId = `meval_${uuidv7().replace(/-/g, '')}`
    const attemptRow = deps.db.raw
      .prepare('SELECT COALESCE(MAX(eval_attempt), 0) AS n FROM memory_evaluations WHERE batch_id = ?')
      .get(input.batch_id)
    const evalAttempt = ((attemptRow as unknown as { n: number } | undefined)?.n ?? 0) + 1

    inTx(deps.db, (tx: Tx) => {
      tx.run(
        'INSERT INTO memory_evaluations (evaluation_id, batch_id, eval_attempt, request_hash, model_provider,' +
          ' model_name, prompt_version, response_json, recommendation, duration_ms, error_code, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
        [
          evaluationId,
          input.batch_id,
          evalAttempt,
          requestHash,
          result.model.provider,
          result.model.name,
          result.model.prompt_version,
          responseJson,
          result.recommendation,
          result.duration_ms,
          now,
        ],
      )
      for (const item of result.items) {
        tx.run(
          "UPDATE memory_items SET verdict = ?, confidence = ?, judge_reason = ? WHERE batch_id = ? AND client_key = ?" +
            " AND status = 'proposed'",
          [item.verdict, item.confidence, item.reason, input.batch_id, item.client_key],
        )
      }
      for (const duplicate of duplicates) {
        tx.run("UPDATE memory_items SET status = 'skipped' WHERE item_id = ? AND status = 'proposed'", [duplicate.item_id])
      }
      if (result.recommendation === 'ready') {
        tx.run(
          "UPDATE memory_batches SET status = 'awaiting_human', outcome = NULL, evaluation_id = ?, updated_at = ?" +
            " WHERE batch_id = ? AND status IN ('draft','evaluating','awaiting_human')",
          [evaluationId, now, input.batch_id],
        )
      } else {
        const terminalStatus = result.recommendation === 'empty' ? 'empty' : 'blocked'
        const outcome = result.recommendation === 'empty' ? 'nothing_to_write' : 'blocked'
        tx.run(
          'UPDATE memory_batches SET status = ?, outcome = ?, evaluation_id = ?, updated_at = ?' +
            " WHERE batch_id = ? AND status IN ('draft','evaluating','awaiting_human')",
          [terminalStatus, outcome, evaluationId, now, input.batch_id],
        )
        tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [input.batch_id])
      }
    })

    return {
      batch_id: input.batch_id,
      evaluation_id: evaluationId,
      eval_attempt: evalAttempt,
      recommendation: result.recommendation,
      items: result.items,
      truncated: built.truncated || result.truncated,
      duration_ms: result.duration_ms,
      request_hash: requestHash,
    }
  } catch (err) {
    const orch = toOrchError(err)
    if (FAILING_EVAL_CODES.includes(orch.code)) {
      failBatch(deps, input.batch_id, orch.code, orch.message, now)
    }
    throw orch
  }
}

/**
 * applyGoverned 端口：调注入的受控写实现，把 applied / skipped 计数与 applied_item_ids 记进结果。
 * 写入端确认回滚时收为 failed。结果未知时保留 applying，等写入端对账。
 */
export async function applyGovernedMemoryBatch(
  deps: MemoryPortDeps,
  input: ApplyGovernedPortInput,
): Promise<ApplyGovernedPortResult> {
  const now = input.now ?? new Date().toISOString()
  const claim = inTx(deps.db, (tx) => {
    const batch = loadBatch(deps.db, input.batch_id)
    if (!batch) {
      throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次不存在', { batch_id: input.batch_id })
    }
    const decision = tx.get<{ run_id: string; node_run_id: string | null; kind: string; status: string; closed_reason: string | null; expires_at: string | null; content_hash: string | null }>(
      'SELECT run_id, node_run_id, kind, status, closed_reason, expires_at, content_hash FROM decisions WHERE decision_id = ?',
      [batch.decision_id],
    )
    const replay = batch.status === 'applied'
    if (!decision || decision.status !== 'resolved' || decision.closed_reason !== 'approved'
      || (!replay && (batch.status !== 'approved' || (decision.expires_at && !(Date.parse(now) < Date.parse(decision.expires_at)))))) {
      throw new OrchError('MEMORY_BATCH_NOT_APPROVED', '批次未批准，不许受控写', {
        batch_id: input.batch_id,
        status: batch.status,
      })
    }
    const node = tx.get<{ status: string }>(
      "SELECT status FROM node_runs WHERE node_run_id = ? AND run_id = ? AND node_id = 'mem_apply'",
      [input.node_run_id, batch.memory_run_id],
    )
    if (batch.decision_id !== input.decision_id || batch.memory_run_id !== input.run_id || !node ||
      (batch.apply_node_run_id && batch.apply_node_run_id !== input.node_run_id) ||
      (!replay && node.status !== 'started')) {
      throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '写入节点不属于这张记忆批次或尚未启动')
    }
    const rows = loadItems(deps.db, input.batch_id)
    const actualProposalHash = proposalHash(rows.map(toMemoryItemInput))
    const pairs = rows.map((row) => [row.client_key, contentHash(toMemoryItemInput(row))])
    let snapshot: unknown = null
    try { snapshot = JSON.parse(batch.approved_item_hashes_json ?? 'null') } catch { /* handled by comparison */ }
    if (decision.kind !== 'audit_result' || decision.run_id !== batch.memory_run_id
      || !batch.confirm_node_run_id || decision.node_run_id !== batch.confirm_node_run_id
      || decision.content_hash !== actualProposalHash || batch.proposal_hash !== actualProposalHash
      || batch.approved_proposal_hash !== actualProposalHash
      || canonicalJson(snapshot) !== canonicalJson(pairs)
      || rows.some((row, index) => row.content_hash !== pairs[index]![1] || row.approved_content_hash !== row.content_hash
        || row.status !== (row.verdict === 'approve' || row.verdict === 'merge' ? (replay ? 'applied' : 'approved') : 'skipped'))) {
      throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '当前记忆提议与批准快照不一致')
    }
    if (replay) return null
    const approved = rows.filter((row) => row.status === 'approved')
    if (approved.length === 0) throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '批准快照没有可写入的条目')
    const res = tx.run(
      "UPDATE memory_batches SET status = 'applying', apply_node_run_id = ?, updated_at = ? WHERE batch_id = ? AND status = 'approved'",
      [input.node_run_id, now, input.batch_id],
    )
    if (res.changes !== 1) throw new OrchError('MEMORY_BATCH_NOT_APPROVED', '批次已被其他写入领取')
    return approved
  })
  if (!claim) return { batch_id: input.batch_id, applied_count: 0, skipped_count: 0, applied_item_ids: [], already_applied: true }

  let written: Awaited<ReturnType<MemoryWriteGoverned>>
  try {
    written = await deps.writeMemory({
      batch_id: input.batch_id,
      run_id: input.run_id,
      node_run_id: input.node_run_id,
      items: claim.map(toMemoryItemInput),
    })
  } catch {
    throw new OrchError('MEMORY_APPLY_FAILED', '记忆写入结果暂不可确认，需要对账')
  }
  if ('outcome' in written) {
    if (written.outcome !== 'not_written') throw new OrchError('MEMORY_APPLY_FAILED', '写入端返回了未知结果，需要对账')
    const message = '写入端确认整批未落库'
    inTx(deps.db, (tx: Tx) => {
      tx.run(
        "UPDATE memory_batches SET status = 'failed', outcome = 'failed', error_code = 'MEMORY_APPLY_FAILED'," +
          " error_message = ?, updated_at = ? WHERE batch_id = ? AND status IN ('approved','applying')",
        [message, now, input.batch_id],
      )
      tx.run("UPDATE memory_items SET status = 'failed' WHERE batch_id = ? AND status = 'approved'", [input.batch_id])
      tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [input.batch_id])
    })
    throw new OrchError('MEMORY_APPLY_FAILED', '记忆受控写失败，一条都没写', {
      batch_id: input.batch_id,
      message,
    })
  }

  const applied = written.applied ?? alignApplied(claim, written.applied_item_ids)
  const appliedIds = new Set(applied.map((item) => item.item_id))
  if (written.applied_count !== claim.length || written.skipped_count !== 0
    || applied.length !== claim.length || new Set(applied.map((item) => item.client_key)).size !== claim.length
    || written.applied_item_ids.length !== claim.length || appliedIds.size !== claim.length
    || new Set(written.applied_item_ids).size !== claim.length
    || applied.some((item) => !item.item_id || !written.applied_item_ids.includes(item.item_id)
      || !claim.some((row) => row.client_key === item.client_key))) {
    throw new OrchError('MEMORY_APPLY_FAILED', '记忆写入回执不完整，需要对账')
  }
  inTx(deps.db, (tx: Tx) => {
    for (const item of applied) {
      tx.run(
        "UPDATE memory_items SET status = 'applied', applied_item_id = ? WHERE batch_id = ? AND client_key = ? AND status = 'approved'",
        [item.item_id, input.batch_id, item.client_key],
      )
    }
    tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'approved'", [input.batch_id])
    const result = tx.run(
      "UPDATE memory_batches SET status = 'applied', outcome = 'written', applied_count = ?, skipped_count = ?," +
        " applied_at = ?, updated_at = ? WHERE batch_id = ? AND status = 'applying'",
      [written.applied_count, written.skipped_count, now, now, input.batch_id],
    )
    if (result.changes !== 1) throw new OrchError('MEMORY_APPLY_FAILED', '记忆批次状态已变，需要对账')
  })

  return {
    batch_id: input.batch_id,
    applied_count: written.applied_count,
    skipped_count: written.skipped_count,
    applied_item_ids: written.applied_item_ids,
    already_applied: false,
  }
}

function alignApplied(approved: readonly ItemRow[], appliedItemIds: readonly string[]): GovernedWriteApplied[] {
  const aligned: GovernedWriteApplied[] = []
  for (const [index, row] of approved.entries()) {
    const itemId = appliedItemIds[index]
    if (itemId === undefined) continue
    aligned.push({ client_key: row.client_key, item_id: itemId })
  }
  return aligned
}

/**
 * inspectBatch 端口：返回 batch_id、逐条 status、written_count、missing_count、partial、evidence_id。
 */
export function inspectMemoryBatch(deps: MemoryPortDeps, input: InspectBatchPortInput): InspectBatchPortResult {
  const batch = loadBatch(deps.db, input.batch_id)
  if (!batch) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次不存在', { batch_id: input.batch_id })
  }
  if (batch.status === 'applying') {
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '本地批次尚无写入回执，需要从写入端对账')
  }
  const rows = loadItems(deps.db, input.batch_id)
  const written = rows.filter((row) => row.status === 'applied')
  const missing = rows.filter((row) => row.status === 'failed')
  const evidenceId = `mev_${sha256Hex(
    canonicalJson({
      batch_id: input.batch_id,
      items: rows.map((row) => ({ client_key: row.client_key, status: row.status })),
    }),
  ).slice(0, 32)}`
  return {
    batch_id: input.batch_id,
    batch_status: batch.status,
    items: rows.map((row) => ({
      item_id: row.item_id,
      client_key: row.client_key,
      status: row.status,
      applied_item_id: row.applied_item_id,
    })),
    written_count: written.length,
    missing_count: missing.length,
    partial: written.length > 0 && missing.length > 0,
    evidence_id: evidenceId,
  }
}

/** 端口集合工厂。 */
export function createMemoryPorts(deps: MemoryPortDeps): MemoryPorts {
  return {
    evaluate: (input) => evaluateMemoryBatch(deps, input),
    applyGoverned: (input) => applyGovernedMemoryBatch(deps, input),
    inspectBatch: (input) => inspectMemoryBatch(deps, input),
  }
}

/** 供 runtime 用：把条目行的 content_hash 补齐（canonical 口径）。 */
export function itemContentHash(item: MemoryItemInput): string {
  return contentHash(item)
}
