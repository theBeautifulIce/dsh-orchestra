// src/service/commands/memory-approval.ts —— 记忆审批卡生成与批准落库（S5-Gb，规格 §9.6）
//
// 固定图推进到 mem_confirm 时开一张 kind='audit_result' 的审批卡：
// - 同一 run + 同一 kind 已有活跃卡时复用它，返回同一个 decision_id，绝不新建第二张卡
//   （规格 §4.8 行 419 / 行 651：mem_apply 的前置批准复用 mem_confirm 的 audit_result）；
// - 人批准时在同一笔事务里写批准快照：先写 memory_items.approved_content_hash（此时批次仍 awaiting_human），
//   再把批次 UPDATE 成 approved（030 迁移的触发器要求这个顺序，反了会 RAISE MEMORY_APPLY_BINDING_INVALID）；
// - 人拒绝 → 批次 declined；审批卡 24 小时过期 → 批次 expired；两条路都不碰 apply。
import { OrchError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import { proposalHash, type MemoryItemInput } from '../../core/memory-canonical.ts'
import type { ApprovalCard } from '../../core/memory-eval.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import type { Actor } from '../decision/approver.ts'
import { activeDecision, cancelDecision, openDecision, resolveMemoryApprovalDecision } from './decisions.ts'

/** 审批卡类型：与固定图 mem_confirm 节点的 approval_kind 一致。 */
export const MEMORY_APPROVAL_KIND = 'audit_result'

/** 审批有效期：24 小时未确认即过期，不自动放行（规格 §9.6）。 */
export const MEMORY_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/** 还能开卡的批次状态。 */
const OPENABLE_BATCH_STATUSES = ['draft', 'evaluating', 'awaiting_human']

/** 决策卡的三种活跃态（与 decisions.ts 的 ACTIVE_STATUSES 一致）。 */
const ACTIVE_DECISION_STATUSES = ['pending', 'acknowledged', 'blocked_for_human']

type BatchRow = {
  batch_id: string
  status: string
  proposal_hash: string | null
  decision_id: string | null
  confirm_node_run_id: string | null
  evaluation_id: string | null
  memory_run_id: string | null
}

type ItemRow = {
  item_id: string
  client_key: string
  status: string
  verdict: string | null
  content_hash: string
  action: string
  target_id: string | null
  layer: string
  title: string
  content: string
  tags_json: string
  questions_json: string
  key: string | null
  importance: number | null
  ttl_days: number | null
  quote: string
  reason: string
}

type DecisionRow = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  revision: number
  closed_reason: string | null
  payload_json: string
  content_hash: string | null
  expires_at: string | null
}

export type MemoryApprovalOpenInput = {
  /** 记忆运行 id（memory_batches.memory_run_id）。 */
  run_id: string
  /** 开卡节点的 node_run_id（通常是 mem_confirm）。 */
  node_run_id: string
  batch_id: string
  /** 卡片文案：只由 recommendation=ready 的评估结果生成。 */
  card: ApprovalCard
  now: string
  evaluation_id?: string | null
  /** 可选：调用方自带 decision_id。 */
  decision_id?: string
}

export type MemoryApprovalOpenResult = {
  decision_id: string
  batch_id: string
  /** true = 复用了既有卡（同一 decision_id），false = 本次新开的卡。 */
  reused: boolean
  card: ApprovalCard
}

export type MemoryApprovalResolveInput = {
  batch_id: string
  decision_id: string
  /** approved = 按方案写入；rejected = 一条不写。 */
  resolution: 'approved' | 'rejected'
  now: string
  /** 批准人：普通 Agent 不能批这张卡（卡上 approver='human'）。 */
  actor: Actor
  /** 乐观锁用的卡版本号；不给就用当前版本。 */
  revision?: number
  evidenceProducers?: readonly string[]
  confirm?: boolean
  contentHash?: string | null
}

export type MemoryApprovalResolveResult = {
  decision_id: string
  batch_id: string
  batch_status: string
  decision_status: string
  closed_reason: string | null
  approved_count: number
  skipped_count: number
  /** 批准快照：[client_key, content_hash] 对。 */
  item_hashes: Array<[string, string]>
}

export type MemoryApprovalExpireInput = {
  batch_id: string
  decision_id: string
  now: string
}

export type MemoryApprovalExpireResult = {
  expired: boolean
  decision_id: string
  batch_id: string
  batch_status: string
  decision_status: string
  closed_reason: string | null
}

/**
 * 开卡：同一 run + 同一 kind 已有活跃卡就复用它（同一 decision_id），不新建第二张卡。
 * 批次上已经绑过卡时也复用那张卡——mem_apply 的前置批准走的就是这条路。
 */
export function openMemoryApprovalCard(tx: Tx, input: MemoryApprovalOpenInput): MemoryApprovalOpenResult {
  const batch = loadBatch(tx, input.batch_id)
  if (!OPENABLE_BATCH_STATUSES.includes(batch.status)) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆已经收口，不能再开审批卡', {
      batch_id: batch.batch_id,
      status: batch.status,
    })
  }
  if (batch.memory_run_id && batch.memory_run_id !== input.run_id) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆不属于这次记忆运行', {
      batch_id: batch.batch_id,
      memory_run_id: batch.memory_run_id,
      run_id: input.run_id,
    })
  }
  if (!batch.proposal_hash) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆还没有提议，不能开审批卡', {
      batch_id: batch.batch_id,
    })
  }
  const expiry = new Date(Date.parse(input.now) + MEMORY_APPROVAL_TTL_MS).toISOString()

  // 一、批次已经绑过卡：复用那张卡（mem_apply 的前置批准也走这里，同一 decision_id，不新建第二张卡）。
  if (batch.decision_id) {
    const bound = loadDecision(tx, batch.decision_id)
    if (bound && ACTIVE_DECISION_STATUSES.includes(bound.status)) {
      bindBatch(tx, batch.batch_id, input.node_run_id, bound.decision_id, input.now)
      return {
        decision_id: bound.decision_id,
        batch_id: batch.batch_id,
        reused: true,
        card: input.card,
      }
    }
    // 已关闭的卡不复活：另开新卡，并把被复用的旧 decision_id 记进 payload 便于追溯。
    return openNewCard(tx, input, batch, expiry, bound?.decision_id ?? batch.decision_id)
  }

  // 二、同 run 同 kind 已有活跃卡：复用它，返回同一个 decision_id。
  const active = activeDecision(tx, input.run_id, MEMORY_APPROVAL_KIND, input.node_run_id)
    ?? activeRunDecision(tx, input.run_id)
  if (active) {
    const existing = loadDecision(tx, active.decision_id)
    if (existing) {
      const payload = parsePayload(existing.payload_json)
      const boundBatch = typeof payload.batch_id === 'string' ? payload.batch_id : null
      if (boundBatch && boundBatch !== batch.batch_id) {
        throw new OrchError('MEMORY_BATCH_CONFLICT', '这次记忆运行已经有别的批次在等审批', {
          batch_id: batch.batch_id,
          decision_id: existing.decision_id,
          active_batch_id: boundBatch,
        })
      }
      bindBatch(tx, batch.batch_id, input.node_run_id, existing.decision_id, input.now)
      return {
        decision_id: existing.decision_id,
        batch_id: batch.batch_id,
        reused: true,
        card: input.card,
      }
    }
  }

  // 三、没有可复用的卡：新开一张。
  return openNewCard(tx, input, batch, expiry, null)
}

/**
 * 收口：人批准 → 同一笔事务里写批准快照；人拒绝 → 批次 declined（不写快照，不碰 apply）。
 * 批准的写入顺序由 030 迁移的触发器决定：先写条目快照，再把批次 UPDATE 成 approved。
 */
export function resolveMemoryApproval(
  tx: Tx,
  secret: string,
  input: MemoryApprovalResolveInput,
): MemoryApprovalResolveResult {
  const batch = loadBatch(tx, input.batch_id)
  if (batch.decision_id !== input.decision_id) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这张审批卡不是这批记忆的审批卡', {
      batch_id: batch.batch_id,
      decision_id: input.decision_id,
      batch_decision_id: batch.decision_id,
    })
  }
  if (batch.status !== 'awaiting_human') {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆不在等待人批的状态', {
      batch_id: batch.batch_id,
      status: batch.status,
    })
  }
  const decision = loadDecision(tx, input.decision_id)
  if (!decision) {
    throw new OrchError('NOT_FOUND', '找不到这张审批卡', { decision_id: input.decision_id })
  }
  if (decision.kind !== MEMORY_APPROVAL_KIND) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这张卡不是记忆审批卡', {
      decision_id: decision.decision_id,
      kind: decision.kind,
    })
  }
  const payload = parsePayload(decision.payload_json)
  if (typeof payload.batch_id === 'string' && payload.batch_id !== batch.batch_id) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这张审批卡不是这批记忆的审批卡', {
      batch_id: batch.batch_id,
      card_batch_id: payload.batch_id,
    })
  }
  // 内容绑定：卡片批的是开卡那一刻的提案；内容变了就不放行。
  if (decision.content_hash && batch.proposal_hash && decision.content_hash !== batch.proposal_hash) {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '审批期间记忆提议变了，不能再批准', {
      batch_id: batch.batch_id,
      decision_id: decision.decision_id,
    })
  }
  // 过期不放行：过期走 expireMemoryApproval，批次落 expired。
  if (decision.expires_at && Date.parse(input.now) >= Date.parse(decision.expires_at)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张审批卡已经过期，不能再批准', {
      decision_id: decision.decision_id,
      expires_at: decision.expires_at,
    })
  }

  const rows = loadItems(tx, batch.batch_id)
  if (rows.length === 0) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆没有条目，不能批准', {
      batch_id: batch.batch_id,
    })
  }
  // 提案哈希必须跟落库时一致：审批的是这份提议，不是别的。
  const currentProposalHash = proposalHash(rows.map(toItemInput))
  if (batch.proposal_hash && currentProposalHash !== batch.proposal_hash) {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '这批记忆的内容跟批准时对不上', {
      batch_id: batch.batch_id,
      proposal_hash: batch.proposal_hash,
      current_proposal_hash: currentProposalHash,
    })
  }

  const pairs: Array<[string, string]> = rows
    .map((row) => [row.client_key, row.content_hash] as [string, string])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))

  const resolution = resolveMemoryApprovalDecision(tx, secret, {
    decisionId: input.decision_id,
    revision: input.revision ?? decision.revision,
    resolution: input.resolution,
    now: input.now,
    actor: input.actor,
    evidenceProducers: input.evidenceProducers,
    confirm: input.confirm,
    contentHash: input.contentHash ?? decision.content_hash,
    payload: {
      resolution: input.resolution,
      resolved_at: input.now,
      batch_id: batch.batch_id,
      ...(input.resolution === 'approved'
        ? { approved_item_hashes: pairs, proposal_hash: currentProposalHash }
        : {}),
    },
  })

  if (input.resolution === 'approved') {
    landApproval(tx, batch, rows, pairs, currentProposalHash, input)
  } else {
    landDecline(tx, batch, input)
  }

  const after = loadBatch(tx, batch.batch_id)
  return {
    decision_id: input.decision_id,
    batch_id: batch.batch_id,
    batch_status: after.status,
    decision_status: resolution.status,
    closed_reason: resolution.closedReason,
    approved_count: rows.filter((row) => row.status === 'proposed' && isWritten(row.verdict)).length,
    skipped_count: rows.filter((row) => row.status === 'proposed' && !isWritten(row.verdict)).length,
    item_hashes: pairs,
  }
}

/**
 * 过期：审批卡 24 小时未确认 → 批次 expired（不写快照，不碰 apply）。
 */
export function expireMemoryApproval(
  tx: Tx,
  secret: string,
  input: MemoryApprovalExpireInput,
): MemoryApprovalExpireResult {
  const batch = loadBatch(tx, input.batch_id)
  const decision = loadDecision(tx, input.decision_id)
  if (!decision) {
    throw new OrchError('NOT_FOUND', '找不到这张审批卡', { decision_id: input.decision_id })
  }
  const alreadyApproved = decision.status === 'resolved' && decision.closed_reason === 'approved'
  if (alreadyApproved) {
    return {
      expired: false,
      decision_id: decision.decision_id,
      batch_id: batch.batch_id,
      batch_status: batch.status,
      decision_status: decision.status,
      closed_reason: decision.closed_reason,
    }
  }
  const due = !decision.expires_at || Date.parse(input.now) >= Date.parse(decision.expires_at)
  if (!due) {
    return {
      expired: false,
      decision_id: decision.decision_id,
      batch_id: batch.batch_id,
      batch_status: batch.status,
      decision_status: decision.status,
      closed_reason: decision.closed_reason,
    }
  }
  // 关卡：活跃卡按 expired_final 收口；已经关掉的（例如被清扫关成 expired_final）不动。
  cancelDecision(tx, secret, { decisionId: input.decision_id, now: input.now, reason: 'expired_final' })
  tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [batch.batch_id])
  const res = tx.run(
    "UPDATE memory_batches SET status = 'expired', outcome = 'expired', decided_at = ?, updated_at = ?, error_code = ?, error_message = ? "
      + "WHERE batch_id = ? AND status IN ('draft','evaluating','awaiting_human')",
    [input.now, input.now, 'DECISION_EXPIRED', '审批卡 24 小时未确认，批次过期', batch.batch_id],
  )
  const after = loadBatch(tx, batch.batch_id)
  const afterDecision = loadDecision(tx, input.decision_id)
  return {
    expired: res.changes === 1,
    decision_id: input.decision_id,
    batch_id: batch.batch_id,
    batch_status: after.status,
    decision_status: afterDecision?.status ?? decision.status,
    closed_reason: afterDecision?.closed_reason ?? decision.closed_reason,
  }
}

// ------------------------------------------------------------------ 内部实现

function openNewCard(
  tx: Tx,
  input: MemoryApprovalOpenInput,
  batch: BatchRow,
  expiry: string,
  reusedFromDecisionId: string | null,
): MemoryApprovalOpenResult {
  const decisionId = input.decision_id ?? 'dec_' + uuidv7()
  const payload: Record<string, unknown> = {
    ...input.card,
    batch_id: batch.batch_id,
    evaluation_id: input.evaluation_id ?? batch.evaluation_id ?? null,
    proposal_hash: batch.proposal_hash ?? null,
    node_id: 'mem_confirm',
    node_type: 'approval',
  }
  if (reusedFromDecisionId) payload.reused_from_decision_id = reusedFromDecisionId
  openDecision(tx, {
    decisionId,
    runId: input.run_id,
    nodeRunId: input.node_run_id,
    kind: MEMORY_APPROVAL_KIND,
    payload,
    createdAt: input.now,
    contentHash: batch.proposal_hash,
    expiresAt: expiry,
    // 只能人批：普通 Agent 不许开也不许批这张卡（沿用既有 approver 档位，不新增能力体系）。
    approver: 'human',
  })
  bindBatch(tx, batch.batch_id, input.node_run_id, decisionId, input.now)
  return {
    decision_id: decisionId,
    batch_id: batch.batch_id,
    reused: false,
    card: input.card,
  }
}

/**
 * 批准落库：顺序不能反。
 * 1) 先写 memory_items.approved_content_hash（批次仍是 awaiting_human，触发器不拦）；
 * 2) 再把批次 UPDATE 成 approved（触发器要求 OLD.status='awaiting_human' 且 OLD 快照为空）。
 */
function landApproval(
  tx: Tx,
  batch: BatchRow,
  rows: ItemRow[],
  pairs: Array<[string, string]>,
  currentProposalHash: string,
  input: MemoryApprovalResolveInput,
): void {
  for (const row of rows) {
    const next = row.status === 'proposed' ? (isWritten(row.verdict) ? 'approved' : 'skipped') : row.status
    tx.run(
      "UPDATE memory_items SET status = ?, approved_content_hash = content_hash WHERE item_id = ? AND status IN ('proposed','skipped')",
      [next, row.item_id],
    )
  }
  const res = tx.run(
    "UPDATE memory_batches SET status = 'approved', approved_proposal_hash = ?, approved_item_hashes_json = ?, "
      + "decision_id = ?, decided_at = ?, updated_at = ? WHERE batch_id = ? AND status = 'awaiting_human'",
    [currentProposalHash, JSON.stringify(pairs), input.decision_id, input.now, input.now, batch.batch_id],
  )
  if (res.changes !== 1) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆的状态已经变了', {
      batch_id: batch.batch_id,
      status: batch.status,
    })
  }
}

/** 拒绝落库：批次 declined，一条不写，也不写批准快照。 */
function landDecline(tx: Tx, batch: BatchRow, input: MemoryApprovalResolveInput): void {
  tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [batch.batch_id])
  const res = tx.run(
    "UPDATE memory_batches SET status = 'declined', outcome = 'declined', decided_at = ?, updated_at = ?, error_code = ?, error_message = ? "
      + "WHERE batch_id = ? AND status = 'awaiting_human'",
    [input.now, input.now, 'DECISION_REJECTED', '人没有批准这批记忆', batch.batch_id],
  )
  if (res.changes !== 1) {
    throw new OrchError('MEMORY_BATCH_CONFLICT', '这批记忆的状态已经变了', {
      batch_id: batch.batch_id,
      status: batch.status,
    })
  }
}

function bindBatch(tx: Tx, batchId: string, nodeRunId: string, decisionId: string, now: string): void {
  tx.run(
    "UPDATE memory_batches SET status = 'awaiting_human', confirm_node_run_id = COALESCE(confirm_node_run_id, ?), "
      + "decision_id = ?, updated_at = ? WHERE batch_id = ? AND status IN ('draft','evaluating','awaiting_human')",
    [nodeRunId, decisionId, now, batchId],
  )
}

function isWritten(verdict: string | null): boolean {
  return verdict === 'approve' || verdict === 'merge'
}

function loadBatch(tx: Tx, batchId: string): BatchRow {
  const row = tx.get<BatchRow>(
    'SELECT batch_id, status, proposal_hash, decision_id, confirm_node_run_id, evaluation_id, memory_run_id '
      + 'FROM memory_batches WHERE batch_id = ?',
    [batchId],
  )
  if (!row) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '找不到这条记忆批次', { batch_id: batchId })
  }
  return row
}

function loadDecision(tx: Tx, decisionId: string): DecisionRow | undefined {
  return tx.get<DecisionRow>(
    'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, payload_json, content_hash, expires_at '
      + 'FROM decisions WHERE decision_id = ?',
    [decisionId],
  )
}

function loadItems(tx: Tx, batchId: string): ItemRow[] {
  return tx.all<ItemRow>(
    'SELECT item_id, client_key, status, verdict, content_hash, action, target_id, layer, title, content, '
      + 'tags_json, questions_json, key, importance, ttl_days, quote, reason FROM memory_items '
      + 'WHERE batch_id = ? ORDER BY client_key',
    [batchId],
  )
}

/** 同一 run 同一 kind 的活跃卡（不限节点）：记忆运行一轮只有一张审批卡。 */
function activeRunDecision(tx: Tx, runId: string): { decision_id: string } | undefined {
  return tx.get<{ decision_id: string }>(
    "SELECT decision_id FROM decisions WHERE run_id = ? AND kind = ? "
      + "AND status IN ('pending','acknowledged','blocked_for_human') ORDER BY created_at DESC LIMIT 1",
    [runId, MEMORY_APPROVAL_KIND],
  )
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

/** 条目行回环成提议条目：canonicalItem 对已规范化的值是幂等的，回环后哈希不变。 */
function toItemInput(row: ItemRow): MemoryItemInput {
  const layer = row.layer === 'L2' || row.layer === 'L5' || row.layer === 'L6' ? row.layer : 'L4'
  return {
    client_key: row.client_key,
    action: row.action === 'create' ? 'create' : 'update',
    target_id: row.target_id,
    layer,
    title: row.title,
    content: row.content,
    tags: parseStringArray(row.tags_json),
    questions: parseStringArray(row.questions_json),
    key: row.key,
    importance: row.importance,
    ttl_days: row.ttl_days,
    quote: row.quote,
    reason: row.reason,
  }
}
