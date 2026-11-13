import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import {
  acquireLease, assertLeaseValid, loadNodeRun, releaseLease, renewLease, sweepExpiredLeases,
} from '../src/service/commands/lease.ts'

const NOW = '2026-11-13T01:00:00.000Z'

function insertNodeRun(db: any, id: string, status: string, over: { leaseExpiresAt?: string | null; revision?: number; attempt?: number } = {}) {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, lease_id, lease_expires_at, created_at, updated_at) VALUES (?, 'r1', ?, 2, 'agent', ?, ?, ?, ?, ?, ?, ?)",
      [id, id, over.attempt ?? 1, status, over.revision ?? 4, over.leaseExpiresAt ? 'lease_x' : null, over.leaseExpiresAt ?? null, NOW, NOW],
    )
  })
}

describe('租约与心跳', () => {
  it('queued 时获取租约：返回 leaseId/expiresAt/Ga=1，状态 → dispatched，leases 多一行', () => {
    const { db } = freshLedger(); seed(db)
    insertNodeRun(db, 'nr_q', 'queued')
    const out = withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_q', ownerEpoch: 7, leaseTtlMs: 30000, now: NOW }))
    expect(out.leaseId.startsWith('lease_')).toBe(true)
    expect(out.expiresAt).toBe('2026-11-13T01:00:30.000Z')
    expect(out.actionGeneration).toBe(1)
    const row = loadNodeRun(withTx(db, (tx) => tx), 'nr_q')
    expect(row.status).toBe('dispatched')
    expect(row.lease_id).toBe(out.leaseId)
    expect(row.owner_epoch).toBe(7)
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n)).toBe(1)
    const ev = db.raw.prepare("SELECT type, payload FROM node_run_events WHERE node_run_id='nr_q' ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string }
    expect(ev.type).toBe('lease_acquired')
    expect(JSON.parse(ev.payload).action_generation).toBe(1)
  })

  it('已在 started 时获取 → STALE_GENERATION 且 details.status=started', () => {
    const { db } = freshLedger(); seed(db)
    insertNodeRun(db, 'nr_s', 'started')
    try {
      withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_s', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
      expect.unreachable()
    } catch (e: any) {
      expect(e.code).toBe('STALE_GENERATION')
      expect(e.details.status).toBe('started')
    }
  })

  it('续期：expires_at 变长、heartbeat_at 落在当下、Ga 不变', () => {
    const { db } = freshLedger(); seed(db)
    insertNodeRun(db, 'nr_r', 'queued')
    const acq = withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_r', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    const later = '2026-11-13T01:00:10.000Z'
    const exp = withTx(db, (tx) => renewLease(tx, { nodeRunId: 'nr_r', leaseTtlMs: 30000, now: later }))
    expect(Date.parse(exp)).toBeGreaterThan(Date.parse(acq.expiresAt))
    const row = loadNodeRun(withTx(db, (tx) => tx), 'nr_r')
    expect(row.heartbeat_at).toBe(later)
    expect(row.action_generation).toBe(1)
  })

  it('assertLeaseValid：已过期 → LEASE_EXPIRED 且 proposed=true；未过期通过', () => {
    const valid = { node_run_id: 'x', lease_expires_at: '2026-11-13T01:00:30.000Z' } as any
    expect(() => assertLeaseValid(valid, NOW)).not.toThrow()
    try {
      assertLeaseValid(valid, '2026-11-13T01:00:30.000Z')
      expect.unreachable()
    } catch (e: any) {
      expect(e.code).toBe('LEASE_EXPIRED')
      expect(e.details.proposed).toBe(true)
    }
  })

  it('过期扫描：dispatched → stopping、started → startup_unknown，事件带 reason', () => {
    const { db } = freshLedger(); seed(db)
    const past = '2026-11-13T00:59:00.000Z'
    insertNodeRun(db, 'nr_d', 'dispatched', { leaseExpiresAt: past })
    insertNodeRun(db, 'nr_st', 'started', { leaseExpiresAt: past })
    const touched = withTx(db, (tx) => sweepExpiredLeases(tx, TEST_SECRET, { now: NOW, leaseTtlMs: 30000 }))
    expect(touched.sort()).toEqual(['nr_d', 'nr_st'])
    expect(loadNodeRun(withTx(db, (tx) => tx), 'nr_d').status).toBe('stopping')
    expect(loadNodeRun(withTx(db, (tx) => tx), 'nr_st').status).toBe('startup_unknown')
    for (const id of ['nr_d', 'nr_st']) {
      const ev = db.raw.prepare("SELECT type, payload FROM node_run_events WHERE node_run_id=? ORDER BY seq DESC LIMIT 1").get(id) as { type: string; payload: string }
      expect(ev.type).toBe('lease_expired')
      expect(JSON.parse(ev.payload).reason).toBe('lease_expired')
    }
  })

  it('未过期租约不动：状态与 revision 不变', () => {
    const { db } = freshLedger(); seed(db)
    insertNodeRun(db, 'nr_ok', 'dispatched', { leaseExpiresAt: '2026-11-13T02:00:00.000Z' })
    const before = loadNodeRun(withTx(db, (tx) => tx), 'nr_ok')
    expect(withTx(db, (tx) => sweepExpiredLeases(tx, TEST_SECRET, { now: NOW, leaseTtlMs: 30000 }))).toEqual([])
    const after = loadNodeRun(withTx(db, (tx) => tx), 'nr_ok')
    expect(after.status).toBe(before.status)
    expect(after.revision).toBe(before.revision)
  })

  it('releaseLease 把租约交回：lease_id 清空、leases.expires_at 收敛到现在', () => {
    const { db } = freshLedger(); seed(db)
    insertNodeRun(db, 'nr_rel', 'queued')
    const acq = withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_rel', ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
    withTx(db, (tx) => releaseLease(tx, { nodeRunId: 'nr_rel', now: '2026-11-13T01:00:05.000Z' }))
    const row = loadNodeRun(withTx(db, (tx) => tx), 'nr_rel')
    expect(row.lease_id).toBeNull()
    const lease = db.raw.prepare('SELECT expires_at FROM leases WHERE lease_id=?').get(acq.leaseId) as { expires_at: string }
    expect(lease.expires_at).toBe('2026-11-13T01:00:05.000Z')
  })
})
