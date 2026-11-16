// 恢复不确定：宿主可查、可确认（评审 P2-4）
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'
import { inTx } from '../../src/infra/db/tx.ts'
import { listRecoveryUncertain } from '../../src/service/queries/recovery.ts'
import { resolveRecoveryUncertain } from '../../src/service/commands/recovery.ts'
import { OrchError } from '../../src/core/errors.ts'

const NOW = '2026-11-16T03:00:00.000Z'

function insertUncertainWait(db: Db): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, wait_started_at, wait_deadline_at, wait_deadline_boot_id, wait_deadline_monotonic_ns, wait_remaining_ns, created_at, updated_at) "
      + "VALUES ('nr_u', 'r1', 'n_u', 9, 'agent', 1, 'waiting', 0, ?, ?, 'boot_a', 1000, NULL, ?, ?)",
      [NOW, '2026-11-16T03:02:00.000Z', NOW, NOW],
    )
    // 活跃等待登记：确认不确定态时必须一起收掉（S3 r19 P2-3）
    tx.run(
      "INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, created_at, updated_at) "
      + "VALUES ('nr_u', 'r1', 'event', ?, 0, 0, 'r1:n_u:1', 'active', ?, ?)",
      [JSON.stringify({ type: 'evt_x' }), NOW, NOW],
    )
  })
}

const nodeOf = (db: Db, id: string) =>
  db.raw.prepare('SELECT status, revision, recovery_uncertain, wait_deadline_at, wait_remaining_ns FROM node_runs WHERE node_run_id = ?').get(id) as
    { status: string; revision: number; recovery_uncertain: string | null; wait_deadline_at: string | null; wait_remaining_ns: number | null }

const eventCount = (db: Db, id: string, type: string): number =>
  Number((db.raw.prepare('SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ?').get(id, type) as { n: number }).n)

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

describe('恢复不确定状态的宿主入口', () => {
  it('检查点缺失的等待节点：扫描标不确定，查询能列出通道与原始锚点', () => {
    const { db } = freshLedger()
    seed(db)
    insertUncertainWait(db)
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.deadline_uncertain).toContain('nr_u')
    expect(nodeOf(db, 'nr_u').recovery_uncertain).toBe('wait_timer')

    const items = listRecoveryUncertain(db)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      node_run_id: 'nr_u',
      run_id: 'r1',
      status: 'waiting',
      channel: 'wait_timer',
      deadline_boot_id: 'boot_a',
      checkpoint_ns: null,
      remaining_trusted: false,
      action_required: 'confirm_node_state',
    })
    expect(items[0]!.deadline_at).toBe('2026-11-16T03:02:00.000Z')
    db.raw.close()
  })

  it('确认后按 M-50 落 indeterminate_side_effect，清空不确定标记与锚点，扫描不再标回', () => {
    const { db } = freshLedger()
    seed(db)
    insertUncertainWait(db)
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: NOW, clock })
    const before = nodeOf(db, 'nr_u')

    const resolved = inTx(db, (tx) => resolveRecoveryUncertain(tx, TEST_SECRET, {
      nodeRunId: 'nr_u',
      revision: before.revision,
      resolution: 'mark_indeterminate_side_effect',
      now: NOW,
    }))
    expect(resolved).toMatchObject({ node_run_id: 'nr_u', from: 'waiting', to: 'indeterminate_side_effect', channel: 'wait_timer' })
    const after = nodeOf(db, 'nr_u')
    expect(after.status).toBe('indeterminate_side_effect')
    expect(after.recovery_uncertain).toBeNull()
    expect(after.wait_deadline_at).toBeNull()
    expect(eventCount(db, 'nr_u', 'recovery.confirmed')).toBe(1)
    // 等待登记一起收掉：残留 active 登记会让后续 wakeOnEvent 整笔回滚（S3 r19 P2-3）
    const reg = db.raw.prepare("SELECT state FROM wait_registrations WHERE node_run_id = 'nr_u'").get() as { state: string } | undefined
    expect(reg?.state).toBe('cancelled')

    // 再扫一轮：标记已清、锚点已清，不会按同一通道重新标不确定
    const next = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(next.deadline_uncertain).not.toContain('nr_u')
    expect(nodeOf(db, 'nr_u').recovery_uncertain).toBeNull()
    expect(listRecoveryUncertain(db)).toHaveLength(0)
    db.raw.close()
  })

  it('终态行不会被打成不确定（timeout / abandoned_unverified 不在换算范围）', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, action_remaining_ns, created_at, updated_at) "
        + "VALUES ('nr_t', 'r1', 'n_t', 11, 'agent', 1, 'timeout', 0, ?, 'boot_a', 1000, NULL, ?, ?)",
        ['2026-11-16T03:02:00.000Z', NOW, NOW],
      )
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.deadline_uncertain).not.toContain('nr_t')
    expect(nodeOf(db, 'nr_t').recovery_uncertain).toBeNull()
    db.raw.close()
  })

  it('revision 过期或本来就不确定：拒绝，不改账本', () => {
    const { db } = freshLedger()
    seed(db)
    insertUncertainWait(db)
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: NOW, clock })
    const before = nodeOf(db, 'nr_u')

    expect(codeOf(() => inTx(db, (tx) => resolveRecoveryUncertain(tx, TEST_SECRET, {
      nodeRunId: 'nr_u', revision: before.revision + 5, resolution: 'mark_indeterminate_side_effect', now: NOW,
    })))).toBe('STALE_GENERATION')
    // nr1 是种子里的正常节点：没有不确定标记就不许走这条出口
    expect(codeOf(() => inTx(db, (tx) => resolveRecoveryUncertain(tx, TEST_SECRET, {
      nodeRunId: 'nr1', revision: 1, resolution: 'mark_indeterminate_side_effect', now: NOW,
    })))).toBe('STALE_GENERATION')
    expect(nodeOf(db, 'nr_u').status).toBe('waiting')
    expect(nodeOf(db, 'nr_u').recovery_uncertain).toBe('wait_timer')
    expect(eventCount(db, 'nr_u', 'recovery.confirmed')).toBe(0)
    db.raw.close()
  })
})
