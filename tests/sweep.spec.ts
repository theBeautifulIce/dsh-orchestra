import { describe, expect, it } from 'vitest'
import { bindRunVersion, catalogFor, freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { acquireLease, loadNodeRun } from '../src/service/commands/lease.ts'
import { applyCancel } from '../src/service/commands/cancel.ts'
import { applyReport } from '../src/service/commands/apply-report.ts'
import { sweep } from '../src/service/sweep.ts'
import { ScriptedClock } from '../src/core/clock.ts'
import { transitionNode } from '../src/service/commands/node-state.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const GRACE = '2026-11-13T03:00:30.000Z'
const CATALOG = catalogFor(['n_sw'])

// 一个已派发（dispatched）的节点：租约拿到手、执行器还没起
function setup(nodeRunId = 'nr_sw') {
  const { db } = freshLedger()
  seed(db)
  bindRunVersion(db, CATALOG)
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'r1', 'n_sw', 5, 'agent', 2, 'queued', 10, ?, ?)",
      [nodeRunId, NOW, NOW],
    )
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId, ownerEpoch: 1, leaseTtlMs: 600000, now: NOW }))
  return db
}

// 单调钟与墙钟一起推进：只推进单调钟会被当成漂移（阈值 2 秒，规格 3.4 行 171）
const tick = (clock: ScriptedClock, ms: number) => {
  clock.advanceMs(ms)
  clock.setWallClockMs(clock.sample().wallClockMs + ms)
}

// 走到 verifying 并挂上判定锚点：墙钟只作展示，判定读 boot_id 与单调纳秒（规格 3.4 行 171）
function setupVerifying(clock: ScriptedClock, nodeRunId = 'nr_sw') {
  const db = setup(nodeRunId)
  const anchor = { bootId: clock.bootId, monotonicNs: clock.sample().monotonicNs, wallClockMs: Date.parse(NOW) }
  withTx(db, (tx) => {
    const dispatched = loadNodeRun(tx, nodeRunId)
    transitionNode(tx, TEST_SECRET, {
      nodeRunId, from: 'dispatched', to: 'started',
      attempt: dispatched.attempt, revision: dispatched.revision, now: NOW, reason: 'executor_started',
    })
    const started = loadNodeRun(tx, nodeRunId)
    transitionNode(tx, TEST_SECRET, {
      nodeRunId, from: 'started', to: 'verifying',
      attempt: started.attempt, revision: started.revision, now: NOW, reason: 'work_submitted',
      verifyTimeoutMs: 10000, verifyAnchor: anchor,
    })
  })
  return db
}

const row = (db: any, id = 'nr_sw') => db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(id) as any
const evCount = (db: any, type: string, id = 'nr_sw') =>
  (db.raw.prepare('SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id=? AND type=?').get(id, type) as { n: number }).n

function cancel(db: any, result: 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown', now = NOW, id = 'nr_sw') {
  const r = row(db, id)
  return withTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
    nodeRunId: id, attempt: r.attempt, revision: r.revision, cancelResult: result, now, graceMs: 30000,
  }))
}

const lateReport = (id = 'nr_sw') => ({
  report_id: 'rep_late_' + id,
  node_run_id: id,
  attempt: 2,
  status: 'done' as const,
  evidence: { source: 'run_tool' as const, exitCode: 0, stdoutHash: 'h', hashes: {} },
})

describe('维护扫描：围栏撤销、租约过期、判定时限', () => {
  it('围栏立着时再收 unknown：状态不动、围栏还在，宽限到点才撤围栏回 stopping', () => {
    const db = setup()
    const first = cancel(db, 'interrupted')
    expect(first.next_status).toBe('timing_out')
    expect(first.fence_state).toBe('armed')

    const second = cancel(db, 'unknown')
    expect(second.reason).toBe('fence_pending')
    expect(second.next_status).toBe('timing_out')
    expect(row(db).status).toBe('timing_out')
    expect(row(db).fence_state).toBe('armed')

    // 宽限没到点：不许提前撤围栏
    const early = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:10.000Z' })
    expect(early.fence_revoked).toEqual([])
    expect(row(db).status).toBe('timing_out')
    expect(row(db).fence_state).toBe('armed')

    // 宽限到点：撤围栏回 stopping
    const late = sweep(db, TEST_SECRET, { now: GRACE })
    expect(late.fence_revoked).toEqual(['nr_sw'])
    expect(row(db).status).toBe('stopping')
    expect(row(db).fence_state).toBe('revoked')
    expect(evCount(db, 'fence_revoked')).toBe(1)
  })

  it('围栏期间的上报排队，撤围栏后扫描挑出当前 attempt 的队头', () => {
    const db = setup()
    cancel(db, 'interrupted')
    const rejected = withTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nr_sw', attempt: 2, report: lateReport(), expectedStatus: 'verifying', generation: 1, now: NOW,
    }, CATALOG))
    expect(rejected.accepted).toBe(false)
    expect(rejected.reason).toBe('fence_armed')
    expect(rejected.registry_state).toBe('rejected')

    const out = sweep(db, TEST_SECRET, { now: GRACE })
    expect(out.replay_heads.map((h) => h.report_id)).toEqual(['rep_late_nr_sw'])
    expect(out.replay_heads[0]?.node_run_id).toBe('nr_sw')
  })

  it('扫描可重入：连跑两次第二次没有新副作用', () => {
    const db = setup()
    cancel(db, 'interrupted')
    withTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nr_sw', attempt: 2, report: lateReport(), expectedStatus: 'verifying', generation: 1, now: NOW,
    }, CATALOG))
    const first = sweep(db, TEST_SECRET, { now: GRACE })
    expect(first.fence_revoked).toEqual(['nr_sw'])
    const second = sweep(db, TEST_SECRET, { now: GRACE })
    expect(second.lease_expired).toEqual([])
    expect(second.fence_revoked).toEqual([])
    expect(second.verify_timed_out).toEqual([])
    expect(second.replay_heads).toEqual([])
    expect(evCount(db, 'fence_revoked')).toBe(1)
  })

  it('租约过期：dispatched 落 stopping，started 落 startup_unknown，各只记一次', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, lease_expires_at, created_at, updated_at) VALUES ('nr_st', 'r1', 'n_st', 6, 'agent', 1, 'started', 3, ?, ?, ?)", ['2026-11-13T02:59:00.000Z', NOW, NOW])
      tx.run("UPDATE node_runs SET lease_expires_at = ? WHERE node_run_id = 'nr_sw'", ['2026-11-13T02:59:00.000Z'])
    })
    const out = sweep(db, TEST_SECRET, { now: NOW })
    expect(out.lease_expired.sort()).toEqual(['nr_st', 'nr_sw'])
    expect(row(db, 'nr_sw').status).toBe('stopping')
    expect(row(db, 'nr_st').status).toBe('startup_unknown')
    expect(evCount(db, 'lease_expired', 'nr_sw')).toBe(1)
    // 再跑一次不重复记
    const again = sweep(db, TEST_SECRET, { now: NOW })
    expect(again.lease_expired).toEqual([])
  })

  it('判定时限没到点：节点还留在 verifying', () => {
    const clock = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const db = setupVerifying(clock)
    tick(clock, 5000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:05.000Z', clock })
    expect(out.verify_timed_out).toEqual([])
    expect(out.verify_uncertain).toEqual([])
    expect(row(db).status).toBe('verifying')
  })

  it('判定时限到点：转 blocked_post 并留 verify_human（verify_timeout）', () => {
    const clock = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const db = setupVerifying(clock)
    tick(clock, 11000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:11.000Z', clock })
    expect(out.verify_timed_out).toEqual(['nr_sw'])
    expect(row(db).status).toBe('blocked_post')
    expect(row(db).verify_deadline_at).toBeNull()
    expect(evCount(db, 'verify_human')).toBe(1)
    const payload = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_sw' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(payload.payload).reason).toBe('verify_timeout')
  })

  it('墙钟跳十分钟：不误判超时，按不确定转阻塞（clock_drift）', () => {
    const clock = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const db = setupVerifying(clock)
    tick(clock, 5000)
    clock.setWallClockMs(Date.parse(NOW) + 5000 + 600000)
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:10:05.000Z', clock })
    expect(out.verify_timed_out).toEqual([])
    expect(out.verify_uncertain).toEqual(['nr_sw'])
    expect(row(db).status).toBe('blocked_post')
    const payload = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_sw' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(payload.payload).reason).toBe('timer_uncertain')
    expect(JSON.parse(payload.payload).missing).toContain('clock_drift')
  })

  it('跨 boot：按不确定转阻塞，不拿墙钟硬判超时（boot_changed）', () => {
    const clock = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const db = setupVerifying(clock)
    clock.reboot('boot_b')
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:05.000Z', clock })
    expect(out.verify_timed_out).toEqual([])
    expect(out.verify_uncertain).toEqual(['nr_sw'])
    const payload = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_sw' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(payload.payload).reason).toBe('timer_uncertain')
    expect(JSON.parse(payload.payload).missing).toContain('boot_changed')
  })

  it('没有判定锚点：按不确定转阻塞，不自动判超时', () => {
    const clock = new ScriptedClock('boot_a', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    const db = setup()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='verifying', verify_deadline_at=? WHERE node_run_id='nr_sw'", ['2026-11-13T03:00:10.000Z'])
    })
    const out = sweep(db, TEST_SECRET, { now: '2026-11-13T03:00:11.000Z', clock })
    expect(out.verify_timed_out).toEqual([])
    expect(out.verify_uncertain).toEqual(['nr_sw'])
    expect(row(db).status).toBe('blocked_post')
    const payload = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_sw' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(payload.payload).reason).toBe('timer_uncertain')
    expect(JSON.parse(payload.payload).missing).toContain('verify_deadline_anchor_missing')
  })
})