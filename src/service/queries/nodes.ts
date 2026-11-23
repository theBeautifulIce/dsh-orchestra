import { OrchError } from '../../core/errors.ts'
import { MODEL_COMPLEXITIES, readModelUse, validModelEffort, type ModelAssignment } from '../../executor/model-routing.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx, type ReadCtx, type ReadTx } from './read-tx.ts'
import type { EffectVerdict } from '../../executor/tools.ts'
import { dependencyReadiness, pinnedRunTopology, readRunBinding, runPredecessors } from '../run-readiness.ts'
import { reworkBlocksNode } from '../rework-runtime.ts'

export const NODE_TERMINAL = [
  'done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded',
] as const

const NODE_LABEL: Record<string, string> = {
  queued: '排队中还没派给执行者',
  leased: '已分到执行位，等执行者接手',
  dispatched: '已派出，等执行者启动',
  started: '已开跑，等回写',
  verifying: '等验证',
  waiting: '等外部条件',
  timing_out: '已请求停止，正在确认停没停',
  stopping: '已请求停止，动作可能还在跑',
  startup_unknown: '启动情况不明——可能没开跑，也可能已开跑',
  indeterminate_side_effect: '操作已停止，外部影响待核验',
  blocked_pre: '执行前被挡住，等人处理',
  blocked_post: '执行完了，结果等人定',
  paused_bridge_missing: '桥断了，先暂停跟踪',
  done: '已完成',
  failed: '没做成',
  timeout: '超时收口',
  abandoned_unverified: '已停止跟踪，外部影响待核验',
  failed_with_unverified: '执行失败，外部影响待核验',
  orphaned: '没有新 attempt 接手',
  superseded: '本次尝试已停止',
}

export function nodeDisplayStatus(status: string, settling: boolean): string {
  if (!NODE_LABEL[status]) return 'projection_missing'
  if ((NODE_TERMINAL as readonly string[]).includes(status)) return status
  if (settling) return 'settling'
  if (status === 'waiting' || status === 'blocked_pre' || status === 'blocked_post') return 'blocked'
  return 'running'
}

export type NodeRunView = {
  node_run_id: string
  run_id: string
  node_id: string
  title?: string
  node_type: string
  attempt: number
  status: string
  display_status: string
  status_label: string
  execution_state?: string
  /** Direct predecessors from the pinned workflow and approved runtime edges. Missing means unknown. */
  depends_on?: string[]
  waiting_on?: string[]
  revision: number
  side_effect_policy: string
  side_effect_verified_none: boolean
  declared_effect: string | null
  verified_effect: string | null
  evidence_strength: null
  evidence_state: 'none' | 'not_required' | 'unverified' | 'settled'
  evidence_state_reason: string | null
  effect_resolution_basis?: 'verified_none' | 'evidence' | 'decision' | null
  effect_decision_id?: string | null
  execution_ids: string[]
  execution_count: number
  projection_missing: string[]
  attestation_id: string | null
  action_start_source: 'human_attested' | 'human_confirmed' | null
  stop_evidence: string | null
  hang_reason: string | null
  recovery_uncertain: string | null
  replacement_node_run_id: string | null
  heartbeat_at: string | null
  started_at: string | null
  created_at: string
  updated_at: string
  active_decision_ids: string[]
  model_assignment?: ModelAssignment & { state: 'selected' | 'confirmed' | 'rejected' }
}

type NodeRow = Record<string, unknown> & { node_run_id: string; status: string; run_id: string }

function wasCancelled(row: NodeRow): boolean {
  return row.status === 'superseded' && Boolean(row.cancel_requested_at) && !row.replacement_node_run_id
}

const NODE_VIEW_SELECT = `SELECT n.*, s.resolution_basis,
  CASE WHEN n.status='superseded' THEN EXISTS(SELECT 1 FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type='branch.skipped') ELSE 0 END AS branch_skipped,
  COALESCE(s.decision_id, (
    SELECT d.decision_id FROM node_run_events e JOIN decisions d
    ON d.decision_id = CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.decision_id') END
    WHERE s.resolution_basis = 'verified_none' AND e.node_run_id = n.node_run_id AND e.type = 'effect.resolved'
    AND d.run_id = n.run_id AND d.node_run_id = n.node_run_id
    AND CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.resolved_at') = s.resolved_at
      AND json_extract(e.payload, '$.stop_evidence') = s.stop_evidence END
    ORDER BY e.seq DESC LIMIT 1
  ), n.contradiction_decision_id, (
    SELECT d.decision_id FROM decisions d WHERE d.run_id = n.run_id AND d.node_run_id = n.node_run_id
    AND d.kind IN ('verify_human','action_overrun','report_contradicted')
    ORDER BY d.created_at DESC, d.decision_id DESC LIMIT 1
  )) AS effect_decision_id,
  (SELECT a.attestation_id FROM attestations a WHERE a.node_run_id = n.node_run_id AND a.attempt = n.attempt
    ORDER BY a.created_at DESC, a.attestation_id DESC LIMIT 1) AS attestation_id
  FROM node_runs n LEFT JOIN unverified_resolutions s ON s.node_run_id = n.node_run_id`

function toNodeView(row: NodeRow, settling: boolean, decisionIds: string[], executionIds: string[], model?: NodeRunView['model_assignment'],
  doc?: { title: string; declaredEffect: EffectVerdict | null }): NodeRunView {
  const replacement = typeof row.replacement_node_run_id === 'string' ? row.replacement_node_run_id : null
  const label = row.branch_skipped === 1 ? '分支未选中' : wasCancelled(row) ? '已取消'
    : row.status === 'superseded' && replacement ? '已由新尝试接替' : NODE_LABEL[row.status] ?? row.status
  const declared = doc?.declaredEffect ?? null
  const verified = row.resolution_basis === 'verified_none' ? 'not_applied'
    : row.resolution_basis === 'evidence' || row.resolution_basis === 'decision' ? 'applied' : null
  const evidenceState = verified ? 'settled' : row.side_effect_policy === 'pure' ? 'not_required'
    : row.status === 'done' || executionIds.length === 0 ? 'none' : 'unverified'
  const reasons = {
    none: '尚无能够核实这次外部操作结果的证据。',
    not_required: '此步骤按只读策略执行，无需核验外部操作。',
    unverified: '已有工具执行记录，外部操作结果仍待核实。',
    settled: '账本已有结算记录。',
  }
  // 流程生成器可能只给 node_id：主视图不裸露内部标识，退回可读的「步骤 N」（T12）。
  const nodeId = String(row.node_id ?? '')
  const docTitle = doc?.title && doc.title !== nodeId ? doc.title : undefined
  const seqNumber = Number(row.seq ?? 0)
  const fallbackTitle = seqNumber > 0 ? `步骤 ${seqNumber}` : undefined
  return {
    node_run_id: String(row.node_run_id),
    run_id: String(row.run_id),
    node_id: nodeId,
    ...(docTitle ?? fallbackTitle ? { title: docTitle ?? fallbackTitle } : {}),
    node_type: String(row.node_type ?? ''),
    attempt: Number(row.attempt ?? 0),
    status: String(row.status),
    display_status: nodeDisplayStatus(String(row.status), settling),
    status_label: label,
    revision: Number(row.revision ?? 0),
    side_effect_policy: String(row.side_effect_policy ?? 'compensable'),
    side_effect_verified_none: Number(row.side_effect_verified_none ?? 0) === 1,
    declared_effect: declared,
    verified_effect: verified,
    evidence_strength: null,
    evidence_state: evidenceState,
    evidence_state_reason: reasons[evidenceState],
    effect_resolution_basis: row.resolution_basis === 'verified_none' || row.resolution_basis === 'evidence' || row.resolution_basis === 'decision'
      ? row.resolution_basis : null,
    effect_decision_id: typeof row.effect_decision_id === 'string' ? row.effect_decision_id : null,
    execution_ids: executionIds,
    execution_count: executionIds.length,
    projection_missing: declared === null && row.side_effect_policy !== 'pure' ? ['declared_effect'] : [],
    attestation_id: typeof row.attestation_id === 'string' ? row.attestation_id : null,
    action_start_source: row.action_start_source === 'human_confirmed' ? 'human_confirmed'
      : typeof row.attestation_id === 'string' ? 'human_attested' : null,
    stop_evidence: typeof row.stop_evidence === 'string' ? row.stop_evidence : null,
    hang_reason: typeof row.hang_reason === 'string' ? row.hang_reason : null,
    recovery_uncertain: typeof row.recovery_uncertain === 'string' ? row.recovery_uncertain : null,
    replacement_node_run_id: replacement,
    heartbeat_at: typeof row.heartbeat_at === 'string' ? row.heartbeat_at : null,
    started_at: typeof row.started_at === 'string' ? row.started_at : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    active_decision_ids: decisionIds,
    ...(model ? { model_assignment: model } : {}),
  }
}

function modelAssignment(ctx: ReadCtx, row: NodeRow): NodeRunView['model_assignment'] {
  const model = ctx.tx.get<{ payload: string }>(
    "SELECT payload FROM node_run_events WHERE node_run_id = ? AND type IN ('executor.model_selected','executor.model_confirmed','executor.model_rejected','executor.model_used')"
    + " AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.attempt') = ? AND json_extract(payload, '$.action_generation') = ? END"
    + ' ORDER BY seq DESC LIMIT 1', [row.node_run_id, Number(row.attempt), Number(row.action_generation)],
  )
  if (!model) return undefined
  const payload = JSON.parse(model.payload) as NonNullable<NodeRunView['model_assignment']>
  if (!MODEL_COMPLEXITIES.includes(payload.complexity) || typeof payload.model_ref !== 'string' || typeof payload.reason !== 'string'
    || !['selected', 'confirmed', 'rejected'].includes(payload.state)) return undefined
  const usage = payload.state === 'confirmed' ? readModelUse(payload.usage) : undefined
  const settingsRevision = payload.settings_revision
  return { model_ref: payload.model_ref, complexity: payload.complexity, reason: payload.reason, state: payload.state,
    ...(typeof payload.provider === 'string' && typeof payload.model === 'string' ? { provider: payload.provider, model: payload.model } : {}),
    ...(payload.reasoning_effort === null || validModelEffort(payload.reasoning_effort) ? { reasoning_effort: payload.reasoning_effort } : {}),
    ...(usage ? { usage } : {}), ...(Number.isSafeInteger(settingsRevision) && settingsRevision! > 0 ? { settings_revision: settingsRevision } : {}) }
}

function activeDecisions(ctx: ReadCtx, nodeRunId: string): string[] {
  return ctx.tx.all<{ decision_id: string }>(
    "SELECT decision_id FROM decisions WHERE node_run_id = ? AND status IN ('pending','acknowledged','blocked_for_human') ORDER BY created_at, decision_id",
    [nodeRunId],
  ).map((row) => row.decision_id)
}

function nodeExecutionIds(ctx: ReadCtx, nodeRunId: string, attempt: number): string[] {
  return ctx.tx.all<{ execution_id: string }>(
    'SELECT execution_id FROM tool_executions WHERE node_run_id = ? AND attempt = ? ORDER BY tool_seq, execution_id',
    [nodeRunId, attempt],
  ).map((row) => row.execution_id)
}

export function readRunNodeDisplay(tx: ReadTx, runId: string) {
  const row = tx.get<{ settling: number; doc_json: string | null }>(
    'SELECT r.settling, w.doc_json FROM runs r LEFT JOIN workflow_versions w'
    + ' ON w.workflow_id = r.workflow_id AND w.version = r.workflow_version'
    + ' AND (r.workflow_definition_hash IS NULL OR w.content_hash = r.workflow_definition_hash) WHERE r.run_id = ?', [runId],
  )
  if (!row) throw new OrchError('NOT_FOUND', '没找到这次运行', { run_id: runId })
  const nodes = new Map<string, { title: string; declaredEffect: EffectVerdict | null }>()
  if (row.doc_json) {
    // A legacy or damaged document cannot supply display labels for the execution facts.
    try {
      const doc = JSON.parse(row.doc_json) as { nodes?: { node_id?: string; title?: string; contract?: { declared_effect?: unknown } }[] } | null
      if (Array.isArray(doc?.nodes)) {
        for (const node of doc.nodes) {
          if (typeof node?.node_id !== 'string' || typeof node.title !== 'string') continue
          const declared = node.contract?.declared_effect
          nodes.set(node.node_id, { title: node.title, declaredEffect: declared === 'applied' || declared === 'not_applied' ? declared : null })
        }
      }
    } catch { /* Keep the persisted node IDs as labels. */ }
  }
  return { settling: row.settling === 1, nodes }
}

function readExecutionStates(tx: ReadTx, runId: string, isWaiting?: (nodeRunId: string) => boolean) {
  const binding = readRunBinding(tx, runId)
  const topology = binding ? pinnedRunTopology(binding) : null
  const preds = topology ? runPredecessors(tx, runId, topology.edges) : null
  return (row: NodeRow): Pick<NodeRunView, 'execution_state' | 'depends_on' | 'waiting_on'> => {
    const depends_on = preds?.get(String(row.node_id)) ?? []
    const state = (execution_state: string, waiting_on: string[] = []) => ({
      execution_state, waiting_on, ...(binding?.definition_json && preds ? { depends_on } : {}),
    })
    if (wasCancelled(row)) return state('cancelled')
    if (row.status !== 'queued') return state(row.status)
    if (binding?.cancel_requested_at) return state('cancelled')
    if (binding?.status === 'paused' || reworkBlocksNode(tx, row.node_run_id)) return state('paused')
    if (!preds) return state('queued_unknown')
    const readiness = dependencyReadiness(tx, runId, row.node_run_id, depends_on, String(row.node_id), undefined, topology)
    if (!readiness.ready) {
      if (readiness.missingPreds.length > 0) return state('queued_unknown', [...readiness.missingPreds, ...readiness.failedPreds, ...readiness.waitingPreds])
      if (readiness.failedPreds.length > 0) return state('blocked_dependencies', readiness.failedPreds)
      return state('waiting_dependencies', readiness.waitingPreds)
    }
    return state(isWaiting?.(row.node_run_id) ? 'waiting_capacity' : 'ready')
  }
}

/**
 * 运行节点清单：稳定游标，第 201 条尝试也能翻到（T05）。
 * 游标按 (seq, attempt, node_run_id) 升序推进，与展示顺序一致。
 */
export function listNodes(db: Db, runId: string, limit = 100, isWaiting?: (nodeRunId: string) => boolean,
  cursorInput?: string): { items: NodeRunView[]; as_of_seq: number; has_more: boolean; next_cursor: string | null } {
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > 200) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 200 条', { limit })
  const filter = { run_id: runId }
  const now = Date.now()
  return withReadTx(db, (ctx) => {
    const { settling, nodes } = readRunNodeDisplay(ctx.tx, runId)
    const executionState = readExecutionStates(ctx.tx, runId, isWaiting)
    const where = ['n.run_id = ?']
    const values: unknown[] = [runId]
    if (cursorInput) {
      const cursor = decodeCursor(cursorInput, 'nodes', filter, now)
      const [seq, attempt] = cursor.last_key.split('\t').map(Number)
      if (!Number.isInteger(seq) || !Number.isInteger(attempt)) {
        throw new OrchError('CURSOR_EXPIRED', '游标里的节点位置不合法，请重新加载', { node_run_id: cursor.last_id })
      }
      where.push('(n.seq, n.attempt, n.node_run_id) > (?, ?, ?)')
      values.push(seq, attempt, cursor.last_id)
    }
    const rows = ctx.tx.all<NodeRow>(
      NODE_VIEW_SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY n.seq, n.attempt, n.node_run_id LIMIT ?',
      [...values, limit + 1],
    )
    const page = rows.slice(0, limit)
    const items = page.map((row) => ({
      ...toNodeView(row, settling, activeDecisions(ctx, row.node_run_id), nodeExecutionIds(ctx, row.node_run_id, Number(row.attempt ?? 0)),
        modelAssignment(ctx, row), nodes.get(String(row.node_id))),
      ...executionState(row),
    }))
    const last = page[page.length - 1]
    const next_cursor = rows.length > limit && last
      ? encodeCursor(makeCursor('nodes', filter, `${Number(last.seq ?? 0)}\t${Number(last.attempt ?? 0)}`, String(last.node_run_id), ctx.as_of_seq, now))
      : null
    return { items, as_of_seq: ctx.as_of_seq, has_more: rows.length > limit, next_cursor }
  })
}

export function getNodeSnapshot(db: Db, nodeRunId: string, isWaiting?: (nodeRunId: string) => boolean): { item: NodeRunView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<NodeRow>(NODE_VIEW_SELECT + ' WHERE n.node_run_id = ?', [nodeRunId])
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个执行节点', { node_run_id: nodeRunId })
    const { settling, nodes } = readRunNodeDisplay(ctx.tx, row.run_id)
    return {
      item: {
        ...toNodeView(row, settling, activeDecisions(ctx, row.node_run_id), nodeExecutionIds(ctx, row.node_run_id, Number(row.attempt ?? 0)),
          modelAssignment(ctx, row), nodes.get(String(row.node_id))),
        ...readExecutionStates(ctx.tx, row.run_id, isWaiting)(row),
      },
      as_of_seq: ctx.as_of_seq,
    }
  })
}

export function getNode(db: Db, nodeRunId: string): NodeRunView {
  return getNodeSnapshot(db, nodeRunId).item
}
