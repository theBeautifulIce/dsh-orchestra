// 事件分页：seq 升序、单页强一致、跨页不承诺同一快照；limit 上限 200（规格 8.3 行 637）
import { OrchError } from '../../core/errors.ts'
import { type Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

export const EVENTS_LIMIT_MAX = 200

export function listEventHistory(db: Db, opts: { beforeSeq?: number; runId?: string; taskId?: string; limit?: number }) {
  const limit = opts.limit ?? 40
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrchError('RANGE_TOO_LARGE', '活动记录每页 1 到 100 条')
  const before = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(before) || before < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '活动记录位置无效')
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const conditions = ['seq < ?']
    const params: unknown[] = [before]
    if (opts.runId) {
      conditions.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.taskId) {
      conditions.push(`(run_id IN (SELECT run_id FROM runs WHERE task_id = ?)
        OR (run_id IS NULL AND type LIKE 'task.%'
          AND CASE WHEN json_valid(payload_redacted) THEN json_extract(payload_redacted, '$.task_id') END = ?))`)
      params.push(opts.taskId, opts.taskId)
    }
    const rows = tx.all<{
      seq: number; event_id: string; type: string; occurred_at: string
      run_id: string | null; node_run_id: string | null; decision_id: string | null
    }>('SELECT seq, event_id, type, occurred_at, run_id, node_run_id, decision_id FROM events WHERE '
      + conditions.join(' AND ') + ' ORDER BY seq DESC LIMIT ?', [...params, limit + 1])
    const items = rows.slice(0, limit)
    return { items, next_before_seq: rows.length > limit ? items.at(-1)?.seq ?? null : null, as_of_seq }
  })
}

export function listEvents(db: Db, opts: { fromSeq?: number; limit?: number }): { rows: unknown[]; as_of_seq: number } {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > EVENTS_LIMIT_MAX) {
    throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(EVENTS_LIMIT_MAX) + ' 条', { limit })
  }
  const from = opts.fromSeq ?? 0
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const rows = tx.all(
      'SELECT seq, event_id, type, occurred_at, boot_id, monotonic_ns, run_id, node_run_id, decision_id, payload_redacted, payload_ref '
      + 'FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      [from, limit],
    )
    return { rows, as_of_seq }
  })
}
