// 业务侧事务封装与 CAS 辅助：所有状态迁移用 UPDATE … WHERE <条件>，受影响行数必须恰为期望（总纲 4.4、规格不变量 I3）
import { OrchError } from '../../core/errors.ts'
import { type Db, type Tx, withTx } from '../sqlite/driver.ts'

export function runCas(tx: Tx, sql: string, params: unknown[], expected: { rows: number; what: string }): void {
  const res = tx.run(sql, params)
  if (res.changes !== expected.rows) {
    throw new OrchError('STALE_GENERATION', 'CAS 没命中，条件不满足', { what: expected.what, changes: res.changes })
  }
}

export function inTx<T>(db: Db, fn: (tx: Tx) => T): T {
  return withTx(db, fn)
}
