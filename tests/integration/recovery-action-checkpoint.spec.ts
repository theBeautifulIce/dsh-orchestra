// P1-2026-11-16-01：写截止锚点必须同时写恢复检查点，否则重启后被误判不确定
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'
import { confirmStartup } from '../../src/service/commands/confirm-start.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import type { CancelOutcome } from '../../src/service/commands/cancel.ts'

const NOW = '2026-11-16T05:00:00.000Z'

function insertNode(db: Db, id: string, status: string, patch: Record<string, string | number | null>): void {
  const cols = ['node_run_id', 'run_id', 'node_id', 'seq', 'node_type', 'attempt', 'status', 'revision', 'created_at', 'updated_at', ...Object.keys(patch)]
  const values = [id, 'r1', id, 20, 'agent', 1, status, 0, NOW, NOW, ...Object.values(patch)]
  withTx(db, (tx) => {
    tx.run('INSERT INTO node_runs (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')', values)
  })
}

const nodeOf = (db: Db, id: string) =>
  db.raw.prepare('SELECT status, action_remaining_ns, recovery_uncertain, hang_reason FROM node_runs WHERE node_run_id = ?').get(id) as
    { status: string; action_remaining_ns: number | null; recovery_uncertain: string | null; hang_reason: string | null }

const events = (db: Db, id: string, type: string): number =>
  Number((db.raw.prepare('SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?').get(id, type) as { n: number }).n)

describe('动作截止的恢复检查点', () => {
  it('确认启动转入 stopping：检查点与锚点同笔落库，重启按检查点续算而不是判不确定', () => {
    const { db } = freshLedger()
    seed(db)
    insertNode(db, 'nr_su', 'startup_unknown', {
      startup_unknown_deadline_at: '2026-11-16T05:02:00.000Z',
      startup_unknown_boot_id: 'boot_a',
      startup_unknown_monotonic_ns: 1000,
      startup_unknown_remaining_ns: 120_000 * 1e6,
    })
    const clockA = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr_su', attempt: 1, clock: clockA, actionDeadlineMs: 30_000, now: NOW })
    expect(nodeOf(db, 'nr_su').status).toBe('stopping')
    expect(nodeOf(db, 'nr_su').action_remaining_ns).toBe(30_000 * 1e6)

    // 重启：新 boot 只能靠检查点续算；旧行为会在这里落 timer_uncertain 并把节点钉死
    const clockB = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW) + 600_000, monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock: clockB })
    expect(out.deadline_uncertain).not.toContain('nr_su')
    expect(nodeOf(db, 'nr_su').recovery_uncertain).toBeNull()
    expect(events(db, 'nr_su', 'timer_uncertain')).toBe(0)
    expect(events(db, 'nr_su', 'deadline.reanchored')).toBe(1)
    db.raw.close()
  })

  it('取消判为停不下来（无围栏）：同样落检查点，重启不判不确定', () => {
    const { db } = freshLedger()
    seed(db)
    insertNode(db, 'nr_ni', 'started', {})
    const clockA = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const outcome: CancelOutcome = withTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
      nodeRunId: 'nr_ni',
      attempt: 1,
      revision: 0,
      cancelResult: 'not_interruptible',
      graceMs: 0,
      extendDeadlineMs: 45_000,
      now: NOW,
      clock: clockA,
    }))
    expect(outcome.next_status).toBe('stopping')
    expect(nodeOf(db, 'nr_ni').action_remaining_ns).toBe(45_000 * 1e6)

    const clockB = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW) + 600_000, monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock: clockB })
    expect(out.deadline_uncertain).not.toContain('nr_ni')
    expect(nodeOf(db, 'nr_ni').recovery_uncertain).toBeNull()
    db.raw.close()
  })

  it('检查点为空的旧行：扫描按锚点补上剩余量，不再跳过', () => {
    const { db } = freshLedger()
    seed(db)
    insertNode(db, 'nr_null', 'stopping', {
      deadline_at: '2026-11-16T05:00:30.000Z',
      deadline_boot_id: 'boot_a',
      deadline_monotonic_ns: 30_000_000_000,
      action_remaining_ns: null,
    })
    const clockA = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 10_000_000_000 })
    sweep(db, TEST_SECRET, { now: NOW, clock: clockA })
    // 锚点 30s - 已过 10s = 20s
    expect(nodeOf(db, 'nr_null').action_remaining_ns).toBe(20_000_000_000)
    db.raw.close()
  })
})
