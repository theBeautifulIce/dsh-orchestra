import { describe, expect, it } from 'vitest'
import { freshLedger, seed } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'

const NOW = '2026-11-13T03:00:00.000Z'

function setup() {
  const { db } = freshLedger()
  seed(db)
  return db
}

function setNode(db: any, patch: Record<string, string | number | null>): void {
  const cols = Object.keys(patch).map((key) => `${key} = ?`).join(', ')
  withTx(db, (tx) => tx.run(`UPDATE node_runs SET ${cols} WHERE node_run_id = 'nr1'`, Object.values(patch)))
}

const runStatus = (db: any) => (db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get() as { status: string }).status

describe('运行终态收口', () => {
  it('全部子节点 done → succeeded，并写 run.terminal', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'pure' })
    const status = withTx(db, (tx) => closeRun(tx, 'r1', NOW))
    expect(status).toBe('succeeded')
    expect(runStatus(db)).toBe('succeeded')
    const count = (db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='run.terminal'").get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('有失败子节点 → failed', () => {
    const db = setup()
    setNode(db, { status: 'failed', side_effect_policy: 'pure' })
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBe('failed')
    expect(runStatus(db)).toBe('failed')
  })

  it('失败且带未验证副作用 → failed_with_unverified', () => {
    const db = setup()
    setNode(db, { status: 'failed', side_effect_policy: 'irreversible', side_effect_verified_none: 0, stop_evidence: null })
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBe('failed_with_unverified')
  })

  it('done 但有 stop_evidence 仍不能证明副作用已核实 → succeeded_with_unverified', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'irreversible', side_effect_verified_none: 0, stop_evidence: 'stopped-cleanly' })
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBe('succeeded_with_unverified')
  })

  it('仍有未终态节点 → 不落终态', () => {
    const db = setup()
    setNode(db, { status: 'started' })
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBeNull()
    expect(runStatus(db)).toBe('running')
  })

  it('幂等：已终态再调返回 null，不追加事件', () => {
    const db = setup()
    setNode(db, { status: 'done', side_effect_policy: 'pure' })
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBe('succeeded')
    expect(withTx(db, (tx) => closeRun(tx, 'r1', NOW))).toBeNull()
    const count = (db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='run.terminal'").get() as { n: number }).n
    expect(count).toBe(1)
  })
})
