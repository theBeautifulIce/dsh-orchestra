// 账本校验：重算每个 node_run 的哈希链，返回第一个断点；完好时给链数与条目数
import { type Db } from '../../infra/sqlite/driver.ts'
import { type ChainRow } from '../../core/hash-chain.ts'
import { chainBreakOf } from '../../infra/db/ledger.ts'

export type LedgerVerify = {
  ok: boolean
  chains: number
  entries: number
  break: { node_run_id: string; seq: number; reason: string } | null
}

export function verifyLedger(db: Db, secret: string): LedgerVerify {
  const ids = db.raw.prepare('SELECT DISTINCT node_run_id FROM node_run_events').all() as { node_run_id: string }[]
  let entries = 0
  for (const { node_run_id } of ids) {
    const rows = db.raw.prepare(
      'SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC')
      .all(node_run_id) as ChainRow[]
    entries += rows.length
    const brk = chainBreakOf(secret, rows)
    if (brk) return { ok: false, chains: ids.length, entries, break: brk }
  }
  return { ok: true, chains: ids.length, entries, break: null }
}
