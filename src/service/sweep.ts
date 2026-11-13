// src/service/sweep.ts —— 维护扫描（规格 4.9 行 426-429）
import type { Db } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'
import { sweepExpiredLeases } from './commands/lease.ts'

export type SweepResult = {
  lease_expired: string[]
  scanned_at: string
}

// 扫描必须可重入：重复跑不会产生第二份副作用
export function sweep(db: Db, secret: string, params: { now: string }): SweepResult {
  return inTx(db, (tx) => {
    const leaseExpired = sweepExpiredLeases(tx, secret, { now: params.now, leaseTtlMs: 0 })
    return { lease_expired: leaseExpired, scanned_at: params.now }
  })
}
