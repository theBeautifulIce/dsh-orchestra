import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { acquireLease } from '../src/service/commands/lease.ts'
import { applyCancel, pickReplayHead, markOlderAttemptsStale, revokeFence, type CancelResult } from '../src/service/commands/cancel.ts'

const NOW = '2026-11-13T03:00:00.000Z'

function setup() {
  const { db } = freshLedger(); seed(db)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_c', 'r1', 'n_c', 5, 'agent', 2, 'queued', 10, ?, ?)", [NOW, NOW])
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_c', ownerEpoch: 1, leaseTtlMs: 600000, now: NOW }))
  return db
}

const nodeRow = (db: any) => db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id='nr_c'").get() as any
const events = (db: any, type: string) => (db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nr_c' AND type=?").get(type) as { n: number }).n

function cancel(db: any, result: CancelResult, over: { graceMs?: number; extendDeadlineMs?: number; now?: string } = {}) {
  const row = nodeRow(db)
  return withTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
    nodeRunId: 'nr_c', attempt: row.attempt, revision: row.revision, cancelResult: result,
    now: over.now ?? NOW, graceMs: over.graceMs ?? 30000, extendDeadlineMs: over.extendDeadlineMs,
  }))
}

describe('取消四值与围栏', () => {
  it('interrupted → timing_out + fence armed，宽限到点等于 now 加宽限', () => {
    const db = setup()
    const out = cancel(db, 'interrupted', { graceMs: 30000 })
    expect(out).toEqual({ cancel_result: 'interrupted', next_status: 'timing_out', fence_state: 'armed', reason: 'cancel_confirmed' })
    const row = nodeRow(db)
    expect(row.status).toBe('timing_out')
    expect(row.fence_state).toBe('armed')
    expect(row.fence_armed_at).toBe(NOW)
    expect(row.fence_grace_until).toBe('2026-11-13T03:00:30.000Z')
    expect(events(db, 'fence_armed')).toBe(1)
  })

  it('not_interruptible → stopping，fence 仍为 null，deadline 被延长', () => {
    const db = setup()
    cancel(db, 'not_interruptible', { extendDeadlineMs: 120000 })
    const row = nodeRow(db)
    expect(row.status).toBe('stopping')
    expect(row.fence_state).toBeNull()
    expect(row.deadline_at).toBe('2026-11-13T03:02:00.000Z')
    expect(events(db, 'cancel_not_interruptible')).toBe(1)
  })

  it('already_stopped → 不进 timing_out，fence 为 null', () => {
    const db = setup()
    cancel(db, 'already_stopped')
    const row = nodeRow(db)
    expect(row.status).not.toBe('timing_out')
    expect(row.fence_state).toBeNull()
    expect(row.cancel_result).toBe('already_stopped')
  })

  it('unknown → stopping，fence 为 null', () => {
    const db = setup()
    const out = cancel(db, 'unknown')
    expect(out.next_status).toBe('stopping')
    const row = nodeRow(db)
    expect(row.status).toBe('stopping')
    expect(row.fence_state).toBeNull()
    expect(events(db, 'cancel_unknown')).toBe(1)
  })

  it('取消后 attempt 不变（取消不产生新 attempt）', () => {
    const db = setup()
    const before = nodeRow(db).attempt
    cancel(db, 'interrupted')
    expect(nodeRow(db).attempt).toBe(before)
  })
})

describe('围栏撤销与排队重放', () => {
  it('armed 且 timing_out → 回 stopping、fence revoked', () => {
    const db = setup()
    cancel(db, 'interrupted')
    const before = nodeRow(db)
    const changed = withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row: before, now: '2026-11-13T03:01:00.000Z' }))
    expect(changed).toBe(true)
    const row = nodeRow(db)
    expect(row.status).toBe('stopping')
    expect(row.fence_state).toBe('revoked')
    expect(row.fence_grace_until).toBeNull()
    expect(events(db, 'fence_revoked')).toBe(1)
  })

  it('fence 不是 armed → 不动数据', () => {
    const db = setup()
    const before = nodeRow(db)
    const changed = withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row: before, now: NOW }))
    expect(changed).toBe(false)
    expect(nodeRow(db).revision).toBe(before.revision)
    expect(events(db, 'fence_revoked')).toBe(0)
  })

  it('pickReplayHead 只取当前 attempt 里 report_seq 最小的 rejected', () => {
    const db = setup()
    withTx(db, (tx) => {
      for (const [id, attempt, seq] of [['rep_b', 2, 2], ['rep_a', 2, 1], ['rep_old', 1, 0]] as const) {
        tx.run("INSERT INTO report_registry (report_id, node_run_id, attempt, state, report_seq, created_at, updated_at) VALUES (?, 'nr_c', ?, 'rejected', ?, ?, ?)", [id, attempt, seq, NOW, NOW])
      }
    })
    const head = withTx(db, (tx) => pickReplayHead(tx, 'nr_c', 2))
    expect(head).toEqual({ report_id: 'rep_a', report_seq: 1 })
  })

  it('markOlderAttemptsStale 把旧 attempt 的 rejected 标 stale，当前 attempt 不动', () => {
    const db = setup()
    withTx(db, (tx) => {
      for (const [id, attempt] of [['rep_old', 1], ['rep_new', 2]] as const) {
        tx.run("INSERT INTO report_registry (report_id, node_run_id, attempt, state, report_seq, created_at, updated_at) VALUES (?, 'nr_c', ?, 'rejected', 0, ?, ?)", [id, attempt, NOW, NOW])
      }
    })
    const n = withTx(db, (tx) => markOlderAttemptsStale(tx, { nodeRunId: 'nr_c', currentAttempt: 2, now: NOW }))
    expect(n).toBe(1)
    const state = (id: string) => (db.raw.prepare('SELECT state FROM report_registry WHERE report_id=?').get(id) as { state: string }).state
    expect(state('rep_old')).toBe('stale')
    expect(state('rep_new')).toBe('rejected')
  })
})
