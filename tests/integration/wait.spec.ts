import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import {
  cancelWait, enterWaiting, markWakeStarvation, recordWaitEvent,
  sweepWaitTimeouts, timeoutWaiting, wakeOnEvent,
} from '../../src/service/commands/wait.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { sweep } from '../../src/service/sweep.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'wait-secret'

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '等待', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)", [NOW, NOW])
  })
  return db
}

function seedNode(db: Db, id: string, status = 'started', attempt = 1): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, lease_id, lease_expires_at, executor_session_id, executor_agent_id, side_effect_policy, created_at, updated_at) " +
        "VALUES (?, 'r1', ?, 1, 'wait', ?, ?, 1, 'lease-old', ?, 'sess-old', 'agent-old', 'pure', ?, ?)",
      [id, id, attempt, status, NOW, NOW, NOW],
    )
  })
}

function node(db: Db, id: string): any {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(id)
}

function count(db: Db, sql: string, ...params: any[]): number {
  return (db.raw.prepare(sql).get(...params) as { n: number }).n
}

describe('等待节点', () => {
  it('事件早到：注册时回扫 inbox，当笔唤醒并释放旧租约', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      const seq = recordWaitEvent(tx, {
        runId: 'r1', eventType: 'approval.approved', payload: { requestId: 'q1' }, now: NOW,
      })
      expect(seq).toBe(1)
    })
    withTx(db, (tx) => {
      const result = enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'approval.approved', path: 'requestId', equals: 'q1' },
        idempotencyKey: 'wait-1', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
      expect(result.woken).toBe(true)
      expect(result.registration.state).toBe('woken')
      expect(result.registration.matchedEventSeq).toBe(1)
    })
    expect(node(db, 'n1')).toMatchObject({
      status: 'done', lease_id: null, lease_expires_at: null, executor_session_id: null,
      executor_agent_id: null, wait_deadline_at: null, rearm_generation: 1,
    })
    expect(count(db, "SELECT COUNT(*) AS n FROM wait_registrations WHERE state = 'woken'")).toBe(1)
    expect(count(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'n1' AND type = 'wait.woken'")).toBe(1)
    expect((db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get() as { status: string }).status).toBe('succeeded')
  })

  it('重复事件与重复唤醒都只落一条；幂等键重复投递不新增 inbox', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'build.done' }, idempotencyKey: 'wait-1', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    withTx(db, (tx) => {
      expect(wakeOnEvent(tx, SECRET, {
        runId: 'r1', eventType: 'build.done', idempotencyKey: 'evt-1', payload: { ok: true }, now: NOW,
      })).toMatchObject({ woken: 1 })
    })
    withTx(db, (tx) => {
      expect(wakeOnEvent(tx, SECRET, {
        runId: 'r1', eventType: 'build.done', idempotencyKey: 'evt-1', payload: { ok: true }, now: NOW,
      })).toMatchObject({ woken: 0 })
    })
    expect(count(db, 'SELECT COUNT(*) AS n FROM wait_event_inbox')).toBe(1)
    expect(count(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'n1' AND type = 'wait.woken'")).toBe(1)
    expect(node(db, 'n1').status).toBe('done')
  })

  it('谓词不命中不唤醒，cursor 推进后不回扫旧事件', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      recordWaitEvent(tx, { runId: 'r1', eventType: 'build.done', payload: { ok: false }, now: NOW })
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'build.done', path: 'ok', equals: true },
        idempotencyKey: 'wait-1', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    expect(node(db, 'n1').status).toBe('waiting')
    const reg = db.raw.prepare("SELECT * FROM wait_registrations WHERE node_run_id = 'n1'").get() as any
    expect(reg.cursor_seq).toBe(1)
    expect(reg.state).toBe('active')
  })

  it('wake_dispatch_starvation 与 event_timeout 分开记账；超时清等待钟', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'never' }, idempotencyKey: 'wait-1', maxWaitMs: 1_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    withTx(db, (tx) => markWakeStarvation(tx, SECRET, 'n1', NOW))
    expect(node(db, 'n1').status).toBe('waiting')
    expect(count(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'wait.wake_dispatch_starvation'")).toBe(1)
    expect(count(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'wait.event_timeout'")).toBe(0)

    expect(() => withTx(db, (tx) => expect(timeoutWaiting(tx, SECRET, 'n1', NOW, TEST_CLOCK)).toBe(false))).not.toThrow()
    const at = new Date(Date.parse(NOW) + 1_001).toISOString()
    TEST_CLOCK.advanceMs(1_100)
    TEST_CLOCK.setWallClockMs(TEST_CLOCK.sample().wallClockMs + 1_100)
    withTx(db, (tx) => expect(timeoutWaiting(tx, SECRET, 'n1', at, TEST_CLOCK)).toBe(true))
    expect(node(db, 'n1')).toMatchObject({ status: 'timeout', wait_deadline_at: null, rearm_generation: 2 })
    expect((db.raw.prepare("SELECT state FROM wait_registrations WHERE node_run_id = 'n1'").get() as any).state).toBe('timed_out')
    expect(count(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'wait.event_timeout'")).toBe(1)
    expect((db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get() as { status: string }).status).toBe('failed')
  })

  it('等待钟按单调锚点判：墙钟跳远不误超时，单调钟到点才转 timeout', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    const clock = new ScriptedClock('boot-w', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'timer', match: { type: 'never' },
        idempotencyKey: 'wait-anchored', maxWaitMs: 1_000, now: NOW, clock,
      })
    })
    expect(node(db, 'n1')).toMatchObject({
      wait_deadline_boot_id: 'boot-w',
      wait_deadline_monotonic_ns: 1_000_000_000,
    })
    const wallJump = new Date(Date.parse(NOW) + 3_600_000).toISOString()
    withTx(db, (tx) => expect(timeoutWaiting(tx, SECRET, 'n1', wallJump, clock)).toBe(false))
    clock.advanceMs(1_100)
    clock.setWallClockMs(clock.sample().wallClockMs + 1_100)
    withTx(db, (tx) => expect(timeoutWaiting(tx, SECRET, 'n1', wallJump, clock)).toBe(true))
    expect(node(db, 'n1')).toMatchObject({
      status: 'timeout', wait_deadline_boot_id: null, wait_deadline_monotonic_ns: null,
    })
  })

  it('sweep 只挑到点的 waiting，可重入且第二次不再落 timeout', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    seedNode(db, 'n2')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'timer', match: { type: 'never' },
        idempotencyKey: 'wait-1', maxWaitMs: 1_000, now: NOW,
        clock: TEST_CLOCK,
      })
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n2', attempt: 1, runId: 'r1', waitKind: 'timer', match: { type: 'never' },
        idempotencyKey: 'wait-2', maxWaitMs: 10_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    const at = new Date(Date.parse(NOW) + 2_000).toISOString()
    // 到点判定只认单调钟：推 2 秒后 1s 的 timer 到点、10s 的还没到
    TEST_CLOCK.advanceMs(2_000)
    TEST_CLOCK.setWallClockMs(TEST_CLOCK.sample().wallClockMs + 2_000)
    withTx(db, (tx) => expect(sweepWaitTimeouts(tx, SECRET, at, TEST_CLOCK)).toBe(1))
    withTx(db, (tx) => expect(sweepWaitTimeouts(tx, SECRET, at, TEST_CLOCK)).toBe(0))
    expect(node(db, 'n1').status).toBe('timeout')
    expect(node(db, 'n2').status).toBe('waiting')
  })

  it('维护扫描本身就会收 wait 超时，不靠调用方另起一轮', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'timer', match: { type: 'never' },
        idempotencyKey: 'wait-1', maxWaitMs: 1_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    const at = new Date(Date.parse(NOW) + 2_000).toISOString()
    TEST_CLOCK.advanceMs(2_000)
    TEST_CLOCK.setWallClockMs(TEST_CLOCK.sample().wallClockMs + 2_000)
    const result = sweep(db, SECRET, { now: at , clock: TEST_CLOCK})
    expect(result.wait_timed_out).toBe(1)
    expect(node(db, 'n1').status).toBe('timeout')
    expect(sweep(db, SECRET, { now: at , clock: TEST_CLOCK}).wait_timed_out).toBe(0)
  })

  it('组结束撤等待登记，节点状态由调用方负责', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event', match: { type: 'x' },
        idempotencyKey: 'wait-1', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    withTx(db, (tx) => expect(cancelWait(tx, 'n1', NOW)).toBe(true))
    withTx(db, (tx) => expect(cancelWait(tx, 'n1', NOW)).toBe(false))
    expect((db.raw.prepare("SELECT state FROM wait_registrations WHERE node_run_id = 'n1'").get() as any).state).toBe('cancelled')
    expect(node(db, 'n1').status).toBe('waiting')
  })

  it('取消等待节点：登记撤销、节点 superseded，后续事件只落 inbox 不再 409', () => {
    const db = memoryDb()
    seedNode(db, 'n1')
    withTx(db, (tx) => {
      enterWaiting(tx, SECRET, {
        nodeRunId: 'n1', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'approval.approved', path: 'requestId', equals: 'q1' },
        idempotencyKey: 'wait-cancel', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    const before = node(db, 'n1')
    withTx(db, (tx) => {
      const out = applyCancel(tx, SECRET, { clock: TEST_CLOCK,
        nodeRunId: 'n1', attempt: before.attempt, revision: before.revision,
        cancelResult: 'interrupted', now: NOW, graceMs: 5_000,
      })
      expect(out.next_status).toBe('superseded')
    })
    expect(node(db, 'n1').status).toBe('superseded')
    expect((db.raw.prepare("SELECT state FROM wait_registrations WHERE node_run_id = 'n1'").get() as any).state).toBe('cancelled')
    withTx(db, (tx) => {
      const out = wakeOnEvent(tx, SECRET, {
        runId: 'r1', eventType: 'approval.approved', payload: { requestId: 'q1' }, idempotencyKey: 'late-1', now: NOW,
      })
      expect(out.woken).toBe(0)
    })
    expect(node(db, 'n1').status).toBe('superseded')
    expect(count(db, "SELECT COUNT(*) AS n FROM wait_event_inbox WHERE idempotency_key = 'late-1'")).toBe(1)
  })
})

describe('等待事件幂等键按 run 作用域（G3 r11 P2-6）', () => {
  it('两个 run 用同一个幂等键：事件各自进各自的 inbox，不互相吞掉', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r2', 't1', 'running', 1, ?, ?)", [NOW, NOW])
      const first = recordWaitEvent(tx, { runId: 'r1', eventType: 'build.finished', idempotencyKey: 'shared-key', now: NOW })
      const second = recordWaitEvent(tx, { runId: 'r2', eventType: 'build.finished', idempotencyKey: 'shared-key', now: NOW })
      expect(second).not.toBe(first)
    })
    const rows = db.raw.prepare('SELECT run_id, idempotency_key FROM wait_event_inbox ORDER BY inbox_seq').all() as { run_id: string; idempotency_key: string }[]
    expect(rows).toEqual([
      { run_id: 'r1', idempotency_key: 'shared-key' },
      { run_id: 'r2', idempotency_key: 'shared-key' },
    ])
  })

  it('同一 run 重复投递同一个键：仍然只留一条', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const first = recordWaitEvent(tx, { runId: 'r1', eventType: 'build.finished', idempotencyKey: 'k1', now: NOW })
      const again = recordWaitEvent(tx, { runId: 'r1', eventType: 'build.finished', idempotencyKey: 'k1', now: NOW })
      expect(again).toBe(first)
    })
    expect(count(db, 'SELECT COUNT(*) AS n FROM wait_event_inbox')).toBe(1)
  })
})
