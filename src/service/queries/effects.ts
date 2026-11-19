import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { UNVERIFIED_EFFECT } from '../../infra/db/unverified-effects.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx } from './read-tx.ts'

const EFFECTS_LIMIT_MAX = 100

export type UnverifiedEffectView = {
  run_id: string
  node_run_id: string
  node_id: string
  status: string
  side_effect_policy: string
  side_effect_verified_none: false
  stop_evidence: string | null
  started_at: string | null
  created_at: string
  age_seconds: number | null
  resolved: false
  resolved_at: null
  resolution_basis: null
  // 实际停止时间只取宿主对账的观察记录。取消请求和签认均不供推断。
  stopped_at?: string | null
  last_known_phase?: string | null
  evidence?: string | null
  decision_id?: string | null
}

export type ListEffectsParams = { run_id?: string; limit?: number; cursor?: string; now?: number }

type EffectRow = Record<string, unknown> & { node_run_id: string; run_id: string }

function ageSeconds(row: EffectRow, now: number): number | null {
  const anchor = typeof row.started_at === 'string' ? row.started_at : String(row.created_at ?? '')
  const parsed = Date.parse(anchor)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null
}

export function listUnverifiedEffects(db: Db, params: ListEffectsParams = {}): {
  items: UnverifiedEffectView[]
  next_cursor: string | null
  as_of_seq: number
} {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > EFFECTS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(EFFECTS_LIMIT_MAX) + ' 条', { limit })
  const filter = { run_id: params.run_id ?? null }

  return withReadTx(db, (ctx) => {
    const where = [UNVERIFIED_EFFECT]
    const values: unknown[] = []
    if (filter.run_id) {
      where.push('n.run_id = ?')
      values.push(filter.run_id)
    }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'effects', filter)
      where.push('(COALESCE(n.started_at, n.created_at) < ? OR (COALESCE(n.started_at, n.created_at) = ? AND n.node_run_id < ?))')
      values.push(cursor.last_key, cursor.last_key, cursor.last_id)
    }
    const rows = ctx.tx.all<EffectRow>(
      'SELECT n.run_id, n.node_run_id, n.node_id, n.status, n.side_effect_policy, n.side_effect_verified_none, '
      + 'n.stop_evidence, n.started_at, n.created_at, m.stopped_at, m.evidence_id, '
      + 'COALESCE(m.abandon_ack_id, m.decision_id, n.contradiction_decision_id, (SELECT d.decision_id FROM decisions d '
      + 'WHERE d.run_id = n.run_id AND d.node_run_id = n.node_run_id '
      + "AND d.kind IN ('verify_human','action_overrun','abandon_ack','report_contradicted') "
      + 'ORDER BY d.created_at DESC, d.decision_id DESC LIMIT 1)) AS decision_id '
      + 'FROM node_runs n LEFT JOIN memory_write_recoveries m ON m.node_run_id = n.node_run_id '
      + 'WHERE ' + where.join(' AND ')
      + ' ORDER BY COALESCE(n.started_at, n.created_at) DESC, n.node_run_id DESC LIMIT ?',
      [...values, limit + 1],
    )
    const now = params.now ?? Date.now()
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((row): UnverifiedEffectView => ({
      run_id: row.run_id,
      node_run_id: row.node_run_id,
      node_id: String(row.node_id ?? ''),
      status: String(row.status ?? ''),
      side_effect_policy: String(row.side_effect_policy ?? ''),
      side_effect_verified_none: false,
      stop_evidence: typeof row.stop_evidence === 'string' ? row.stop_evidence : null,
      started_at: typeof row.started_at === 'string' ? row.started_at : null,
      created_at: String(row.created_at ?? ''),
      age_seconds: ageSeconds(row, now),
      resolved: false,
      resolved_at: null,
      resolution_basis: null,
      stopped_at: typeof row.stopped_at === 'string' ? row.stopped_at : null,
      last_known_phase: null,
      evidence: typeof row.evidence_id === 'string' ? row.evidence_id : null,
      decision_id: typeof row.decision_id === 'string' ? row.decision_id : null,
    }))
    const lastRow = page[page.length - 1]
    const cursor = hasMore && lastRow
      ? encodeCursor(makeCursor('effects', filter, String(lastRow.started_at ?? lastRow.created_at), lastRow.node_run_id, ctx.as_of_seq, now))
      : null
    return { items, next_cursor: cursor, as_of_seq: ctx.as_of_seq }
  })
}
