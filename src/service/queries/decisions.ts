import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx } from './read-tx.ts'

const DECISIONS_LIMIT_MAX = 100

export type DecisionView = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  current_revision: number
  closed_reason: string | null
  payload: unknown
  content_hash: string | null
  expires_at: string | null
  confirm_required: boolean
  created_at: string
  decided_at: string | null
  // These fields are intentionally nullable until their policy is persisted by the command layer.
  priority: string | null
  priority_reason: string | null
  allowed_resolutions: string[] | null
  required_evidence: string[] | null
  target_summary: string | null
  projection_missing: string[]
}

type DecisionRow = Record<string, unknown> & {
  decision_id: string
  run_id: string
  created_at: string
}

export type ListDecisionParams = {
  run_id?: string
  status?: string
  limit?: number
  cursor?: string
  now?: number
}

function parsePayload(raw: unknown): { payload: unknown; missing: boolean } {
  if (typeof raw !== 'string') return { payload: null, missing: true }
  try { return { payload: JSON.parse(raw) as unknown, missing: false } } catch { return { payload: null, missing: true } }
}

function toDecisionView(row: DecisionRow): DecisionView {
  const parsed = parsePayload(row.payload_json)
  return {
    decision_id: row.decision_id,
    run_id: row.run_id,
    node_run_id: typeof row.node_run_id === 'string' ? row.node_run_id : null,
    kind: String(row.kind ?? ''),
    status: String(row.status ?? ''),
    current_revision: Number(row.revision ?? 0),
    closed_reason: typeof row.closed_reason === 'string' ? row.closed_reason : null,
    payload: parsed.payload,
    content_hash: typeof row.content_hash === 'string' ? row.content_hash : null,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    confirm_required: Number(row.confirm_required ?? 0) === 1,
    created_at: row.created_at,
    decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
    priority: null,
    priority_reason: null,
    allowed_resolutions: null,
    required_evidence: null,
    target_summary: null,
    projection_missing: [
      'priority', 'priority_reason', 'allowed_resolutions', 'required_evidence', 'target_summary',
      ...(parsed.missing ? ['payload'] : []),
    ],
  }
}

export function getDecisionSnapshot(db: Db, decisionId: string): { item: DecisionView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<DecisionRow>(
      'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, payload_json, content_hash, '
      + 'expires_at, confirm_required, created_at, decided_at FROM decisions WHERE decision_id = ?',
      [decisionId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这条裁决', { decision_id: decisionId })
    return { item: toDecisionView(row), as_of_seq: ctx.as_of_seq }
  })
}

export function listDecisions(db: Db, params: ListDecisionParams = {}): {
  items: DecisionView[]
  next_cursor: string | null
  as_of_seq: number
} {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > DECISIONS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(DECISIONS_LIMIT_MAX) + ' 条', { limit })
  const filter = { run_id: params.run_id ?? null, status: params.status ?? null }
  return withReadTx(db, (ctx) => {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.run_id) { where.push('run_id = ?'); values.push(filter.run_id) }
    if (filter.status) { where.push('status = ?'); values.push(filter.status) }
    else {
      where.push("status IN ('pending','acknowledged','blocked_for_human')")
    }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'decisions', filter, params.now)
      where.push('(created_at < ? OR (created_at = ? AND decision_id < ?))')
      values.push(cursor.last_key, cursor.last_key, cursor.last_id)
    }
    const rows = ctx.tx.all<DecisionRow>(
      'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, payload_json, content_hash, '
      + 'expires_at, confirm_required, created_at, decided_at FROM decisions'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY created_at DESC, decision_id DESC LIMIT ?',
      [...values, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = (hasMore ? rows.slice(0, limit) : rows).map(toDecisionView)
    const last = page[page.length - 1]
    const next_cursor = hasMore && last
      ? encodeCursor(makeCursor('decisions', filter, last.created_at, last.decision_id, ctx.as_of_seq, params.now))
      : null
    return { items: page, next_cursor, as_of_seq: ctx.as_of_seq }
  })
}
