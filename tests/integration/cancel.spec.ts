import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { applyCancel, pickReplayHead, markOlderAttemptsStale, revokeFence, type CancelResult } from '../../src/service/commands/cancel.ts'
import { ScriptedClock } from '../../src/core/clock.ts'

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

  it('围栏宽限按单调锚点判：墙钟跳远不撤围栏，单调钟到点才撤', () => {
    const db = setup()
    const clock = new ScriptedClock('boot-c', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const row = nodeRow(db)
    withTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
      nodeRunId: 'nr_c', attempt: row.attempt, revision: row.revision, cancelResult: 'interrupted',
      now: NOW, graceMs: 30_000, clock,
    }))
    const armed = nodeRow(db)
    expect(armed).toMatchObject({ fence_grace_boot_id: 'boot-c', fence_grace_monotonic_ns: 30_000_000_000 })
    const wallJump = '2026-11-13T06:00:00.000Z'
    expect(withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row: armed, now: wallJump, clock }))).toBe(false)
    clock.advanceMs(30_500)
    clock.setWallClockMs(clock.sample().wallClockMs + 30_500)
    expect(withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row: armed, now: wallJump, clock }))).toBe(true)
    expect(nodeRow(db)).toMatchObject({
      status: 'stopping', fence_state: 'revoked',
      fence_grace_boot_id: null, fence_grace_monotonic_ns: null,
    })
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

describe('取消边界（审计 N-08 / P0-4）', () => {
  it('queued 取消直接变 superseded，不进围栏', () => {
    const { db } = freshLedger(); seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_c', 'r1', 'n_c', 5, 'agent', 2, 'queued', 10, ?, ?)", [NOW, NOW])
    })
    const out = withTx(db, (tx) => applyCancel(tx, TEST_SECRET, { nodeRunId: 'nr_c', attempt: 2, revision: 10, cancelResult: 'unknown', now: NOW, graceMs: 30000 }))
    expect(out.next_status).toBe('superseded')
    expect(out.reason).toBe('cancelled_before_dispatch')
    expect(nodeRow(db).status).toBe('superseded')
    expect(nodeRow(db).fence_state).toBeNull()
    expect(events(db, 'cancel_before_dispatch')).toBe(1)
  })

  it('围栏立着时收到 unknown：不改状态，宽限到点撤围栏回 stopping', () => {
    const db = setup()
    cancel(db, 'interrupted')
    const out = cancel(db, 'unknown')
    expect(out.next_status).toBe('timing_out')
    expect(out.fence_state).toBe('armed')
    expect(out.reason).toBe('fence_pending')
    expect(nodeRow(db).status).toBe('timing_out')
    expect(nodeRow(db).cancel_result).toBe('unknown')
    const row = nodeRow(db)
    const changed = withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row, now: '2026-11-13T03:01:00.000Z' }))
    expect(changed).toBe(true)
    expect(nodeRow(db).status).toBe('stopping')
    expect(nodeRow(db).fence_state).toBe('revoked')
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

describe('终态与重复取消（审计 F-07 / P12）', () => {
  it('done 节点被取消：already_stopped，status 保持 done', () => {
    const db = setup()
    db.raw.prepare("UPDATE node_runs SET status='done' WHERE node_run_id='nr_c'").run()
    const out = cancel(db, 'interrupted')
    expect(out.cancel_result).toBe('already_stopped')
    expect(out.reason).toBe('terminal_no_out_edge')
    expect(nodeRow(db).status).toBe('done')
    expect(nodeRow(db).fence_state).toBeNull()
    expect(events(db, 'fence_armed')).toBe(0)
  })

  it('围栏已 armed 再取消：fence_already_armed，不再 arm 一次', () => {
    const db = setup()
    cancel(db, 'interrupted')
    const out = cancel(db, 'interrupted')
    expect(out.reason).toBe('fence_already_armed')
    expect(events(db, 'fence_armed')).toBe(1)
  })

  it('宽限没到点不许撤销围栏', () => {
    const db = setup()
    cancel(db, 'interrupted')
    const row = nodeRow(db)
    const ok = withTx(db, (tx) => revokeFence(tx, TEST_SECRET, { row, now: '2026-11-13T03:00:10.000Z' }))
    expect(ok).toBe(false)
    expect(nodeRow(db).status).toBe('timing_out')
  })

  it('撤销围栏后取队头：同一 attempt 最小 report_seq', () => {
    const db = setup()
    db.raw.prepare("INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES ('r2','nr_c',2,7,'rejected',?,?)").run(NOW, NOW)
    db.raw.prepare("INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES ('r1','nr_c',2,3,'rejected',?,?)").run(NOW, NOW)
    const head = withTx(db, (tx) => pickReplayHead(tx, 'nr_c', 2))
    expect(head).toEqual({ report_id: 'r1', report_seq: 3 })
  })
})
