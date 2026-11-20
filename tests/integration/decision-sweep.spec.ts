// 决策卡的维护扫描：2 小时升级、升级后再等 24 小时、人工核验保护与 CAS。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { cancelDecision, openDecision, resolveDecision, sweepDecisions } from '../../src/service/commands/decisions.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { sweep } from '../../src/service/sweep.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const SECRET = 'decision-sweep-secret'
const T0 = '2026-11-14T00:00:00.000Z'
const H1 = '2026-11-14T01:00:00.000Z'
const H2 = '2026-11-14T02:00:00.000Z'
const H24 = '2026-11-15T00:00:00.000Z'
const H26 = '2026-11-15T02:00:00.000Z'
const H48 = '2026-11-16T00:00:00.000Z'

function decisionDb(opts: { autonomy?: string; file?: string } = {}): Db {
  const db = openDb(opts.file ?? ':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, autonomy, created_at, updated_at) VALUES ('t1','决策', 'running', 1, ?, ?, ?)",
      [opts.autonomy ?? 'autonomous', T0, T0],
    )
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1','t1','running',1,?,?)", [T0, T0])
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, blocked_decision_id, side_effect_policy, created_at, updated_at) "
      + "VALUES ('nr1','r1','n1',1,'agent',1,'blocked_pre',1,'d1','pure',?,?)",
      [T0, T0],
    )
    openDecision(tx, {
      decisionId: 'd1', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution', createdAt: T0,
      payload: { policy: 'irreversible' },
    })
  })
  return db
}

const decision = (db: Db) => db.raw.prepare('SELECT * FROM decisions WHERE decision_id = ?').get('d1') as any
const node = (db: Db) => db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get('nr1') as any
const count = (db: Db, sql: string) => (db.raw.prepare(sql).get() as { n: number }).n

describe('决策超时扫描', () => {
  it('1 小时不动；2 小时升 blocked_for_human 并留 decision.blocked 事件', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      expect(sweepDecisions(tx, SECRET, { now: H1 })).toMatchObject({ blocked: 0, expired: 0 })
    })
    expect(decision(db).status).toBe('pending')
    withTx(db, (tx) => {
      expect(sweepDecisions(tx, SECRET, { now: H2 })).toMatchObject({ blocked: 1, expired: 0 })
    })
    expect(decision(db).status).toBe('blocked_for_human')
    expect(decision(db).revision).toBe(2)
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.blocked'")).toBe(1)
  })

  it('第 2 小时升级，第 24 小时仍在等待，第 26 小时关闭审批和运行', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      expect(sweepDecisions(tx, SECRET, { now: H2 })).toMatchObject({ blocked: 1, expired: 0 })
      expect(sweepDecisions(tx, SECRET, { now: H24 })).toMatchObject({ blocked: 0, expired: 0 })
      expect(decision(db).status).toBe('blocked_for_human')
      expect(node(db).status).toBe('blocked_pre')
    })
    withTx(db, (tx) => {
      const out = sweepDecisions(tx, SECRET, { now: H26 })
      expect(out.expired).toBe(1)
      expect(out.releasedNodes).toEqual(['nr1'])
    })
    expect(decision(db)).toMatchObject({ status: 'resolved', closed_reason: 'expired_final' })
    expect(decision(db).resolved_by).toBe('system:cancel')
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'")).toBe(1)
    expect(node(db)).toMatchObject({ status: 'failed', blocked_decision_id: null, lease_id: null })
    const run = db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get('r1') as { status: string }
    expect(run.status).toBe('failed')
  })

  it('首次扫描迟至第 24 小时，重启后从实际升级时间继续等待至第 48 小时', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-decision-clock-'))
    const file = join(directory, 'orchestra.db')
    let db = decisionDb({ file })
    try {
      expect(sweep(db, SECRET, { now: H24, clock: TEST_CLOCK })).toMatchObject({ decisions_blocked: 1, decisions_expired: 0 })
      expect(decision(db)).toMatchObject({ status: 'blocked_for_human', revision: 2 })
      db.raw.close()
      db = openDb(file)
      for (const now of [H26, '2026-11-15T23:59:59.999Z']) {
        expect(sweep(db, SECRET, { now, clock: TEST_CLOCK })).toMatchObject({ decisions_blocked: 0, decisions_expired: 0 })
        expect(decision(db).status).toBe('blocked_for_human')
      }
      expect(sweep(db, SECRET, { now: H48, clock: TEST_CLOCK })).toMatchObject({ decisions_blocked: 0, decisions_expired: 1 })
      expect(sweep(db, SECRET, { now: H48, clock: TEST_CLOCK })).toMatchObject({ decisions_blocked: 0, decisions_expired: 0 })
      expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.blocked'")).toBe(1)
      expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'")).toBe(1)
    } finally {
      db.raw.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([true, false])('兼容旧升级卡并持久恢复起算点，有旧事件=%s', (hasEvent) => {
    const db = decisionDb()
    withTx(db, (tx) => {
      tx.run("UPDATE decisions SET status='blocked_for_human', revision=3 WHERE decision_id='d1'")
      if (hasEvent) {
        tx.run("INSERT INTO events(event_id,type,occurred_at,created_at,payload_redacted) VALUES ('old','decision.blocked',?,?,?)",
          [H2, H2, JSON.stringify({ decisionId: 'd1', revision: 2 })])
      }
      expect(sweepDecisions(tx, SECRET, { now: H24 })).toMatchObject({ blocked: 0, expired: 0 })
      expect(sweepDecisions(tx, SECRET, { now: H26 })).toMatchObject({ blocked: 0, expired: hasEvent ? 1 : 0 })
      if (!hasEvent) expect(sweepDecisions(tx, SECRET, { now: H48 })).toMatchObject({ blocked: 0, expired: 1 })
    })
    expect(decision(db)).toMatchObject({ status: 'resolved', closed_reason: 'expired_final' })
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.escalation_clock_restored'")).toBe(1)
  })

  it('supervised 档只升级不自动收口，24 小时后仍在等人', () => {
    const db = decisionDb({ autonomy: 'supervised' })
    withTx(db, (tx) => {
      expect(sweepDecisions(tx, SECRET, { now: H2 })).toMatchObject({ blocked: 1, expired: 0 })
    })
    expect(decision(db).status).toBe('blocked_for_human')
    withTx(db, (tx) => {
      expect(sweepDecisions(tx, SECRET, { now: H48 })).toMatchObject({ blocked: 0, expired: 0 })
    })
    expect(decision(db).status).toBe('blocked_for_human')
    expect(node(db).status).toBe('blocked_pre')
  })

  it('report_contradicted 不参与自动升级/过期', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      tx.run("UPDATE decisions SET kind = 'report_contradicted' WHERE decision_id = 'd1'")
      expect(sweepDecisions(tx, SECRET, { now: H24 })).toMatchObject({ blocked: 0, expired: 0 })
    })
    expect(decision(db).status).toBe('pending')
  })

  it('人工裁决与扫描竞争：revision CAS 落空的那一方不算自动处理成功', () => {
    const db = decisionDb()
    // 人工先裁决（revision 1 → 2）
    withTx(db, (tx) => {
      resolveDecision(tx, SECRET, {
        decisionId: 'd1', revision: 1, resolution: 'approved', now: H1,
        actor: { kind: 'human', id: 'human:test' },
        confirm: true,
      })
    })
    withTx(db, (tx) => {
      // 扫描读到的是新 revision，已经不在活跃态：不会再关一次
      const out = sweepDecisions(tx, SECRET, { now: H24 })
      expect(out.expired).toBe(0)
    })
    expect(decision(db)).toMatchObject({ status: 'resolved', closed_reason: 'approved' })
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'")).toBe(1)
  })

  it('cancelDecision 用 revision CAS：重复关闭只生效一次并留一条事件', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      expect(cancelDecision(tx, SECRET, { decisionId: 'd1', now: H1, reason: 'cancelled' }).changed).toBe(true)
      expect(cancelDecision(tx, SECRET, { decisionId: 'd1', now: H1, reason: 'cancelled' }).changed).toBe(false)
    })
    expect(decision(db)).toMatchObject({ status: 'resolved', closed_reason: 'cancelled' })
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'")).toBe(1)
  })

  it('维护扫描真的会跑决策超时：sweep() 一轮后卡已升级', () => {
    const db = decisionDb()
    const out = sweep(db, SECRET, { now: H2 , clock: TEST_CLOCK})
    expect(out.decisions_blocked).toBe(1)
    expect(decision(db).status).toBe('blocked_for_human')
  })

  it('到期后 run 只有在这笔扫描里才能收口：先 closeRun 无卡可收，扫描后能收', () => {
    const db = decisionDb()
    sweep(db, SECRET, { now: H2, clock: TEST_CLOCK })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', H26))).toBeNull()
    sweep(db, SECRET, { now: H26, clock: TEST_CLOCK })
    const run = db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get('r1') as { status: string }
    expect(run.status).toBe('failed')
  })
})

describe('维护扫描不会替人关掉人工核验门', () => {
  it('blocked_post 上的卡：24 小时后也不自动过期，节点与卡都留着', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'blocked_post' WHERE node_run_id = 'nr1'")
      const out = sweepDecisions(tx, SECRET, { now: H24 })
      expect(out.expired).toBe(0)
    })
    expect(decision(db).status).not.toBe('resolved')
    expect(node(db).status).toBe('blocked_post')
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'")).toBe(0)
  })

  it('run 已终态：维护扫描不改写上面的卡', () => {
    const db = decisionDb()
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'cancelled' WHERE run_id = 'r1'")
      const out = sweepDecisions(tx, SECRET, { now: H24 })
      expect(out).toMatchObject({ blocked: 0, expired: 0 })
    })
    expect(decision(db).status).toBe('pending')
    expect(decision(db).revision).toBe(1)
  })
})
