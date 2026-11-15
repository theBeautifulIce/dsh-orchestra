import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { CLOCK_DRIFT_TOLERANCE_MS, MonotonicClock, remainingAcrossBoot } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const NOW = '2026-11-13T03:00:00.000Z'

function clock(wall = 1_000_000, mono = 0) {
  return new MonotonicClock('boot-a', { wallClockMs: wall, monotonicNs: mono })
}

describe('单调时钟判定', () => {
  it('同一 boot、单调钟未到 → pending，剩余大于 0', () => {
    const c = clock()
    const d = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_000_000 + 60000 }, { bootId: 'boot-a', monotonicNs: 10e9, wallClockMs: 1_010_000 })
    expect(d).toEqual({ kind: 'pending', remainingMs: 50000 })
  })

  it('单调钟越过截止 → expired', () => {
    const c = clock()
    const d = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-a', monotonicNs: 60e9 + 1, wallClockMs: 1_060_000 })
    expect(d).toEqual({ kind: 'expired' })
  })

  it('墙钟向前跳十分钟、单调钟没动 → uncertain/clock_drift，不判 expired', () => {
    const c = clock()
    const drift = c.sample(1_600_000, 0)
    expect(drift).toBe(600000)
    const d = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-a', monotonicNs: 120e9, wallClockMs: 1_600_000 })
    expect(d).toEqual({ kind: 'uncertain', reason: 'clock_drift' })
  })

  it('墙钟向后跳十分钟同样判 uncertain', () => {
    const c = clock()
    c.sample(400_000, 0)
    const d = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-a', monotonicNs: 120e9, wallClockMs: 400_000 })
    expect(d).toEqual({ kind: 'uncertain', reason: 'clock_drift' })
  })

  it('漂移在容忍范围内时仍按单调钟判定', () => {
    const c = clock()
    c.sample(1_000_000 + CLOCK_DRIFT_TOLERANCE_MS, 0)
    const pending = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-a', monotonicNs: 10e9, wallClockMs: 1_010_000 })
    expect(pending.kind).toBe('pending')
    const expired = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-a', monotonicNs: 70e9, wallClockMs: 1_070_000 })
    expect(expired.kind).toBe('expired')
  })

  it('跨 boot → uncertain/boot_changed', () => {
    const c = clock()
    const d = c.decide({ bootId: 'boot-a', monotonicNs: 60e9, wallClockMs: 1_060_000 }, { bootId: 'boot-b', monotonicNs: 1, wallClockMs: 1_060_000 })
    expect(d).toEqual({ kind: 'uncertain', reason: 'boot_changed' })
  })
})

describe('跨 boot 预算', () => {
  const prev = { bootId: 'boot-a', lastEventMonotonicNs: 0, lastEventWallMs: 1_000_000, deadlineMonotonicNs: 60e9 }

  it('停机 20 秒 → 剩余 40 秒', () => {
    expect(remainingAcrossBoot(prev, { startedAtMs: 1_020_000, monotonicNs: 0 })).toBe(40000)
  })

  it('停机 90 秒 → 剩余 0', () => {
    expect(remainingAcrossBoot(prev, { startedAtMs: 1_090_000, monotonicNs: 0 })).toBe(0)
  })
})

describe('维护扫描可重入', () => {
  it('连跑两次：第二次 lease_expired 为空', () => {
    const { db } = freshLedger(); seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, lease_id, lease_expires_at, created_at, updated_at) VALUES ('nr_s', 'r1', 'n_s', 7, 'agent', 1, 'dispatched', 3, 'lease_x', ?, ?, ?)", [NOW, NOW, NOW])
    })
    const first = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z' , clock: TEST_CLOCK})
    expect(first.lease_expired).toEqual(['nr_s'])
    const third = sweep(db, TEST_SECRET, { now: '2026-11-13T03:20:00.000Z' , clock: TEST_CLOCK})
    expect(third.lease_expired).toEqual([])
    const row = db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='nr_s'").get() as { status: string }
    expect(row.status).toBe('stopping')
  })
})
