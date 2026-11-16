import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { applyTransition } from '../../src/service/commands/nodes.ts'

const SECRET = TEST_SECRET

const NOW = '2026-11-13T03:00:00.000Z'

function setup() {
  const { db } = freshLedger()
  seed(db)
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='dispatched' WHERE node_run_id='nr1'"))
  return db
}

const move = (db: any, context?: { cancelResult: 'already_stopped' | null; hasToolCall: boolean; hangReason: null; sideEffectVerifiedNone: boolean }) =>
  withTx(db, (tx) => applyTransition(tx, SECRET, {
    nodeRunId: 'nr1', from: ['dispatched'], to: 'done', attempt: 1, now: NOW, context,
  }))

describe('迁移前提在运行期校验', () => {
  it('只有 requires 边时，不带上下文不放行', () => {
    const db = setup()
    expect(() => move(db)).toThrowError(/前提不成立/)
  })

  it('M-29 带 already_stopped 上下文才放行', () => {
    const db = setup()
    move(db, { cancelResult: 'already_stopped', hasToolCall: false, hangReason: null, sideEffectVerifiedNone: false })
    const row = db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='nr1'").get() as { status: string }
    expect(row.status).toBe('done')
  })
})
