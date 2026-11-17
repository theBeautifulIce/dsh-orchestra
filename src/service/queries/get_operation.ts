// 回执查询：按 operation_id 取 inbox 行；过期回执报 OPERATION_EXPIRED（规格 8.4）
import { OrchError } from '../../core/errors.ts'
import { type Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

export type OperationRow = {
  operation_id: string
  kind: string
  status: string
  receipt_json: string | null
  created_at: string
  completed_at: string | null
  receipt_expired_at: string | null
}

export function getOperation(db: Db, operationId: string, now = new Date()): OperationRow {
  const row = db.raw.prepare(
    'SELECT operation_id, kind, status, receipt_json, created_at, completed_at, receipt_expired_at FROM inbox WHERE operation_id = ?')
    .get(operationId) as OperationRow | undefined
  if (!row) throw new OrchError('NOT_FOUND', '没有这条回执', { operation_id: operationId })
  if (row.receipt_expired_at && new Date(row.receipt_expired_at).getTime() <= now.getTime()) {
    throw new OrchError('OPERATION_EXPIRED', '回执已过期', { operation_id: operationId })
  }
  return row
}

const COMPLETED_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RUNNING_RECEIPT_TTL_MS = 10 * 60 * 1000

export function getOperationSnapshot(db: Db, operationId: string, now = Date.now()): { item: OperationRow; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<OperationRow>(
      'SELECT operation_id, kind, status, receipt_json, created_at, completed_at, receipt_expired_at FROM inbox WHERE operation_id = ?',
      [operationId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没有这条回执', { operation_id: operationId })
    const explicitExpiry = row.receipt_expired_at === null ? Number.NaN : Date.parse(row.receipt_expired_at)
    const anchor = row.completed_at ?? row.created_at
    const anchorTime = Date.parse(anchor)
    const ttl = row.completed_at === null ? RUNNING_RECEIPT_TTL_MS : COMPLETED_RECEIPT_TTL_MS
    const ageExpired = Number.isFinite(anchorTime) && now >= anchorTime + ttl
    const explicitlyExpired = Number.isFinite(explicitExpiry) && now >= explicitExpiry
    if (ageExpired || explicitlyExpired) {
      throw new OrchError('OPERATION_EXPIRED', '回执已过期', { operation_id: operationId })
    }
    return { item: row, as_of_seq: ctx.as_of_seq }
  })
}
