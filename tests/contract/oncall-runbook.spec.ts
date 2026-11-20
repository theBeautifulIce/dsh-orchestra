import { rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createIntakeControl, sweepIntake } from '../../src/service/trial-access.ts'
import { createRun } from '../../src/service/runs.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { freshLedger, catalogFor, TEST_SECRET } from '../fixtures/ledger.ts'

it('uses the QQ connector receipt time, matches the inbox and keeps operator acknowledgment separate', () => {
  const { db, dir } = freshLedger()
  const sentAt = new Date(Date.now() - 31 * 60_000).toISOString()
  let messageId: string | null = null
  const host = createIntakeControl(db, {
    authenticate: (proof) => proof === 'operator' ? 'fixture:oncall' : null,
    lookupQqDelivery: (_inbox, invocation) => invocation === 'known' ?
      { plugin: 'dsh-onebot-qq', tool: 'qq_send_text', sentAt, sent: true, messageId } : null,
  })
  try {
    const record = () => host.recordQqDelivery('operator', 'inbox-drill', 'known', '登记宿主隔离回执')
    expect(record).toThrow()
    messageId = '-1'
    expect(record).toThrow()
    messageId = '237'
    expect(() => host.recordQqDelivery('operator', 'inbox-drill', 'unknown', '核对')).toThrow()
    expect(() => host.page('operator', 'qq:237', '直接填写')).toThrow()
    expect(() => host.recordQqDelivery('other', 'inbox-drill', 'known', '核对')).toThrow()
    const state = record()
    expect(state).toMatchObject({ paused: true, awaiting: { id: 'qq:237', inbox_id: 'inbox-drill', sent_at: sentAt } })
    expect(record()).toEqual(state)
    expect(() => host.recordQqDelivery('operator', 'other-inbox', 'known', '核对')).toThrow()
    expect(() => host.ack('operator', 'qq:238', '已读')).toThrow()
    const ack = host.ack('operator', 'qq:237', '已读')
    expect(ack).toMatchObject({ paused: true, awaiting: null })
    expect(record()).toEqual(ack)
  } finally { db.raw.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('retains the paging deadline across restart, drains existing work and resumes only after acknowledgment and authorization', () => {
  const setup = freshLedger()
  let db = setup.db
  const catalog = catalogFor(['check'])
  const baseMs = Date.now()
  const at = (offset: number) => new Date(baseMs + offset).toISOString()
  let tick = at(-1_800_001)
  const options = { authenticate: (proof: string) => proof === 'local-drill-proof' ? 'fixture:oncall' : null, now: () => tick }
  let host = createIntakeControl(db, options)
  const start = () => createRun(db, catalog, { taskTitle: '隔离演练', workflowVersion: '1', now: tick })
  try {
    const inFlight = start()
    const first = host.page('local-drill-proof', 'drill-receipt', '演练告警')
    expect(host.page('local-drill-proof', 'drill-receipt', '演练告警')).toEqual(first)
    expect(() => host.page('local-drill-proof', 'other', '演练告警')).toThrow()
    db.raw.close()
    db = openDb(setup.file)
    host = createIntakeControl(db, options)
    expect(host.get().paused).toBe(false)
    tick = at(0)
    sweepIntake(db, tick)
    expect(host.get()).toMatchObject({ paused: true, awaiting: { id: 'drill-receipt' } })
    expect(start).toThrowError(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }))
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1)
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='done',side_effect_policy='pure' WHERE run_id=?", [inFlight.run_id])
      expect(closeRun(tx, TEST_SECRET, inFlight.run_id, tick)).toBe('succeeded')
    })
    expect(() => host.resume('local-drill-proof', '未经确认')).toThrow()
    expect(() => host.ack('other', 'drill-receipt', '未授权')).toThrow()
    expect(host.ack('local-drill-proof', 'drill-receipt', '已确认').paused).toBe(true)
    expect(() => host.resume('local-drill-proof', '基于旧状态', first.revision)).toThrow()
    expect(host.resume('local-drill-proof', '现场核对完成', host.get().revision).paused).toBe(false)
    expect(start().run_id).not.toBe(inFlight.run_id)
  } finally { db.raw.close(); rmSync(setup.dir, { recursive: true, force: true }) }
})
