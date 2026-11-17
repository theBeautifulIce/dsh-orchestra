import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx, type ReadCtx } from './read-tx.ts'

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
}

type RunRow = Record<string, unknown> & { run_id: string }

const RUN_SELECT = `SELECT run_id, task_id, workflow_id, workflow_version, status, revision, settling, created_at, updated_at
FROM runs`

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
  }
}

export function listRuns(db: Db, opts: { task_id?: string; limit?: number } = {}): { items: RunSummary[]; as_of_seq: number } {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > 100) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 100 条', { limit })
  return withReadTx(db, (ctx) => {
    const runs = opts.task_id
      ? ctx.tx.all<RunRow>(RUN_SELECT + ' WHERE task_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?', [opts.task_id, limit])
      : ctx.tx.all<RunRow>(RUN_SELECT + ' ORDER BY created_at DESC, run_id DESC LIMIT ?', [limit])
    return { items: runs.map((run) => toRunSummary(ctx, run)), as_of_seq: ctx.as_of_seq }
  })
}

export function getRun(db: Db, runId: string): RunSummary {
  return withReadTx(db, (ctx) => {
    const run = ctx.tx.get<RunRow>(RUN_SELECT + ' WHERE run_id = ?', [runId])
    if (!run) throw new OrchError('NOT_FOUND', '没找到这次运行', { run_id: runId })
    return toRunSummary(ctx, run)
  })
}
