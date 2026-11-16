// 断链节点的执行侧闸门：租约是进入执行链的唯一入口（评审 P1-1）
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { OrchError } from '../../src/core/errors.ts'

const NOW = '2026-11-16T04:00:00.000Z'

function insertQueued(db: Db, id: string): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'r1', ?, ?, 'agent', 1, 'queued', 0, ?, ?)",
      [id, id, id === 'nr_q' ? 10 : 11, NOW, NOW],
    )
  })
}

/** 打断哈希链：事件表只追加，只能卸触发器后改内容 */
function breakChain(db: Db, nodeRunId: string): void {
  withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, nodeRunId, 'started', { seed: true }))
  for (const t of ['trg_node_run_events_no_update', 'trg_node_run_events_chain_guard', 'trg_node_run_chain_heads_update_guard']) {
    db.raw.exec('DROP TRIGGER IF EXISTS ' + t)
  }
  db.raw.prepare("UPDATE node_run_events SET hash = 'tampered' WHERE node_run_id = ?").run(nodeRunId)
}

const statusOf = (db: Db, id: string): string =>
  (db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get(id) as { status: string }).status

const leaseCount = (db: Db, id: string): number =>
  Number((db.raw.prepare('SELECT COUNT(*) AS n FROM leases WHERE node_run_id = ?').get(id) as { n: number }).n)

describe('断链节点不许被派发执行', () => {
  it('链断的 queued 节点拿不到租约：不改状态、不建租约、不追加事件', () => {
    const { db } = freshLedger()
    seed(db)
    insertQueued(db, 'nr_q')
    breakChain(db, 'nr_q')
    const eventsBefore = Number((db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr_q'").get() as { n: number }).n)

    let code = ''
    try {
      withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_q', ownerEpoch: 1, leaseTtlMs: 30_000, now: NOW }))
    } catch (err) {
      code = err instanceof OrchError ? err.code : 'unknown'
      expect((err as OrchError).details).toMatchObject({ reason: 'chain_broken' })
    }
    expect(code).toBe('FORBIDDEN')
    expect(statusOf(db, 'nr_q')).toBe('queued')
    expect(leaseCount(db, 'nr_q')).toBe(0)
    expect(Number((db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr_q'").get() as { n: number }).n)).toBe(eventsBefore)
    db.raw.close()
  })

  it('同批健康节点照常拿租约：闸门只拦断链的那一条', () => {
    const { db } = freshLedger()
    seed(db)
    insertQueued(db, 'nr_q')
    insertQueued(db, 'nr_ok')
    breakChain(db, 'nr_q')

    const out = withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_ok', ownerEpoch: 1, leaseTtlMs: 30_000, now: NOW }))
    expect(out.leaseId.startsWith('lease_')).toBe(true)
    expect(statusOf(db, 'nr_ok')).toBe('dispatched')
    expect(leaseCount(db, 'nr_ok')).toBe(1)
    db.raw.close()
  })
})
