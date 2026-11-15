import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDb, type Db } from '../../src/infra/sqlite/driver.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const LATER = '2026-11-13T03:10:00.000Z'

function row(db: Db, id: string) {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(id) as Record<string, any>
}

function events(db: Db, id: string, type: string): number {
  return Number((db.raw.prepare('SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?').get(id, type) as { n: number }).n)
}

describe('跨服务实例的截止锚点恢复（S3 round13 P1）', () => {
  it('动作截止：旧 boot 的锚点在重启后换算成新锚点，到点照常开卡', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_act','r1','n_act',2,'agent',1,'stopping',0,?, 'boot_a', 1000000000, ?, ?)", [NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: LATER, clock })
    expect(out.action_overrun).toContain('nr_act')
    const r = row(db, 'nr_act')
    expect(r.deadline_boot_id).toBe('boot_b')
    expect(r.hang_reason).toBe('action_overrun')
    expect(events(db, 'nr_act', 'deadline.reanchored')).toBe(1)
  })

  it('取消宽限：停机不累计，重启后给满额；到点撤围栏', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',3,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const first = sweep(db, TEST_SECRET, { now: LATER, clock })
    expect(first.replay_heads.map((h) => h.node_run_id)).not.toContain('nr_fen')
    expect(row(db, 'nr_fen').fence_state).toBe('armed')
    clock.advanceMs(31_000)
    clock.setWallClockMs(clock.sample().wallClockMs + 31_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(db, 'nr_fen').fence_state).toBe('revoked')
    expect(row(db, 'nr_fen').status).toBe('stopping')
  })

  it('wait 计时：重启后按新锚点判到点，不永久 waiting', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, wait_deadline_at, wait_deadline_boot_id, wait_deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_wait','r1','n_wait',4,'wait',1,'waiting',0,?, 'boot_a', 1000000000, ?, ?)", [NOW, NOW, NOW])
    })
    withTx(db, (tx) => {
      tx.run("INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, queued_at, created_at, updated_at) VALUES ('nr_wait','r1','timer','{}',0,0,'k_wait','active',?,?,?)", [NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: LATER, clock })
    expect(row(db, 'nr_wait').status).not.toBe('waiting')
    expect(events(db, 'nr_wait', 'deadline.reanchored')).toBe(1)
  })

  it('真实关库重开：新实例的扫描能推进旧实例留下的围栏', () => {
    const { file, db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',5,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    db.raw.close()
    const reopened = openDb(file)
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(reopened, TEST_SECRET, { now: LATER, clock })
    expect(row(reopened, 'nr_fen').fence_grace_boot_id).toBe('boot_b')
    clock.advanceMs(31_000)
    clock.setWallClockMs(clock.sample().wallClockMs + 31_000)
    sweep(reopened, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(reopened, 'nr_fen').fence_state).toBe('revoked')
    reopened.raw.close()
  })
})
