// 事件分页：seq 升序、单页强一致、跨页不承诺同一快照；limit 上限 200（规格 8.3 行 637）
import { OrchError } from '../../core/errors.ts'
import { type Db } from '../../infra/sqlite/driver.ts'

export const EVENTS_LIMIT_MAX = 200

export function listEvents(db: Db, opts: { fromSeq?: number; limit?: number }): { rows: unknown[]; as_of_seq: number } {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > EVENTS_LIMIT_MAX) {
    throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(EVENTS_LIMIT_MAX) + ' 条', { limit })
  }
  const from = opts.fromSeq ?? 0
  const rows = db.raw.prepare(
    'SELECT seq, event_id, type, occurred_at, boot_id, monotonic_ns, run_id, node_run_id, decision_id, payload_redacted, payload_ref '
    + 'FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(from, limit)
  const head = db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }
  return { rows, as_of_seq: Number(head.seq) }
}
