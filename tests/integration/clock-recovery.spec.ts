import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'

const NOW = '2026-11-13T03:00:00.000Z'

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

/** 打断某节点的哈希链：事件表只追加，只能卸触发器后改内容 */
function breakChain(db: Db, nodeRunId: string): void {
  withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, nodeRunId, 'started', { seed: true }))
  for (const t of ['trg_node_run_events_no_update', 'trg_node_run_events_chain_guard', 'trg_node_run_chain_heads_update_guard']) {
    db.raw.exec('DROP TRIGGER IF EXISTS ' + t)
  }
  db.raw.prepare("UPDATE node_run_events SET hash = 'tampered' WHERE node_run_id = ?").run(nodeRunId)
}

function insertActionDeadline(db: Db, id: string, opts: { remainingNs: number | null; deadlineAt: string }): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, action_remaining_ns, created_at, updated_at) VALUES (?, 'r1', ?, ?, 'agent', 1, 'stopping', 0, ?, 'boot_a', 1000000000, ?, ?, ?)",
      [id, id, 90, opts.deadlineAt, opts.remainingNs, NOW, NOW],
    )
  })
}

describe('跨服务实例的截止锚点恢复（评审 P1-2：检查点驱动，不依赖墙钟）', () => {
  it('动作截止：按恢复检查点续算，到点照常开卡', () => {
    const { db } = freshLedger()
    seed(db)
    insertActionDeadline(db, 'nr_act', { remainingNs: 30_000 * 1e6, deadlineAt: '2026-11-13T03:00:30.000Z' })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const first = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(first.action_overrun).not.toContain('nr_act')
    expect(row(db, 'nr_act').deadline_boot_id).toBe('boot_b')
    expect(events(db, 'nr_act', 'deadline.reanchored')).toBe(1)
    // 墙钟跳到 10 分钟后也不提前开卡：判定只认新 boot 的单调钟
    tick(clock, 31_000)
    const second = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(second.action_overrun).toContain('nr_act')
    expect(row(db, 'nr_act').hang_reason).toBe('action_overrun')
  })

  it('取消宽限：按检查点续算；两次重启不放大预算', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, fence_remaining_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',3,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    const b = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: NOW, clock: b })
    expect(row(db, 'nr_fen').fence_grace_boot_id).toBe('boot_b')
    // 服务跑了 10 秒：检查点降到 20s
    tick(b, 10_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:10.000Z', clock: b })
    expect(row(db, 'nr_fen').fence_remaining_ns).toBe(20_000 * 1e6)
    // 再重启：按 20s 检查点续算，不放大
    const c = new ScriptedClock('boot_c', { wallClockMs: Date.parse('2026-11-13T03:00:10.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:10.000Z', clock: c })
    const after = row(db, 'nr_fen')
    expect(Date.parse(after.fence_grace_until) - Date.parse('2026-11-13T03:00:10.000Z')).toBe(20_000)
    tick(c, 21_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:31.000Z', clock: c })
    expect(row(db, 'nr_fen').fence_state).toBe('revoked')
  })

  it('wait 计时：原预算 120 秒、墙钟前跳 10 分钟，不会在 30 秒后误超时', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, wait_deadline_at, wait_deadline_boot_id, wait_deadline_monotonic_ns, wait_remaining_ns, created_at, updated_at) VALUES ('nr_wait','r1','n_wait',4,'wait',1,'waiting',0,?, 'boot_a', 120000000000, 120000000000, ?, ?)", ['2026-11-13T03:02:00.000Z', NOW, NOW])
      tx.run("INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, queued_at, created_at, updated_at) VALUES ('nr_wait','r1','timer','{}',0,0,'k_wait','active',?,?,?)", [NOW, NOW, NOW])
    })
    // 真实只停 3 秒，墙钟却前跳 10 分钟
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:10:00.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z', clock })
    expect(row(db, 'nr_wait').status).toBe('waiting')
    expect(events(db, 'nr_wait', 'timer_uncertain')).toBe(0)
    // 旧实现会在这里给 30 秒确认窗口；新实现按 120 秒检查点续算
    tick(clock, 31_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(db, 'nr_wait').status).toBe('waiting')
    tick(clock, 90_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:11:01.000Z', clock })
    expect(row(db, 'nr_wait').status).not.toBe('waiting')
  })

  it('action deadline 原剩余 117 秒、墙钟前跳 10 分钟：不会误触发 action_overrun', () => {
    const { db } = freshLedger()
    seed(db)
    insertActionDeadline(db, 'nr_act', { remainingNs: 117_000 * 1e6, deadlineAt: '2026-11-13T03:01:57.000Z' })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:10:00.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z', clock })
    tick(clock, 31_000)
    sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:31.000Z', clock })
    expect(row(db, 'nr_act').hang_reason).toBeNull()
    expect(row(db, 'nr_act').status).toBe('stopping')
  })

  it('startup_unknown 冻结 120 秒、墙钟前跳 10 分钟：不得把剩余 0 当可信到期', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, startup_unknown_deadline_at, startup_unknown_boot_id, startup_unknown_monotonic_ns, startup_unknown_remaining_ns, created_at, updated_at) VALUES ('nr_un','r1','n_un',5,'agent',1,'startup_unknown',0,?, 'boot_a', 120000000000, 120000000000, ?, ?)", ['2026-11-13T03:02:00.000Z', NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T03:10:00.000Z'), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z', clock })
    expect(out.startup_unknown_expired).not.toContain('nr_un')
    expect(row(db, 'nr_un').status).toBe('startup_unknown')
    expect(row(db, 'nr_un').startup_unknown_boot_id).toBe('boot_b')
    // 120 秒 uptime 之后才到期
    tick(clock, 121_000)
    const later = sweep(db, TEST_SECRET, { now: '2026-11-13T03:12:01.000Z', clock })
    expect(later.startup_unknown_expired).toContain('nr_un')
    expect(row(db, 'nr_un').status).toBe('indeterminate_side_effect')
  })

  it('墙钟回拨 1 小时：不放大原始预算', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, fence_remaining_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',3,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse('2026-11-13T02:00:00.000Z'), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: '2026-11-13T02:00:00.000Z', clock })
    const after = row(db, 'nr_fen')
    expect(Date.parse(after.fence_grace_until) - Date.parse('2026-11-13T02:00:00.000Z')).toBe(30_000)
    expect(after.fence_remaining_ns).toBe(30_000 * 1e6)
  })

  it('检查点缺失：落 timer_uncertain 与 recovery_uncertain，不自动推进', () => {
    const { db } = freshLedger()
    seed(db)
    insertActionDeadline(db, 'nr_act', { remainingNs: null, deadlineAt: '2026-11-13T03:00:30.000Z' })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.deadline_uncertain).toContain('nr_act')
    expect(events(db, 'nr_act', 'timer_uncertain')).toBe(1)
    expect(row(db, 'nr_act').recovery_uncertain).toBe('action_deadline')
    // 不重锚：锚点还是旧 boot，判定判不确定，不会误开卡
    expect(row(db, 'nr_act').deadline_boot_id).toBe('boot_a')
    tick(clock, 600_000)
    const later = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:00.000Z', clock })
    expect(later.action_overrun).not.toContain('nr_act')
    expect(row(db, 'nr_act').hang_reason).toBeNull()
  })

  it('哈希链损坏的节点：恢复代码不动它的锚点、不撤围栏、不写事件', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, fence_remaining_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_bad','r1','n_bad',6,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, deadline_at, deadline_boot_id, deadline_monotonic_ns, action_remaining_ns, created_at, updated_at) VALUES ('nr_bad2','r1','n_bad2',7,'agent',1,'stopping',0,?, 'boot_a', 1000000000, 30000000000, ?, ?)", [NOW, NOW, NOW])
    })
    breakChain(db, 'nr_bad')
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    tick(clock, 31_000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:31.000Z', clock })
    expect(out.chain_broken).toContain('nr_bad')
    expect(row(db, 'nr_bad').fence_grace_boot_id).toBe('boot_a')
    expect(row(db, 'nr_bad').fence_state).toBe('armed')
    expect(events(db, 'nr_bad', 'deadline.reanchored')).toBe(0)
    expect(events(db, 'nr_bad', 'fence_revoked')).toBe(0)
    expect(out.fence_revoked).not.toContain('nr_bad')
    // 好链的 nr_bad2 照常换算
    expect(row(db, 'nr_bad2').deadline_boot_id).toBe('boot_b')
  })

  it('断链父节点 + 已完成子 run：不推进父节点、不追加父节点事件', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, parent_node_run_id, created_at, updated_at) VALUES ('nr_parent','r1','n_parent',8,'control',1,'waiting',1,NULL,?,?)", [NOW, NOW])
      tx.run("INSERT INTO runs (run_id, task_id, status, revision, parent_run_id, parent_node_run_id, root_run_id, subworkflow_depth, created_at, updated_at) VALUES ('r2','t1','succeeded',1,'r1','nr_parent','r2',1,?,?)", [NOW, NOW])
    })
    breakChain(db, 'nr_parent')
    const before = events(db, 'nr_parent', 'subworkflow_child_finished')
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.chain_broken).toContain('nr_parent')
    expect(row(db, 'nr_parent').status).toBe('waiting')
    expect(events(db, 'nr_parent', 'subworkflow_child_finished')).toBe(before)
  })

  it('断链 blocked_pre + 已超时 decision：不放行节点、不收口卡片', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, blocked_decision_id, created_at, updated_at) VALUES ('nr_bp','r1','n_bp',9,'agent',1,'blocked_pre',1,'d_exp',?,?)", [NOW, NOW])
      tx.run("INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) VALUES ('d_exp','r1','nr_bp','pre_execution','pending',1,'{}',?)", ['2026-11-11T00:00:00.000Z'])
    })
    breakChain(db, 'nr_bp')
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.chain_broken).toContain('nr_bp')
    expect(row(db, 'nr_bp').status).toBe('blocked_pre')
    expect(out.decisions_expired).toBe(0)
    expect(out.decisions_released_nodes).not.toContain('nr_bp')
  })

  it('run 里含断链终态节点：不按它收口 run', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='done', revision=2 WHERE node_run_id='nr1'")
    })
    breakChain(db, 'nr1')
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const out = sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(out.chain_broken).toContain('nr1')
    expect(out.runs_closed).not.toContain('r1')
    const run = db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get() as { status: string }
    expect(run.status).toBe('running')
  })

  it('重复扫描幂等：不重复写 deadline.reanchored', () => {
    const { db } = freshLedger()
    seed(db)
    insertActionDeadline(db, 'nr_act', { remainingNs: 30_000 * 1e6, deadlineAt: '2026-11-13T03:00:30.000Z' })
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: NOW, clock })
    sweep(db, TEST_SECRET, { now: NOW, clock })
    expect(events(db, 'nr_act', 'deadline.reanchored')).toBe(1)
  })

  it('真实关库重开：新实例的扫描能推进旧实例留下的围栏', () => {
    const { file, db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, fence_state, fence_armed_at, fence_grace_until, fence_grace_boot_id, fence_grace_monotonic_ns, fence_remaining_ns, cancel_requested_at, created_at, updated_at) VALUES ('nr_fen','r1','n_fen',5,'agent',1,'timing_out',0,'armed',?,?, 'boot_a', 30000000000, 30000000000, ?, ?, ?)", [NOW, '2026-11-13T03:00:30.000Z', NOW, NOW, NOW])
    })
    db.raw.close()
    const reopened = openDb(file)
    const clock = new ScriptedClock('boot_b', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    sweep(reopened, TEST_SECRET, { now: NOW, clock })
    expect(row(reopened, 'nr_fen').fence_grace_boot_id).toBe('boot_b')
    tick(clock, 31_000)
    sweep(reopened, TEST_SECRET, { now: '2026-11-13T03:00:31.000Z', clock })
    expect(row(reopened, 'nr_fen').fence_state).toBe('revoked')
    reopened.raw.close()
  })
})
