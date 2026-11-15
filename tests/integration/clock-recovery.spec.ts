import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
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

const tick = (clock: ScriptedClock, ms: number) => {
  clock.advanceMs(ms)
  clock.setWallClockMs(clock.sample().wallClockMs + ms)
}

describe('跨服务实例的截止锚点恢复（S3 round13 P1）', () => {
  it('动作截止：旧 boot 换算后到点开卡；不可信的「已到期」先给确认窗口', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_act','r1','n_act',2,'agent',1,'stopping',0,?, 'boot_a', 1000000000, ?, ?)", [NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    // 墙钟已过 deadline：不可信的到点不许立刻开卡，先落 timer_uncertain + 确认窗口
    const first = sweep(db, TEST_SECRET, { now: LATER, clock })
    expect(first.action_overrun).not.toContain('nr_act')
    expect(first.deadline_uncertain).toContain('nr_act')
    expect(events(db, 'nr_act', 'timer_uncertain')).toBe(1)
    expect(row(db, 'nr_act').deadline_boot_id).toBe('boot_b')
    tick(clock, 31_000)
    const second = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(second.action_overrun).toContain('nr_act')
    expect(row(db, 'nr_act').hang_reason).toBe('action_overrun')
    expect(events(db, 'nr_act', 'deadline.reanchored')).toBe(1)
  })

  it('取消宽限：换算后按剩余量推进；两次重启不放大预算', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',3,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    // 第一次重启：墙钟 +10s，剩余 20s，重锚后 armed_at 推到当前
    const b = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:00:10.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:10.000Z', clock: b })
    expect(row(db, 'nr_fen').fence_grace_boot_id).toBe('boot_b')
    expect(row(db, 'nr_fen').fence_armed_at).toBe('2026-11-13T03:00:10.000Z')
    // 第二次重启：墙钟再 +5s。剩余应是 20-5=15s，不是再给满 30s
    const c = new ScriptedClock('boot_c', { wallClockMs: Date.parse('2026-11-13T03:00:15.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:15.000Z', clock: c })
    const after = row(db, 'nr_fen')
    expect(after.fence_grace_boot_id).toBe('boot_c')
    expect(Date.parse(after.fence_grace_until) - Date.parse(after.fence_armed_at)).toBe(15_000)
    // 推进 16s：撤围栏
    tick(c, 16_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:31.000Z', clock: c })
    expect(row(db, 'nr_fen').fence_state).toBe('revoked')
  })

  it('wait 计时：墙钟前跳 10 分钟不许误超时，先给确认窗口', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, wait_deadline_at, wait_deadline_boot_id, wait_deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_wait','r1','n_wait',4,'wait',1,'waiting',0,?, 'boot_a', 27000000000, ?, ?)", ['2026-11-13T03:00:27.000Z', NOW, NOW])
      tx.run("INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, queued_at, created_at, updated_at) VALUES ('nr_wait','r1','timer','{}',0,0,'k_wait','active',?,?,?)", [NOW, NOW, NOW])
    })
    // 真实只停 3s，但墙钟前跳 10 分钟：估算剩余 0 → 不许直接 timeout
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:10:00.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z', clock })
    expect(row(db, 'nr_wait').status).toBe('waiting')
    expect(events(db, 'nr_wait', 'timer_uncertain')).toBe(1)
    tick(clock, 31_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(db, 'nr_wait').status).not.toBe('waiting')
    expect(events(db, 'nr_wait', 'deadline.reanchored')).toBe(1)
  })

  it('startup_unknown：旧 boot 的 watchdog 换算后能继续推进', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, startup_unknown_deadline_at, startup_unknown_boot_id, startup_unknown_monotonic_ns, startup_unknown_remaining_ns, created_at, updated_at) VALUES ('nr_un','r1','n_un',5,'agent',1,'startup_unknown',0,?, 'boot_a', 120000000000, 120000000000, ?, ?)", ['2026-11-13T03:02:00.000Z', NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(row(db, 'nr_un').startup_unknown_boot_id).toBe('boot_b')
    expect(events(db, 'nr_un', 'deadline.reanchored')).toBe(1)
    tick(clock, 121_000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:02:01.000Z', clock })
    expect(out.startup_unknown_expired).toContain('nr_un')
    expect(row(db, 'nr_un').status).toBe('indeterminate_side_effect')
  })

  it('哈希链损坏的节点：恢复代码不动它的锚点、不撤围栏、不写事件', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_bad','r1','n_bad',6,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_bad2','r1','n_bad2',7,'agent',1,'stopping',0,?, 'boot_a', 1000000000, ?, ?)", [NOW, NOW, NOW])
    })
    // 先写真事件，再卸掉只追加触发器破坏哈希（模拟直接改库的坏账本）
    withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, 'nr_bad', 'started', { seed: true }))
    for (const t of ['trg_node_run_events_no_update', 'trg_node_run_events_chain_guard', 'trg_node_run_chain_heads_update_guard']) {
      db.raw.exec('DROP TRIGGER IF EXISTS ' + t)
    }
    db.raw.prepare("UPDATE node_run_events SET hash = 'tampered' WHERE node_run_id = 'nr_bad'").run()
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    tick(clock, 31_000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:31.000Z', clock })
    expect(out.chain_broken).toContain('nr_bad')
    // 坏链节点：锚点、状态、事件都不许动
    expect(row(db, 'nr_bad').fence_grace_boot_id).toBe('boot_a')
    expect(row(db, 'nr_bad').fence_state).toBe('armed')
    expect(events(db, 'nr_bad', 'deadline.reanchored')).toBe(0)
    expect(events(db, 'nr_bad', 'fence_revoked')).toBe(0)
    expect(out.fence_revoked).not.toContain('nr_bad')
    // 好链的 nr_bad2 照常换算
    expect(row(db, 'nr_bad2').deadline_boot_id).toBe('boot_b')
  })

  it('墙钟回拨：围栏预算用 deadline-armed 夹紧，不被吹大', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',3,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    // 重启时墙钟回拨 1 小时：墙钟剩余 3630s，但原始预算只有 30s
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T02:00:00.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T02:00:00.000Z', clock })
    const after = row(db, 'nr_fen')
    expect(Date.parse(after.fence_grace_until) - Date.parse(after.fence_armed_at)).toBe(30_000)
  })

  it('startup_unknown：反复重启不放大 watchdog 预算', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, startup_unknown_deadline_at, startup_unknown_boot_id, startup_unknown_monotonic_ns, startup_unknown_remaining_ns, created_at, updated_at) VALUES ('nr_un','r1','n_un',5,'agent',1,'startup_unknown',0,?, 'boot_a', 120000000000, 120000000000, ?, ?)", ['2026-11-13T03:02:00.000Z', NOW, NOW])
    })
    const b = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:00:10.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:10.000Z', clock: b })
    const afterB = row(db, 'nr_un')
    // 墙钟已走 10s：剩余 110s 而不是再给满 120s
    expect(Date.parse(afterB.startup_unknown_deadline_at) - Date.parse('2026-11-13T03:00:10.000Z')).toBe(110_000)
  })

  it('重复扫描幂等：不重复写 deadline.reanchored', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, created_at, updated_at) VALUES ('nr_act','r1','n_act',2,'agent',1,'stopping',0,?, 'boot_a', 1000000000, ?, ?)", [NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: LATER, clock })
    sweep(db, TEST_SECRET, { now: LATER, clock })
    expect(events(db, 'nr_act', 'deadline.reanchored')).toBe(1)
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
    tick(clock, 31_000)
    sweep(reopened, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(reopened, 'nr_fen').fence_state).toBe('revoked')
    reopened.raw.close()
  })
})
