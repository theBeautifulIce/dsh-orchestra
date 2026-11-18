/**
 * 记忆 run 的运行驱动：按固定图（src/core/memory-graph-schema.ts）推进 9 个节点。
 *
 * 职责：租约（lease.ts）、节点状态迁移（nodes.ts）、事件账本（ledger.ts）、
 * 终态收口（run-close.ts）、崩溃后续跑（幂等推进）。
 * 端口（evaluate / applyGoverned / inspectBatch）由 memory-ports.ts 提供，裁判、受控写、
 * 准备产出与审批开卡都由外部注入。
 */

import { OrchError, toOrchError } from '../../core/errors.ts'
import type { MemoryItemInput } from '../../core/memory-canonical.ts'
import {
  buildApprovalCard,
  type ApprovalCard,
  type EvalItem,
  type EvalRecommendation,
  type EvalRequestSource,
} from '../../core/memory-eval.ts'
import { findMemoryNode, memoryGraphOrder } from '../../core/memory-graph-schema.ts'
import { isTerminal } from '../../core/state-machine.ts'
import { appendEvent, appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { inTx } from '../../infra/db/tx.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
import { acquireLease, releaseLease, renewLease } from './lease.ts'
import { applyBranchRoute, applyTransition, enterBlockedPre, resumeFromBlockedPre } from './nodes.ts'
import { openMemoryApprovalCard } from './memory-approval.ts'
import { advanceMemoryRun } from './memory-run.ts'
import { saveMemoryProposal } from './memory.ts'
import type { MemoryBatchRow, MemoryPorts } from './memory-ports.ts'
import { closeRun, type RunTerminal } from './run-close.ts'

/** 事件类型名集中表：节点链事件与 run 级事件都从这里取名。 */
export const MEMORY_RUNTIME_EVENTS = {
  nodeAdvanced: 'memory.node.advanced',
  nodeBlocked: 'memory.node.blocked',
  nodeFailed: 'memory.node.failed',
  runNodeAdvanced: 'memory.run.node_advanced',
  runNodeBlocked: 'memory.run.node_blocked',
  runNodeFailed: 'memory.run.node_failed',
  runClosed: 'memory.run.closed',
  /** mem_apply 复用 mem_confirm 那张卡（不新建 pre_execution 卡）。 */
  approvalReused: 'pre_execution.reused',
} as const

export type MemoryRuntimeEventType = (typeof MEMORY_RUNTIME_EVENTS)[keyof typeof MEMORY_RUNTIME_EVENTS]

/** mem_prepare 的产出由外部注入（真实实现由 lead 接线）。 */
export type PrepareItemsInput = {
  run_id: string
  batch_id: string
  task_id: string
  task_title: string
  goal: string
  result_summary: string
  evidence_refs: string[]
}

export type PrepareItems = (input: PrepareItemsInput) => Promise<{ items: unknown[] }>

/**
 * 审批卡开卡由外部注入（lead 接线到 memory-approval.ts 的 openMemoryApprovalCard）。
 * 不注入时 runtime 直接用 openMemoryApprovalCard，保证开卡与批次绑定只有一份实现。
 */
export type OpenApprovalCardInput = {
  run_id: string
  node_run_id: string
  batch_id: string
  card: ApprovalCard
  now: string
}

export type OpenApprovalCard = (input: OpenApprovalCardInput) => Promise<{ decision_id: string }>

/** 评估请求的来源：缺省从 tasks 表取标题。 */
export type MemorySourceResolver = (input: {
  run_id: string
  batch_id: string
  task_id: string
}) => Promise<EvalRequestSource> | EvalRequestSource

export type MemoryRuntimeDeps = {
  db: Db
  secret: string
  ports: MemoryPorts
  prepareItems: PrepareItems
  /** 不注入时用 memory-approval.ts 的 openMemoryApprovalCard。 */
  openApprovalCard?: OpenApprovalCard
  resolveSource?: MemorySourceResolver
  ownerEpoch?: number
  leaseTtlMs?: number
  now?: () => string
}

export type AdvanceMemoryRuntimeParams = {
  memory_run_id: string
  now?: string
  max_steps?: number
}

export type MemoryRuntimeStepStatus = 'done' | 'failed' | 'blocked_pre' | 'superseded' | 'indeterminate_side_effect'

export type MemoryRuntimeStep = {
  node_id: string
  node_run_id: string
  status: MemoryRuntimeStepStatus
  route?: string | null
  detail?: Record<string, unknown>
}

export type MemoryRuntimeResult = {
  memory_run_id: string
  batch_id: string
  status: 'completed' | 'blocked' | 'failed'
  steps: MemoryRuntimeStep[]
  terminal: RunTerminal | null
  batch_status: string
  run_status: string
  error_code?: string
}

type NodeRow = {
  node_run_id: string
  run_id: string
  node_id: string
  seq: number
  node_type: string
  attempt: number
  status: string
  revision: number
  action_generation: number
}

type DecisionRow = {
  decision_id: string
  status: string
  closed_reason: string | null
  kind: string
}

type ItemRow = {
  item_id: string
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
  status: string
  verdict: string | null
  confidence: number | null
  judge_reason: string | null
}

const BATCH_COLUMNS =
  'batch_id, task_id, source_run_id, memory_run_id, prepare_node_run_id, confirm_node_run_id, apply_node_run_id,' +
  ' attempt, status, outcome, proposal_hash, approved_proposal_hash, approved_item_hashes_json, evaluation_id,' +
  ' decision_id, applied_count, skipped_count, error_code, error_message'

function loadBatchByRun(db: Db, memoryRunId: string): MemoryBatchRow | undefined {
  const row = db.raw
    .prepare(`SELECT ${BATCH_COLUMNS} FROM memory_batches WHERE memory_run_id = ?`)
    .get(memoryRunId)
  return row === undefined ? undefined : (row as unknown as MemoryBatchRow)
}

function loadBatchById(db: Db, batchId: string): MemoryBatchRow | undefined {
  const row = db.raw.prepare(`SELECT ${BATCH_COLUMNS} FROM memory_batches WHERE batch_id = ?`).get(batchId)
  return row === undefined ? undefined : (row as unknown as MemoryBatchRow)
}

function loadNodes(db: Db, runId: string): Map<string, NodeRow> {
  const rows = db.raw
    .prepare(
      'SELECT node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation' +
        ' FROM node_runs WHERE run_id = ? ORDER BY seq',
    )
    .all(runId)
  const map = new Map<string, NodeRow>()
  for (const row of rows as unknown as NodeRow[]) map.set(row.node_id, row)
  return map
}

function loadItems(db: Db, batchId: string): ItemRow[] {
  const rows = db.raw
    .prepare(
      'SELECT item_id, client_key, action, target_id, layer, title, content, tags_json, questions_json, key,' +
        ' importance, ttl_days, quote, reason, content_hash, status, verdict, confidence, judge_reason' +
        ' FROM memory_items WHERE batch_id = ? ORDER BY client_key',
    )
    .all(batchId)
  return rows as unknown as ItemRow[]
}

/**
 * 审批卡按 batch.decision_id 查（唯一真源）：mem_confirm 与 mem_apply 共用同一张卡，
 * 不会因为节点不同而开出第二张 audit_result 卡。
 */
function loadDecision(db: Db, decisionId: string | null | undefined): DecisionRow | undefined {
  if (!decisionId) return undefined
  const row = db.raw
    .prepare(
      "SELECT decision_id, status, closed_reason, kind FROM decisions WHERE decision_id = ? AND kind = 'audit_result'",
    )
    .get(decisionId)
  return row === undefined ? undefined : (row as unknown as DecisionRow)
}

function loadLatestEvaluation(db: Db, batchId: string): { recommendation: EvalRecommendation; items: EvalItem[] } | undefined {
  const row = db.raw
    .prepare(
      'SELECT recommendation, response_json FROM memory_evaluations WHERE batch_id = ? ORDER BY eval_attempt DESC LIMIT 1',
    )
    .get(batchId)
  if (row === undefined) return undefined
  const record = row as unknown as { recommendation: EvalRecommendation; response_json: string }
  let items: EvalItem[] = []
  try {
    const parsed: unknown = JSON.parse(record.response_json)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
      items = (parsed as { items: EvalItem[] }).items
    }
  } catch {
    items = []
  }
  return { recommendation: record.recommendation, items }
}

function latestRecommendation(db: Db, batchId: string): EvalRecommendation | null {
  const row = db.raw
    .prepare('SELECT recommendation FROM memory_evaluations WHERE batch_id = ? ORDER BY eval_attempt DESC LIMIT 1')
    .get(batchId)
  if (row === undefined) return null
  const value = (row as unknown as { recommendation: EvalRecommendation | null }).recommendation
  return value ?? null
}

function runStatusOf(db: Db, runId: string): string {
  const row = db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId)
  return row === undefined ? '' : String((row as unknown as { status: string }).status)
}

/** 固定图路径：前缀到 mem_route，再按 recommendation 走分支尾链。 */
export function memoryRuntimePath(route: EvalRecommendation | null): string[] {
  const order = memoryGraphOrder()
  const branchIndex = order.indexOf('mem_route')
  const prefix = order.slice(0, branchIndex + 1)
  if (!route) return prefix
  const branch = findMemoryNode('mem_route')
  const target = branch?.routes?.find((entry) => entry.route === route)?.to
  if (!target) return prefix
  const tail: string[] = []
  let current: string | undefined = target
  while (current !== undefined) {
    tail.push(current)
    const node = findMemoryNode(current)
    if (!node || node.terminal) break
    current = node.next
  }
  return [...prefix, ...tail]
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** mem_prepare 的产出不信任执行器：形状不对就 MEMORY_PROPOSAL_INVALID。 */
export function normalizePreparedItems(raw: unknown): MemoryItemInput[] {
  if (!Array.isArray(raw)) {
    throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出不是数组', {})
  }
  if (raw.length > 20) {
    throw new OrchError('MEMORY_BATCH_TOO_LARGE', '准备输出超过 20 条', { count: raw.length })
  }
  const items: MemoryItemInput[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出条目不是对象', {})
    }
    const record = entry as Record<string, unknown>
    const clientKey = record['client_key']
    if (typeof clientKey !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(clientKey)) {
      throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出条目 client_key 非法', { client_key: String(clientKey) })
    }
    const action = record['action']
    if (action !== 'create' && action !== 'update') {
      throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出条目 action 非法', { client_key: clientKey })
    }
    const layer = record['layer']
    if (layer !== 'L2' && layer !== 'L4' && layer !== 'L5' && layer !== 'L6') {
      throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出条目 layer 非法', { client_key: clientKey })
    }
    const title = record['title']
    const content = record['content']
    if (typeof title !== 'string' || typeof content !== 'string') {
      throw new OrchError('MEMORY_PROPOSAL_INVALID', '准备输出条目标题或正文不是字符串', { client_key: clientKey })
    }
    const targetId = record['target_id']
    const importance = record['importance']
    const ttlDays = record['ttl_days']
    const key = record['key']
    const quote = record['quote']
    const reason = record['reason']
    items.push({
      client_key: clientKey,
      action,
      target_id: typeof targetId === 'string' && targetId.length > 0 ? targetId : null,
      layer,
      title,
      content,
      tags: stringArray(record['tags']),
      questions: stringArray(record['questions']),
      key: typeof key === 'string' && key.length > 0 ? key : null,
      importance: typeof importance === 'number' ? importance : null,
      ttl_days: typeof ttlDays === 'number' ? ttlDays : null,
      quote: typeof quote === 'string' ? quote : '',
      reason: typeof reason === 'string' ? reason : '',
    })
  }
  return items
}

async function resolveSourceOf(deps: MemoryRuntimeDeps, batch: MemoryBatchRow): Promise<EvalRequestSource> {
  if (deps.resolveSource) {
    return await deps.resolveSource({
      run_id: batch.source_run_id,
      batch_id: batch.batch_id,
      task_id: batch.task_id,
    })
  }
  const row = deps.db.raw.prepare('SELECT title FROM tasks WHERE task_id = ?').get(batch.task_id)
  const title = row === undefined ? '' : String((row as unknown as { title: string }).title)
  return {
    run_id: batch.source_run_id,
    task_title: title,
    goal: title,
    result_summary: '',
    evidence_refs: [],
  }
}

type NodeOutcome = {
  status: 'done' | 'failed' | 'blocked_pre' | 'indeterminate_side_effect'
  step: MemoryRuntimeStep
  error_code?: string
}

/**
 * 推进记忆 run：按固定图推进当前节点，直到路径跑完、失败或等人裁决。
 */
export async function advanceMemoryRuntime(
  deps: MemoryRuntimeDeps,
  params: AdvanceMemoryRuntimeParams,
): Promise<MemoryRuntimeResult> {
  const now = params.now ?? deps.now?.() ?? new Date().toISOString()
  const maxSteps = params.max_steps ?? 12
  const steps: MemoryRuntimeStep[] = []
  const batch = loadBatchByRun(deps.db, params.memory_run_id)
  if (!batch) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次不存在', { memory_run_id: params.memory_run_id })
  }

  for (let index = 0; index < maxSteps; index += 1) {
    const nodes = loadNodes(deps.db, params.memory_run_id)
    const route = latestRecommendation(deps.db, batch.batch_id)
    const path = memoryRuntimePath(route)
    const failed = path
      .map((nodeId) => nodes.get(nodeId))
      .find((node) => node !== undefined && node.status === 'failed')
    if (failed) {
      return finishFailed(deps, batch, failed, nodes, steps, now)
    }
    const current = path
      .map((nodeId) => nodes.get(nodeId))
      .find((node) => node !== undefined && !isTerminal(node.status))
    if (!current) {
      return finishCompleted(deps, batch, steps, now)
    }
    if (current.status === 'indeterminate_side_effect' ||
      (current.node_id === 'mem_apply' && loadBatchById(deps.db, batch.batch_id)?.status === 'applying')) {
      return blockedResult(deps, batch, steps)
    }
    const outcome = await runNode(deps, batch, current, now)
    steps.push(outcome.step)
    if (outcome.status === 'failed') {
      return finishFailed(deps, batch, current, nodes, steps, now, outcome.error_code)
    }
    if (outcome.status === 'blocked_pre' || outcome.status === 'indeterminate_side_effect') return blockedResult(deps, batch, steps)
    // 路由还没定（还没有评估结论）时不能把分支节点当旁路收掉，等评估出结论再定路径。
    if (route !== null) {
      supersedeOffPath(deps, nodes, path, now)
    }
  }
  throw new OrchError('STALE_GENERATION', '记忆 run 推进超过步数上限', {
    memory_run_id: params.memory_run_id,
    max_steps: maxSteps,
  })
}

function blockedResult(deps: MemoryRuntimeDeps, batch: MemoryBatchRow, steps: MemoryRuntimeStep[]): MemoryRuntimeResult {
  return {
    memory_run_id: batch.memory_run_id,
    batch_id: batch.batch_id,
    status: 'blocked',
    steps,
    terminal: null,
    batch_status: loadBatchById(deps.db, batch.batch_id)?.status ?? batch.status,
    run_status: runStatusOf(deps.db, batch.memory_run_id),
  }
}

async function runNode(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  now: string,
): Promise<NodeOutcome> {
  switch (node.node_id) {
    case 'mem_trigger':
      return runWorkNode(deps, batch, node, now, 'pure', async () => ({ node_id: node.node_id }))
    case 'mem_prepare':
      return runWorkNode(deps, batch, node, now, 'pure', () => prepareWork(deps, batch, now))
    case 'mem_check':
      return runWorkNode(deps, batch, node, now, 'pure', () => checkWork(deps, batch, now))
    case 'mem_route':
      return runWorkNode(deps, batch, node, now, 'pure', () => routeWork(deps, batch, node, now))
    case 'mem_confirm':
      return runApprovalNode(deps, batch, node, now)
    case 'mem_apply':
      return runWorkNode(deps, batch, node, now, 'irreversible', () => applyWork(deps, batch, node, now))
    default:
      return runWorkNode(deps, batch, node, now, 'pure', () => reportWork(deps, batch, now))
  }
}

/**
 * 普通节点：拿租约 → started → 干活 → done；失败落 failed。
 * 租约失效时推进失败（LEASE_EXPIRED），不在无租约下写节点状态。
 */
async function runWorkNode(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  now: string,
  sideEffectPolicy: 'pure' | 'irreversible',
  work: () => Promise<Record<string, unknown>>,
): Promise<NodeOutcome> {
  const secret = deps.secret
  const leaseTtlMs = deps.leaseTtlMs ?? 60_000
  const ownerEpoch = deps.ownerEpoch ?? 0

  inTx(deps.db, (tx: Tx) => {
    acquireLease(tx, secret, { nodeRunId: node.node_run_id, ownerEpoch, leaseTtlMs, now })
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id,
      from: ['dispatched'],
      to: 'started',
      ruleId: 'M-04',
      attempt: node.attempt,
      now,
      patch: { side_effect_policy: sideEffectPolicy },
    })
  })

  let detail: Record<string, unknown> = {}
  try {
    detail = await work()
  } catch (err) {
    const orch = toOrchError(err)
    if (node.node_id === 'mem_apply' && loadBatchById(deps.db, batch.batch_id)?.status === 'applying') {
      const status = 'indeterminate_side_effect' as const
      inTx(deps.db, (tx) => {
        applyTransition(tx, secret, { nodeRunId: node.node_run_id, from: ['started'], to: status, ruleId: 'M-50', attempt: node.attempt, now })
        releaseLease(tx, { nodeRunId: node.node_run_id, now })
        tx.run("UPDATE runs SET status = 'paused', revision = revision + 1, updated_at = ? WHERE run_id = ? AND status IN ('running','settling')", [now, batch.memory_run_id])
        appendEvent(tx, { type: 'memory.apply.outcome_unknown', runId: batch.memory_run_id, nodeRunId: node.node_run_id, payload: { batch_id: batch.batch_id } })
      })
      return { status, step: { node_id: node.node_id, node_run_id: node.node_run_id, status } }
    }
    inTx(deps.db, (tx: Tx) => {
      applyTransition(tx, secret, {
        nodeRunId: node.node_run_id,
        from: ['started'],
        to: 'failed',
        ruleId: 'M-48',
        attempt: node.attempt,
        now,
        patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 },
      })
      appendNodeRunEvent(tx, secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.nodeFailed, {
        node_id: node.node_id,
        status: 'failed',
        error_code: orch.code,
        error_message: orch.message,
        ...detail,
      })
      appendEvent(tx, {
        type: MEMORY_RUNTIME_EVENTS.runNodeFailed,
        runId: batch.memory_run_id,
        nodeRunId: node.node_run_id,
        payload: {
          node_id: node.node_id,
          status: 'failed',
          error_code: orch.code,
          error_message: orch.message,
          batch_id: batch.batch_id,
        },
      })
      releaseLease(tx, { nodeRunId: node.node_run_id, now })
      if (node.node_id === 'mem_prepare') {
        // 准备输出没通过校验：批次不落行。
        tx.run(
          "DELETE FROM memory_batches WHERE batch_id = ? AND status = 'draft'" +
            ' AND NOT EXISTS (SELECT 1 FROM memory_items WHERE batch_id = ?)',
          [batch.batch_id, batch.batch_id],
        )
      }
    })
    return {
      status: 'failed',
      error_code: orch.code,
      step: {
        node_id: node.node_id,
        node_run_id: node.node_run_id,
        status: 'failed',
        detail: { error_code: orch.code, error_message: orch.message },
      },
    }
  }

  inTx(deps.db, (tx: Tx) => {
    renewLease(tx, { nodeRunId: node.node_run_id, leaseTtlMs, now })
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id,
      from: ['started'],
      to: 'done',
      ruleId: 'M-44',
      attempt: node.attempt,
      now,
    })
    appendNodeRunEvent(tx, secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.nodeAdvanced, {
      node_id: node.node_id,
      status: 'done',
      batch_id: batch.batch_id,
      ...detail,
    })
    appendEvent(tx, {
      type: MEMORY_RUNTIME_EVENTS.runNodeAdvanced,
      runId: batch.memory_run_id,
      nodeRunId: node.node_run_id,
      payload: {
        node_id: node.node_id,
        status: 'done',
        batch_id: batch.batch_id,
        ...detail,
      },
    })
    releaseLease(tx, { nodeRunId: node.node_run_id, now })
  })

  return {
    status: 'done',
    step: {
      node_id: node.node_id,
      node_run_id: node.node_run_id,
      status: 'done',
      detail,
    },
  }
}

async function prepareWork(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  now: string,
): Promise<Record<string, unknown>> {
  const source = await resolveSourceOf(deps, batch)
  const prepared = await deps.prepareItems({
    run_id: batch.source_run_id,
    batch_id: batch.batch_id,
    task_id: batch.task_id,
    task_title: source.task_title,
    goal: source.goal,
    result_summary: source.result_summary,
    evidence_refs: source.evidence_refs,
  })
  const items = normalizePreparedItems(prepared?.items)
  inTx(deps.db, (tx: Tx) => {
    saveMemoryProposal(tx, { batch_id: batch.batch_id, items, now })
  })
  return { item_count: items.length, batch_id: batch.batch_id }
}

async function checkWork(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  now: string,
): Promise<Record<string, unknown>> {
  const source = await resolveSourceOf(deps, batch)
  if (!batch.prepare_node_run_id) {
    throw new OrchError('MEMORY_BATCH_NOT_FOUND', '批次没有准备节点', { batch_id: batch.batch_id })
  }
  const result = await deps.ports.evaluate({
    batch_id: batch.batch_id,
    prepare_node_run_id: batch.prepare_node_run_id,
    source,
    now,
  })
  return {
    evaluation_id: result.evaluation_id,
    eval_attempt: result.eval_attempt,
    recommendation: result.recommendation,
    item_count: result.items.length,
    request_hash: result.request_hash,
  }
}

async function routeWork(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  now: string,
): Promise<Record<string, unknown>> {
  const recommendation = latestRecommendation(deps.db, batch.batch_id)
  if (!recommendation) {
    throw new OrchError('STALE_GENERATION', '没有评估结论，不能路由', { batch_id: batch.batch_id })
  }
  const branch = findMemoryNode('mem_route')
  const routes = branch?.routes ?? []
  const edges = routes.map((entry, index) => ({
    to: entry.to,
    when: { path: 'recommendation', op: 'eq' as const, value: entry.route },
    priority: index + 1,
  }))
  const choice = inTx(deps.db, (tx: Tx) =>
    applyBranchRoute(tx, deps.secret, {
      nodeRunId: node.node_run_id,
      attempt: node.attempt,
      from: ['started'],
      edges,
      input: { recommendation },
      now,
      runId: batch.memory_run_id,
    }),
  )
  if (choice.kind !== 'selected') {
    throw new OrchError('BRANCH_AMBIGUOUS', '路由没有命中唯一分支', {
      batch_id: batch.batch_id,
      recommendation,
    })
  }
  const advance = advanceMemoryRun('mem_route', recommendation)
  return { route: advance.route, next_node_id: advance.to, recommendation }
}

async function applyWork(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  now: string,
): Promise<Record<string, unknown>> {
  // mem_apply 复用 mem_confirm 那张卡：同一 decision_id，不新建第二张 pre_execution 卡。
  const current = loadBatchById(deps.db, batch.batch_id) ?? batch
  const decision = loadDecision(deps.db, current.decision_id)
  if (!decision) throw new OrchError('MEMORY_BATCH_NOT_APPROVED', '找不到写入使用的批准决定')
  inTx(deps.db, (tx: Tx) => {
    appendNodeRunEvent(tx, deps.secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.approvalReused, {
      node_id: node.node_id,
      decision_id: decision.decision_id,
      closed_reason: decision.closed_reason,
    })
  })
  const result = await deps.ports.applyGoverned({
    decision_id: decision.decision_id,
    batch_id: batch.batch_id,
    run_id: batch.memory_run_id,
    node_run_id: node.node_run_id,
    now,
  })
  return {
    decision_id: decision.decision_id,
    applied_count: result.applied_count,
    skipped_count: result.skipped_count,
    applied_item_ids: result.applied_item_ids,
    already_applied: result.already_applied,
  }
}

async function reportWork(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  now: string,
): Promise<Record<string, unknown>> {
  const result = deps.ports.inspectBatch({ batch_id: batch.batch_id })
  return {
    evidence_id: result.evidence_id,
    written_count: result.written_count,
    missing_count: result.missing_count,
    partial: result.partial,
    batch_status: result.batch_status,
  }
}

/**
 * mem_confirm：开审批卡 → blocked_pre 等人裁决。
 * 批准落库唯一由 memory-approval.ts 负责，runtime 只开卡、只读批次状态。
 */
async function runApprovalNode(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  now: string,
): Promise<NodeOutcome> {
  const current = loadBatchById(deps.db, batch.batch_id) ?? batch
  const decision = loadDecision(deps.db, current.decision_id)
  if (!decision) {
    const card = buildCard(deps, current)
    const opened = await openCard(deps, current, node, card, now)
    inTx(deps.db, (tx: Tx) => {
      enterBlockedPre(tx, deps.secret, {
        nodeRunId: node.node_run_id,
        attempt: node.attempt,
        decisionId: opened.decision_id,
        actionGeneration: node.action_generation,
        now,
      })
      // 幂等绑定：openMemoryApprovalCard 已经绑过时不覆盖，只补空缺。
      tx.run(
        "UPDATE memory_batches SET status = 'awaiting_human', confirm_node_run_id = COALESCE(confirm_node_run_id, ?)," +
          ' decision_id = COALESCE(decision_id, ?), updated_at = ?' +
          " WHERE batch_id = ? AND status IN ('draft','evaluating','awaiting_human')",
        [node.node_run_id, opened.decision_id, now, current.batch_id],
      )
      appendNodeRunEvent(tx, deps.secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.nodeBlocked, {
        node_id: node.node_id,
        status: 'blocked_pre',
        decision_id: opened.decision_id,
        batch_id: current.batch_id,
      })
      appendEvent(tx, {
        type: MEMORY_RUNTIME_EVENTS.runNodeBlocked,
        runId: batch.memory_run_id,
        nodeRunId: node.node_run_id,
        payload: {
          node_id: node.node_id,
          status: 'blocked_pre',
          decision_id: opened.decision_id,
          batch_id: current.batch_id,
        },
      })
    })
    return {
      status: 'blocked_pre',
      step: {
        node_id: node.node_id,
        node_run_id: node.node_run_id,
        status: 'blocked_pre',
        detail: { decision_id: opened.decision_id },
      },
    }
  }

  if (decision.status !== 'resolved') {
    return {
      status: 'blocked_pre',
      step: {
        node_id: node.node_id,
        node_run_id: node.node_run_id,
        status: 'blocked_pre',
        detail: { decision_id: decision.decision_id, decision_status: decision.status },
      },
    }
  }

  if (decision.closed_reason !== 'approved') {
    // 人驳回或卡过期：节点按 approval 节点默认动作落 failed，不进 mem_apply。
    // 批次 declined / expired 由 memory-approval.ts 落，runtime 不抢写终态。
    const closable = decision.closed_reason === 'rejected' || decision.closed_reason === 'expired_final'
    if (closable && node.status === 'blocked_pre') {
      inTx(deps.db, (tx: Tx) => {
        // 驳回/过期：审批节点没执行任何工具，副作用事实是「零副作用、无需核实」，
        // 不然 run 终态会误报成 failed_with_unverified（dispatcher 的同款处理）。
        // 迁移走 M-41（blocked_pre → failed / approval-rejected），并补上 resumeFromBlockedPre 写的状态事件。
        applyTransition(tx, deps.secret, {
          nodeRunId: node.node_run_id,
          from: ['blocked_pre'],
          to: 'failed',
          ruleId: 'M-41',
          attempt: node.attempt,
          now,
          patch: {
            resume_state: null,
            blocked_decision_id: null,
            side_effect_policy: 'pure',
            side_effect_verified_none: 1,
          },
        })
        appendNodeRunEvent(tx, deps.secret, node.node_run_id, 'status_changed', {
          from: 'blocked_pre',
          to: 'failed',
          decision_id: decision.decision_id,
          resolution: decision.closed_reason,
          attempt: node.attempt,
        })
      })
    }
    return {
      status: 'failed',
      error_code: decision.closed_reason === 'expired_final' ? 'DECISION_EXPIRED' : 'DECISION_REJECTED',
      step: {
        node_id: node.node_id,
        node_run_id: node.node_run_id,
        status: 'failed',
        detail: { decision_id: decision.decision_id, closed_reason: decision.closed_reason },
      },
    }
  }

  // 人已批准：批次必须已经被 memory-approval.ts 落成 approved，runtime 不自己补写快照。
  const approved = loadBatchById(deps.db, current.batch_id)
  if (!approved || approved.status !== 'approved') {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '审批已批准但批次没有批准快照，不能往下走', {
      batch_id: current.batch_id,
      decision_id: decision.decision_id,
      batch_status: approved?.status ?? null,
    })
  }

  if (node.status === 'blocked_pre') {
    inTx(deps.db, (tx: Tx) => {
      resumeFromBlockedPre(tx, deps.secret, {
        nodeRunId: node.node_run_id,
        attempt: node.attempt,
        decisionId: decision.decision_id,
        approved: true,
        now,
        // 审批卡绑的是提案哈希：内容没变才允许恢复节点。
        contentHash: current.proposal_hash ?? undefined,
      })
    })
  }
  return runWorkNode(deps, approved, node, now, 'pure', async () => approvalLanded(deps, approved, decision))
}

function buildCard(deps: MemoryRuntimeDeps, batch: MemoryBatchRow): ApprovalCard {
  const rows = loadItems(deps.db, batch.batch_id).filter(
    (row) => row.status === 'proposed' || row.status === 'approved',
  )
  const evaluation = loadLatestEvaluation(deps.db, batch.batch_id)
  return buildApprovalCard(rows.map(toMemoryItemInput), evaluation?.items ?? [])
}

/** 批准已落库：runtime 只读快照（条目状态与批次批准快照都由 memory-approval.ts 写）。 */
function approvalLanded(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  decision: DecisionRow,
): Record<string, unknown> {
  const rows = loadItems(deps.db, batch.batch_id)
  return {
    decision_id: decision.decision_id,
    approved_count: rows.filter((row) => row.status === 'approved').length,
    skipped_count: rows.filter((row) => row.status === 'skipped').length,
    approved_proposal_hash: batch.approved_proposal_hash,
  }
}

/** 开卡：外部注入优先；没注入就用 memory-approval.ts 的 openMemoryApprovalCard（唯一口径）。 */
async function openCard(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  node: NodeRow,
  card: ApprovalCard,
  now: string,
): Promise<{ decision_id: string }> {
  if (deps.openApprovalCard) {
    return await deps.openApprovalCard({
      run_id: batch.memory_run_id,
      node_run_id: node.node_run_id,
      batch_id: batch.batch_id,
      card,
      now,
    })
  }
  const opened = inTx(deps.db, (tx: Tx) =>
    openMemoryApprovalCard(tx, {
      run_id: batch.memory_run_id,
      node_run_id: node.node_run_id,
      batch_id: batch.batch_id,
      card,
      now,
    }),
  )
  return { decision_id: opened.decision_id }
}

/** 路径之外的节点置 superseded，好让收口闸门通过。 */
function supersedeOffPath(
  deps: MemoryRuntimeDeps,
  nodes: Map<string, NodeRow>,
  path: readonly string[],
  now: string,
): void {
  const keep = new Set(path)
  for (const node of nodes.values()) {
    if (keep.has(node.node_id)) continue
    if (node.status !== 'queued' && node.status !== 'leased') continue
    inTx(deps.db, (tx: Tx) => {
      applyTransition(tx, deps.secret, {
        nodeRunId: node.node_run_id,
        from: ['queued', 'leased'],
        to: 'superseded',
        ruleId: 'M-62',
        attempt: node.attempt,
        now,
        patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 },
      })
      appendNodeRunEvent(tx, deps.secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.nodeAdvanced, {
        node_id: node.node_id,
        status: 'superseded',
      })
      appendEvent(tx, {
        type: MEMORY_RUNTIME_EVENTS.runNodeAdvanced,
        runId: node.run_id,
        nodeRunId: node.node_run_id,
        payload: { node_id: node.node_id, status: 'superseded' },
      })
    })
  }
}

function finishCompleted(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  steps: MemoryRuntimeStep[],
  now: string,
): MemoryRuntimeResult {
  const terminal = inTx(deps.db, (tx: Tx) => closeRun(tx, deps.secret, batch.memory_run_id, now))
  inTx(deps.db, (tx: Tx) => {
    appendEvent(tx, {
      type: MEMORY_RUNTIME_EVENTS.runClosed,
      runId: batch.memory_run_id,
      payload: { status: terminal, batch_id: batch.batch_id },
    })
  })
  const current = loadBatchById(deps.db, batch.batch_id)
  return {
    memory_run_id: batch.memory_run_id,
    batch_id: batch.batch_id,
    status: 'completed',
    steps,
    terminal,
    batch_status: current?.status ?? batch.status,
    run_status: runStatusOf(deps.db, batch.memory_run_id),
  }
}

function finishFailed(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  failedNode: NodeRow,
  nodes: Map<string, NodeRow>,
  steps: MemoryRuntimeStep[],
  now: string,
  errorCode?: string,
): MemoryRuntimeResult {
  supersedeRemaining(deps, batch.memory_run_id, now)
  settleFailedBatch(deps, batch, failedNode, now, errorCode)
  const terminal = inTx(deps.db, (tx: Tx) => closeRun(tx, deps.secret, batch.memory_run_id, now))
  const current = loadBatchById(deps.db, batch.batch_id)
  return {
    memory_run_id: batch.memory_run_id,
    batch_id: batch.batch_id,
    status: 'failed',
    steps,
    terminal,
    batch_status: current?.status ?? batch.status,
    run_status: runStatusOf(deps.db, batch.memory_run_id),
    error_code: errorCode,
  }
}

function supersedeRemaining(deps: MemoryRuntimeDeps, runId: string, now: string): void {
  // 重新读一遍节点：失败收口时手上的快照可能是旧的（刚失败的节点已经落 failed）。
  for (const node of loadNodes(deps.db, runId).values()) {
    if (isTerminal(node.status)) continue
    // M-62 只覆盖 queued/leased；已派发或起跑的节点只能按 M-48 落 failed。
    const target: 'superseded' | 'failed' =
      node.status === 'queued' || node.status === 'leased' ? 'superseded' : 'failed'
    const ruleId = target === 'superseded' ? 'M-62' : 'M-48'
    inTx(deps.db, (tx: Tx) => {
      applyTransition(tx, deps.secret, {
        nodeRunId: node.node_run_id,
        from: ['queued', 'leased', 'dispatched', 'started'],
        to: target,
        ruleId,
        attempt: node.attempt,
        now,
        patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 },
      })
      appendNodeRunEvent(tx, deps.secret, node.node_run_id, MEMORY_RUNTIME_EVENTS.nodeAdvanced, {
        node_id: node.node_id,
        status: target,
      })
      appendEvent(tx, {
        type: MEMORY_RUNTIME_EVENTS.runNodeAdvanced,
        runId: node.run_id,
        nodeRunId: node.node_run_id,
        payload: { node_id: node.node_id, status: target },
      })
    })
  }
}

/**
 * 失败收口：批次 failed，不留 proposed。
 * 审批驳回（declined）与卡过期（expired）由 memory-approval.ts 落终态，runtime 不抢写。
 */
function settleFailedBatch(
  deps: MemoryRuntimeDeps,
  batch: MemoryBatchRow,
  failedNode: NodeRow,
  now: string,
  errorCode?: string,
): void {
  const current = loadBatchById(deps.db, batch.batch_id)
  if (!current) return
  if (
    current.status === 'applied' ||
    current.status === 'empty' ||
    current.status === 'blocked' ||
    current.status === 'declined' ||
    current.status === 'expired' ||
    current.status === 'failed' ||
    current.status === 'indeterminate'
  ) {
    return
  }
  const decision = loadDecision(deps.db, current.decision_id)
  if (decision && (decision.closed_reason === 'rejected' || decision.closed_reason === 'expired_final')) {
    // 拒绝 / 过期由 memory-approval.ts 落 declined / expired，这里不写批次终态。
    return
  }
  inTx(deps.db, (tx: Tx) => {
    tx.run(
      "UPDATE memory_batches SET status = 'failed', outcome = 'failed', error_code = ?, error_message = ?, updated_at = ?" +
        " WHERE batch_id = ? AND status NOT IN ('applied','empty','blocked','declined','expired','failed','indeterminate')",
      [
        errorCode ?? null,
        `记忆 run 在 ${failedNode.node_id} 失败`,
        now,
        batch.batch_id,
      ],
    )
    tx.run("UPDATE memory_items SET status = 'skipped' WHERE batch_id = ? AND status = 'proposed'", [batch.batch_id])
  })
}
