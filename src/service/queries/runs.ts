import { OrchError } from '../../core/errors.ts'
import { TASK_ORIGINS, type TaskOrigin } from '../../core/task-workspace.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx, type ReadCtx } from './read-tx.ts'
import { readProjectContextMetadata, type ProjectContextMetadata } from '../project-shared-context.ts'
import type { AcceptanceKind, AcceptanceOutcome } from '../commands/run-acceptance.ts'
import { isReleaseWorkflow } from '../../core/release-workflow-ids.ts'
import { MEMORY_WORKFLOW_ID } from '../commands/memory.ts'
import { operatorStopState } from '../operator-run-stop.ts'

export type NodeRunCount = { status: string; count: number }
export type NodeRunPreview = {
  node_run_id: string
  node_id: string
  node_type: string
  attempt: number
  status: string
  revision: number
  updated_at: string
}

export type RunDeliveryCheck = {
  result_id: string
  kind: AcceptanceKind
  outcome: AcceptanceOutcome
  reason: string | null
  evaluated_at: string
  rule_version: string
  title?: string
  sha256?: string
  item_index?: number
  artifact_id?: string
  file_name?: string
  minimum_bytes?: number
  bytes?: number
  tool?: string
  expected_exit_code?: number
  exit_codes?: number[]
}

export type RunSummary = {
  run_id: string
  task_id: string
  task_title?: string | null
  workflow_id: string | null
  workflow_version: number | null
  status: string
  display_status: string
  operator_stop_state?: ReturnType<typeof operatorStopState>
  settling: boolean
  revision: number
  counts: NodeRunCount[]
  /** 按当前有效尝试去重后的步骤统计：人读进度用这一组（T04）。 */
  step_counts?: NodeRunCount[]
  total: number
  top_nodes: NodeRunPreview[]
  last_event_seq: number
  as_of_seq: number
  created_at: string
  updated_at: string
  started_at?: string | null
  ended_at?: string | null
  scheduled_for?: string | null
  trigger_kind?: TaskOrigin | null
  project_context?: ProjectContextMetadata
  delivery_checks?: { items: RunDeliveryCheck[]; has_more: boolean }
}

type RunRow = Record<string, unknown> & { run_id: string }

const RUN_SELECT = `SELECT r.run_id, r.task_id, r.workflow_id, r.workflow_version, r.status, r.revision, r.settling,
r.created_at, r.updated_at, r.started_at, r.ended_at, r.cancel_requested_at, t.title AS task_title, o.due_at AS scheduled_for,
COALESCE(tr.kind, (SELECT CASE WHEN json_valid(e.payload_redacted) THEN json_extract(e.payload_redacted, '$.trigger_kind') END
  FROM events e WHERE e.run_id = r.run_id AND e.type IN ('task.created', 'task.run_started') ORDER BY e.seq LIMIT 1)) AS trigger_kind
FROM runs r JOIN tasks t ON t.task_id = r.task_id
LEFT JOIN task_trigger_occurrences o ON o.run_id = r.run_id LEFT JOIN task_triggers tr ON tr.trigger_id = o.trigger_id`

function toRunSummary(ctx: ReadCtx, run: RunRow): RunSummary {
  const runId = String(run.run_id)
  const counts = ctx.tx.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM node_runs WHERE run_id = ? GROUP BY status ORDER BY status', [runId],
  ).map((row) => ({ status: row.status, count: Number(row.n) }))
  // 同一步骤可能重试多次：人读进度按 node_id 的当前尝试去重，明细仍保留全部尝试。
  const stepCounts = ctx.tx.all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM node_runs n WHERE n.run_id = ?
      AND n.replacement_node_run_id IS NULL
      AND n.attempt = (SELECT MAX(m.attempt) FROM node_runs m
        WHERE m.run_id = n.run_id AND m.node_id = n.node_id AND m.replacement_node_run_id IS NULL)
      GROUP BY status ORDER BY status`, [runId],
  ).map((row) => ({ status: row.status, count: Number(row.n) }))
  const lastEvent = ctx.tx.get<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM events WHERE run_id = ?', [runId],
  )
  const nodes = ctx.tx.all<NodeRunPreview>(
    'SELECT node_run_id, node_id, node_type, attempt, status, revision, updated_at FROM node_runs '
    + 'WHERE run_id = ? ORDER BY updated_at DESC, node_run_id DESC LIMIT 10', [runId],
  )
  const status = String(run.status ?? '')
  const workflowId = typeof run.workflow_id === 'string' ? run.workflow_id : undefined
  return {
    run_id: runId,
    task_id: String(run.task_id ?? ''),
    task_title: typeof run.task_title === 'string' ? run.task_title : null,
    workflow_id: workflowId ?? null,
    workflow_version: typeof run.workflow_version === 'number' ? run.workflow_version : null,
    status,
    // Preserve the ledger's terminal distinctions; presentation can add labels without collapsing them.
    display_status: status,
    ...(!isReleaseWorkflow(workflowId) && workflowId !== MEMORY_WORKFLOW_ID && {
      operator_stop_state: operatorStopState(status, run.cancel_requested_at),
    }),
    settling: Number(run.settling ?? 0) === 1,
    revision: Number(run.revision ?? 0),
    counts,
    total: counts.reduce((sum, row) => sum + row.count, 0),
    step_counts: stepCounts,
    top_nodes: nodes,
    last_event_seq: Number(lastEvent?.seq ?? 0),
    as_of_seq: ctx.as_of_seq,
    created_at: String(run.created_at ?? ''),
    updated_at: String(run.updated_at ?? ''),
    started_at: typeof run.started_at === 'string' ? run.started_at : null,
    ended_at: typeof run.ended_at === 'string' ? run.ended_at : null,
    scheduled_for: run.trigger_kind === 'scheduled' && typeof run.scheduled_for === 'string' ? run.scheduled_for : null,
    trigger_kind: (TASK_ORIGINS as readonly unknown[]).includes(run.trigger_kind) ? run.trigger_kind as TaskOrigin : null,
  }
}

export type RunFilters = { task_id?: string; workflow_id?: string; limit?: number; cursor?: string }

export function listRuns(db: Db, opts: RunFilters = {}): { items: RunSummary[]; next_cursor: string | null; as_of_seq: number } {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > 100) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 100 条', { limit })
  return withReadTx(db, (ctx) => {
    const clauses: string[] = []
    const values: (string | number)[] = []
    if (opts.task_id) { clauses.push('r.task_id = ?'); values.push(opts.task_id) }
    if (opts.workflow_id) { clauses.push('r.workflow_id = ?'); values.push(opts.workflow_id) }
    const scope = { task_id: opts.task_id ?? null, workflow_id: opts.workflow_id ?? null }
    if (opts.cursor) {
      const cursor = decodeCursor(opts.cursor, 'runs', scope)
      clauses.push('(r.created_at < ? OR (r.created_at = ? AND r.run_id < ?))')
      values.push(cursor.last_key, cursor.last_key, cursor.last_id)
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const runs = ctx.tx.all<RunRow>(RUN_SELECT + where + ' ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?', [...values, limit + 1])
    const items = runs.slice(0, limit).map((run) => toRunSummary(ctx, run))
    const last = items.at(-1)
    const next = runs.length > limit && last
      ? encodeCursor(makeCursor('runs', scope, last.created_at, last.run_id, ctx.as_of_seq))
      : null
    return { items, next_cursor: next, as_of_seq: ctx.as_of_seq }
  })
}

export function getRun(db: Db, runId: string, options?: { includeAcceptanceArtifactIds?: boolean }): RunSummary {
  return withReadTx(db, (ctx) => {
    const run = ctx.tx.get<RunRow>(RUN_SELECT + ' WHERE r.run_id = ?', [runId])
    if (!run) throw new OrchError('NOT_FOUND', '没找到这次运行', { run_id: runId })
    const project_context = readProjectContextMetadata(ctx.tx, runId)
    const delivery_checks = readDeliveryChecks(ctx, runId, options?.includeAcceptanceArtifactIds === true)
    return { ...toRunSummary(ctx, run), ...(project_context ? { project_context } : {}), delivery_checks }
  })
}

export function readDeliveryChecks({ tx }: ReadCtx, runId: string, includeArtifactIds: boolean): NonNullable<RunSummary['delivery_checks']> {
  // Match the same confirmed plan and content hash that the acceptance writer uses.
  const bound = tx.get<{ plan_id: string; content_hash: string }>(`
    SELECT p.plan_id, p.content_hash FROM task_plans p JOIN start_run_operations o ON o.operation_id = p.launch_operation_id
    WHERE o.run_id = ? ORDER BY p.created_at, p.plan_id LIMIT 1`, [runId])
  if (!bound) return { has_more: false, items: [] }
  const rows = tx.all<Pick<RunDeliveryCheck, 'result_id' | 'kind' | 'outcome' | 'reason' | 'evaluated_at' | 'rule_version'> & { evidence_json: string }>(`
    SELECT result_id, kind, outcome, reason, evaluated_at, rule_version, evidence_json
    FROM run_acceptance_results WHERE run_id = ? AND plan_id = ? AND content_hash = ?
    ORDER BY deliverable_key LIMIT 51`, [runId, bound.plan_id, bound.content_hash])
  return { has_more: rows.length > 50, items: rows.slice(0, 50).map(({ evidence_json, ...row }) => {
    const value = (JSON.parse(evidence_json) as { evidence?: unknown } | null)?.evidence
    const evidence = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (row.kind === 'chat/text_result') {
      if (row.outcome === 'passed' && evidence.publication !== 'orchestra.chat-text.v1') {
        return { ...row, outcome: 'unverifiable' as const, reason: 'chat_text_result_not_exported' }
      }
      return { ...row,
        ...(typeof evidence.title === 'string' && { title: evidence.title }),
        ...(typeof evidence.file_name === 'string' && { file_name: evidence.file_name }),
        ...(isCount(evidence.item_index) && { item_index: evidence.item_index }),
        ...(includeArtifactIds && typeof evidence.artifact_id === 'string' && typeof evidence.sha256 === 'string'
          && { artifact_id: evidence.artifact_id, sha256: evidence.sha256 }) }
    }
    if (row.kind === 'artifact') return { ...row,
      ...(includeArtifactIds && typeof evidence.artifact_id === 'string' && { artifact_id: evidence.artifact_id }),
      ...(typeof evidence.file_name === 'string' && { file_name: evidence.file_name }),
      ...(isCount(evidence.minimum_bytes) && { minimum_bytes: evidence.minimum_bytes }),
      ...(isCount(evidence.bytes) && { bytes: evidence.bytes }) }
    return { ...row,
      ...(typeof evidence.tool === 'string' && { tool: evidence.tool }),
      ...(isInteger(evidence.expected_exit_code) && { expected_exit_code: evidence.expected_exit_code }),
      ...(Array.isArray(evidence.exit_codes) && { exit_codes: [...new Set(evidence.exit_codes.filter(isInteger))].slice(0, 20) }) }
  }) }
}

function isInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) }
function isCount(value: unknown): value is number { return isInteger(value) && value >= 0 }
