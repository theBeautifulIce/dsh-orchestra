import { OrchError } from '../../core/errors.ts'
import { MODEL_COMPLEXITIES, readModelUse, type ModelAssignment } from '../../executor/model-routing.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx, type ReadCtx } from './read-tx.ts'

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
  superseded: '已被新 attempt 取代',
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
  revision: number
  side_effect_policy: string
  side_effect_verified_none: boolean
  declared_effect: string | null
  verified_effect: string | null
  evidence_strength: null
  evidence_state: 'none' | 'not_required' | 'unverified'
  evidence_state_reason: string | null
  execution_ids: string[]
  execution_count: number
  projection_missing: string[]
  attestation_id: string | null
  action_start_source: 'human_attested' | null
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

function toNodeView(row: NodeRow, settling: boolean, decisionIds: string[], executionIds: string[], model?: NodeRunView['model_assignment'], title?: string): NodeRunView {
  return {
    node_run_id: String(row.node_run_id),
    run_id: String(row.run_id),
    node_id: String(row.node_id ?? ''),
    ...(title ? { title } : {}),
    node_type: String(row.node_type ?? ''),
    attempt: Number(row.attempt ?? 0),
    status: String(row.status),
    display_status: nodeDisplayStatus(String(row.status), settling),
    status_label: NODE_LABEL[String(row.status)] ?? String(row.status),
    revision: Number(row.revision ?? 0),
    side_effect_policy: String(row.side_effect_policy ?? 'compensable'),
    side_effect_verified_none: Number(row.side_effect_verified_none ?? 0) === 1,
    declared_effect: null,
    verified_effect: null,
    evidence_strength: null,
    evidence_state: executionIds.length > 0 ? 'unverified' : 'none',
    evidence_state_reason: executionIds.length > 0
      ? '存在工具执行记录，但尚未验证完成事件和事件链，不能作为 strong 证据。'
      : '没有工具执行记录。',
    execution_ids: executionIds,
    execution_count: executionIds.length,
    projection_missing: ['declared_effect', 'verified_effect'],
    attestation_id: typeof row.attestation_id === 'string' ? row.attestation_id : null,
    action_start_source: typeof row.attestation_id === 'string' ? 'human_attested' : null,
    stop_evidence: typeof row.stop_evidence === 'string' ? row.stop_evidence : null,
    hang_reason: typeof row.hang_reason === 'string' ? row.hang_reason : null,
    recovery_uncertain: typeof row.recovery_uncertain === 'string' ? row.recovery_uncertain : null,
    replacement_node_run_id: typeof row.replacement_node_run_id === 'string' ? row.replacement_node_run_id : null,
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

function runDisplay(ctx: ReadCtx, runId: string) {
  const row = ctx.tx.get<{ settling: number; doc_json: string | null }>(
    'SELECT r.settling, w.doc_json FROM runs r LEFT JOIN workflow_versions w'
    + ' ON w.workflow_id = r.workflow_id AND w.version = r.workflow_version WHERE r.run_id = ?', [runId],
  )
  if (!row) throw new OrchError('NOT_FOUND', '没找到这次运行', { run_id: runId })
  const titles = new Map<string, string>()
  if (row.doc_json) {
    // A legacy or damaged document cannot supply display labels for the execution facts.
    try {
      const doc = JSON.parse(row.doc_json) as { nodes?: { node_id?: string; title?: string }[] } | null
      if (Array.isArray(doc?.nodes)) {
        for (const node of doc.nodes) {
          if (typeof node?.node_id === 'string' && typeof node.title === 'string') titles.set(node.node_id, node.title)
        }
      }
    } catch { /* Keep the persisted node IDs as labels. */ }
  }
  return { settling: row.settling === 1, titles }
}

export function listNodes(db: Db, runId: string, limit = 100): { items: NodeRunView[]; as_of_seq: number } {
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > 200) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 200 条', { limit })
  return withReadTx(db, (ctx) => {
    const { settling, titles } = runDisplay(ctx, runId)
    const rows = ctx.tx.all<NodeRow>(
      'SELECT n.*, (SELECT a.attestation_id FROM attestations a WHERE a.node_run_id = n.node_run_id AND a.attempt = n.attempt '
      + 'ORDER BY a.created_at DESC, a.attestation_id DESC LIMIT 1) AS attestation_id '
      + 'FROM node_runs n WHERE n.run_id = ? ORDER BY n.seq, n.attempt, n.node_run_id LIMIT ?', [runId, limit],
    )
    const items = rows.map((row) => toNodeView(
      row, settling, activeDecisions(ctx, row.node_run_id), nodeExecutionIds(ctx, row.node_run_id, Number(row.attempt ?? 0)),
      modelAssignment(ctx, row), titles.get(String(row.node_id)),
    ))
    return { items, as_of_seq: ctx.as_of_seq }
  })
}

export function getNodeSnapshot(db: Db, nodeRunId: string): { item: NodeRunView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<NodeRow>(
      'SELECT n.*, (SELECT a.attestation_id FROM attestations a WHERE a.node_run_id = n.node_run_id AND a.attempt = n.attempt '
      + 'ORDER BY a.created_at DESC, a.attestation_id DESC LIMIT 1) AS attestation_id '
      + 'FROM node_runs n WHERE n.node_run_id = ?', [nodeRunId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个执行节点', { node_run_id: nodeRunId })
    const { settling, titles } = runDisplay(ctx, row.run_id)
    return {
      item: toNodeView(
        row, settling, activeDecisions(ctx, row.node_run_id), nodeExecutionIds(ctx, row.node_run_id, Number(row.attempt ?? 0)),
        modelAssignment(ctx, row), titles.get(String(row.node_id)),
      ),
      as_of_seq: ctx.as_of_seq,
    }
  })
}

export function getNode(db: Db, nodeRunId: string): NodeRunView {
  return getNodeSnapshot(db, nodeRunId).item
}
