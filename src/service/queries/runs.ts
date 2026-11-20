import { OrchError } from '../../core/errors.ts'
import { TASK_ORIGINS, type TaskOrigin } from '../../core/task-workspace.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx, type ReadCtx } from './read-tx.ts'
import { readProjectContextMetadata, type ProjectContextMetadata } from '../project-shared-context.ts'

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

export type RunSummary = {
  run_id: string
  task_id: string
  task_title?: string | null
  workflow_id: string | null
  workflow_version: number | null
  status: string
  display_status: string
  settling: boolean
  revision: number
  counts: NodeRunCount[]
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
}

type RunRow = Record<string, unknown> & { run_id: string }

const RUN_SELECT = `SELECT r.run_id, r.task_id, r.workflow_id, r.workflow_version, r.status, r.revision, r.settling,
r.created_at, r.updated_at, r.started_at, r.ended_at, t.title AS task_title, o.due_at AS scheduled_for,
COALESCE(tr.kind, (SELECT CASE WHEN json_valid(e.payload_redacted) THEN json_extract(e.payload_redacted, '$.trigger_kind') END
  FROM events e WHERE e.run_id = r.run_id AND e.type IN ('task.created', 'task.run_started') ORDER BY e.seq LIMIT 1)) AS trigger_kind
FROM runs r JOIN tasks t ON t.task_id = r.task_id
LEFT JOIN task_trigger_occurrences o ON o.run_id = r.run_id LEFT JOIN task_triggers tr ON tr.trigger_id = o.trigger_id`

function toRunSummary(ctx: ReadCtx, run: RunRow): RunSummary {
  const runId = String(run.run_id)
  const counts = ctx.tx.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM node_runs WHERE run_id = ? GROUP BY status ORDER BY status', [runId],
  ).map((row) => ({ status: row.status, count: Number(row.n) }))
  const lastEvent = ctx.tx.get<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM events WHERE run_id = ?', [runId],
  )
  const nodes = ctx.tx.all<NodeRunPreview>(
    'SELECT node_run_id, node_id, node_type, attempt, status, revision, updated_at FROM node_runs '
    + 'WHERE run_id = ? ORDER BY updated_at DESC, node_run_id DESC LIMIT 10', [runId],
  )
  const status = String(run.status ?? '')
  return {
    run_id: runId,
    task_id: String(run.task_id ?? ''),
    task_title: typeof run.task_title === 'string' ? run.task_title : null,
    workflow_id: typeof run.workflow_id === 'string' ? run.workflow_id : null,
    workflow_version: typeof run.workflow_version === 'number' ? run.workflow_version : null,
    status,
    // Preserve the ledger's terminal distinctions; presentation can add labels without collapsing them.
    display_status: status,
    settling: Number(run.settling ?? 0) === 1,
    revision: Number(run.revision ?? 0),
    counts,
    total: counts.reduce((sum, row) => sum + row.count, 0),
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

export function getRun(db: Db, runId: string): RunSummary {
  return withReadTx(db, (ctx) => {
    const run = ctx.tx.get<RunRow>(RUN_SELECT + ' WHERE r.run_id = ?', [runId])
    if (!run) throw new OrchError('NOT_FOUND', '没找到这次运行', { run_id: runId })
    const project_context = readProjectContextMetadata(ctx.tx, runId)
    return { ...toRunSummary(ctx, run), ...(project_context ? { project_context } : {}) }
  })
}
