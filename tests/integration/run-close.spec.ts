import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { refreshRunSettling } from '../../src/service/commands/parallel.ts'
import { getRun } from '../../src/service/queries/runs.ts'
import { rmSync } from 'node:fs'

const SECRET = TEST_SECRET

const NOW = '2026-11-13T03:00:00.000Z'

function setup() {
  const { db } = freshLedger()
  seed(db)
  return db
}

function setNode(db: Db, patch: Record<string, string | number | null>): void {
  const cols = Object.keys(patch).map((key) => `${key} = ?`).join(', ')
  withTx(db, (tx) => tx.run(`UPDATE node_runs SET ${cols} WHERE node_run_id = 'nr1'`, Object.values(patch)))
}

const runStatus = (db: any) => (db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get() as { status: string }).status

describe('运行终态收口', () => {
  it('全部子节点 done → succeeded，并写 run.terminal', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'pure' })
    const status = withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))
    expect(status).toBe('succeeded')
    expect(runStatus(db)).toBe('succeeded')
    const count = (db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='run.terminal'").get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('Q-04 已成功运行保留 succeeded，仍有未结算动作的运行保留独立标记', () => {
    const { db, dir } = freshLedger()
    try {
      seed(db)
      setNode(db, { status: 'done', side_effect_policy: 'pure' })
      expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('succeeded')
      withTx(db, (tx) => {
        // 模拟已收口的历史记录遗留 settling。
        tx.run("UPDATE runs SET settling = 1 WHERE run_id = 'r1'")
        tx.run("INSERT INTO runs (run_id, task_id, status, created_at, updated_at) VALUES ('r2','t1','running',?,?)", [NOW, NOW])
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, side_effect_policy, created_at, updated_at) "
          + "VALUES ('parent','r2','parent',1,'agent','waiting',1,'pure',?,?)", [NOW, NOW])
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, parent_node_run_id, side_effect_policy, created_at, updated_at) "
          + "VALUES ('child','r2','child',2,'agent','started',1,'parent','irreversible',?,?)", [NOW, NOW])
        expect(refreshRunSettling(tx, 'r2', NOW)).toEqual({ settling: true, pending: ['child'] })
      })

      expect(getRun(db, 'r1')).toMatchObject({ status: 'succeeded', display_status: 'succeeded', settling: true })
      expect(getRun(db, 'r2')).toMatchObject({ status: 'running', display_status: 'running', settling: true })
    } finally {
      db.raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('有失败子节点 → failed', () => {
    const db = setup()
    setNode(db, { status: 'failed', side_effect_policy: 'pure' })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('failed')
    expect(runStatus(db)).toBe('failed')
  })

  it('失败且带未验证副作用 → failed_with_unverified', () => {
    const db = setup()
    setNode(db, { status: 'failed', side_effect_policy: 'irreversible', side_effect_verified_none: 0, stop_evidence: null })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('failed_with_unverified')
  })

  it('done 但有 stop_evidence 仍不能证明副作用已核实 → succeeded_with_unverified', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'irreversible', side_effect_verified_none: 0, stop_evidence: 'stopped-cleanly' })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('succeeded_with_unverified')
  })

  it('仍有未终态节点 → 不落终态', () => {
    const db = setup()
    setNode(db, { status: 'started' })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBeNull()
    expect(runStatus(db)).toBe('running')
  })

  it('取消过的运行即使节点全 done 也落 cancelled，不冒充成功', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'pure' })
    withTx(db, (tx) => tx.run(
      "UPDATE runs SET cancel_requested_at = ?, cancel_result = 'interrupted' WHERE run_id = 'r1'",
      [NOW],
    ))
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('cancelled')
    expect(runStatus(db)).toBe('cancelled')
  })

  it('取消优先落 cancelled，但 run.terminal 的 outcome 仍暴露失败与未核实事实', () => {
    const db = setup()
    setNode(db, { status: 'failed', side_effect_policy: 'compensable', side_effect_verified_none: 0 })
    withTx(db, (tx) => tx.run(
      "UPDATE runs SET cancel_requested_at = ?, cancel_result = 'interrupted' WHERE run_id = 'r1'",
      [NOW],
    ))
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('cancelled')
    const payload = JSON.parse((db.raw.prepare("SELECT payload_redacted AS payload FROM events WHERE type='run.terminal'").get() as { payload: string }).payload) as {
      status: string; outcome: string; failed_nodes: string[]; unverified_nodes: string[]
    }
    expect(payload.status).toBe('cancelled')
    expect(payload.outcome).toBe('failed_with_unverified')
    expect(payload.failed_nodes).toEqual(['nr1'])
    expect(payload.unverified_nodes).toEqual(['nr1'])
  })

  it('幂等：已终态再调返回 null，不追加事件', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'pure' })
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBe('succeeded')
    expect(withTx(db, (tx) => closeRun(tx, SECRET, 'r1', NOW))).toBeNull()
    const count = (db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='run.terminal'").get() as { n: number }).n
    expect(count).toBe(1)
  })
})
