import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { confirmStartup } from '../../src/service/commands/confirm-start.ts'

const NOW = '2026-11-13T03:00:00.000Z'

function startupUnknown() {
  const { db } = freshLedger()
  seed(db)
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='startup_unknown' WHERE node_run_id='nr1'"))
  return db
}

const statusOf = (db: any) => (db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='nr1'").get() as { status: string }).status

describe('确认启动 M-08/M-09/M-61', () => {
  it('没有工具调用且未声明 attested → M-08，落 stopping', () => {
    const db = startupUnknown()
    const out = confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, now: NOW })
    expect(out.trigger).toBe('confirm-started')
    expect(statusOf(db)).toBe('stopping')
  })

  it('人工声明确实启动 → M-09', () => {
    const db = startupUnknown()
    const out = confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, now: NOW, attested: true })
    expect(out.trigger).toBe('confirm-started-attested')
  })

  it('账本已有 tool_started → M-61，不接受调用方自报', () => {
    const db = startupUnknown()
    withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_started', { tool: 'x' }))
    const out = confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, now: NOW })
    expect(out.trigger).toBe('confirm-started-with-tool')
    expect(statusOf(db)).toBe('stopping')
  })

  it('非 startup_unknown 不允许确认', () => {
    const { db } = freshLedger()
    seed(db)
    expect(() => confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, now: NOW }))
      .toThrowError(/startup_unknown/)
  })
})
