import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { BridgeEventBuffer, type BridgeEvent } from '../../src/executor/bridge.ts'
import { BridgeConsumer } from '../../src/executor/bridge-consumer.ts'
import { BridgeLedger } from '../../src/executor/bridge-ledger.ts'
import { OrchError } from '../../src/core/errors.ts'
import { openDb, type Db } from '../../src/infra/sqlite/driver.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const dirs: string[] = []
const dbs: Db[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.raw.close() } catch { /* 已关闭 */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ev(seq: number, payload: unknown = { seq }): BridgeEvent {
  return { seq, type: 'step', at: '2026-01-01T00:00:00Z', toolStartAt: null, payload }
}

function ledgerFor(db: Db, attempt = 1, agent = 'a1'): BridgeLedger {
  return new BridgeLedger(db, TEST_SECRET, { nodeRunId: 'nr1', attempt, executorAgentId: agent })
}

function count(db: Db, sql: string, params: unknown[] = []): number {
  return Number((db.raw.prepare(sql).get(...(params as never[])) as { n: number }).n)
}

describe('R5-B 桥事件落账', () => {
  it('连续事件逐条落账并推进持久游标', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    const r1 = ledger.ingest(ev(1))
    const r2 = ledger.ingest(ev(2))
    expect(r1.appended).toBe(true)
    expect(r2.appended).toBe(true)
    expect(ledger.cursor()).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM node_run_events')).toBe(3)
  })

  it('同 seq 同 payload 幂等；不同 payload 协议冲突且不落账', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    ledger.ingest(ev(1))
    const dup = ledger.ingest(ev(1))
    expect(dup.appended).toBe(false)
    expect(dup.ackSeq).toBe(1)
    expect(() => ledger.ingest(ev(1, { seq: 1, changed: true }))).toThrowError(/协议冲突/)
    expect(ledger.cursor()).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(1)
  })

  it('跳号不落账：游标与 receipt 都不动', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    expect(() => ledger.ingest(ev(2))).toThrowError(/不连续/)
    expect(ledger.cursor()).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(0)
  })

  it('账本事务失败：游标不推进、receipt 不写、链不增长', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    // 挂在最后一条写（游标）上，才能验到前面的事件与 receipt 一起回滚
    db.raw.exec("CREATE TRIGGER bridge_boom BEFORE INSERT ON bridge_stream_cursors BEGIN SELECT RAISE(ABORT, 'boom'); END")
    expect(() => ledger.ingest(ev(1))).toThrow()
    db.raw.exec('DROP TRIGGER bridge_boom')
    expect(ledger.cursor()).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM node_run_events')).toBe(1)
  })

  it('提交后重启：从持久游标恢复，新 buffer 从 ack+1 接上', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    ledger.ingest(ev(1))
    ledger.ingest(ev(2))
    db.raw.close()
    const reopened = openDb(dir + '/orchestra.db')
    const ledger2 = ledgerFor(reopened)
    expect(ledger2.cursor()).toBe(2)
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: dir, agentId: 'a1' }, { lastPersistedAckSeq: ledger2.cursor(), lookupPersisted: () => undefined })
    expect(buf.push(ev(3)).gapFrom).toBeNull()
    expect(ledger2.ingest(ev(3)).appended).toBe(true)
    expect(ledger2.cursor()).toBe(3)
    reopened.raw.close()
  })

  it('本地账本提交后宿主显式 ACK 失败：不回滚，重试幂等', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: dir, agentId: 'a1' })
    const hostAck = (): void => { throw new Error('host ack failed') }
    const consume = (): void => {
      buf.push(ev(1))
      ledger.ingest(ev(1))
      buf.ack(1, ledger.cursor())
      hostAck()
    }
    expect(consume).toThrowError(/host ack failed/)
    expect(ledger.cursor()).toBe(1)
    expect(buf.lastPersistedAckSeq).toBe(1)
    expect(ledger.ingest(ev(1)).appended).toBe(false)
    expect(ledger.cursor()).toBe(1)
  })

  it('缺口事件无法落账：游标保持未确认', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    const buf = new BridgeEventBuffer({ limitBytes: 8192, highWaterBytes: 4096, spillDir: dir, agentId: 'a1' })
    expect(buf.push(ev(5)).gapFrom).toBe(1)
    expect(() => ledger.ingest(ev(5))).toThrowError(/不连续/)
    expect(ledger.cursor()).toBe(0)
    expect(buf.lastPersistedAckSeq).toBe(0)
    expect(buf.lastContiguousSeq).toBe(0)
  })

  it('事件自带 attempt/agent 与当前账本不一致 → 拒绝且不落账', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    expect(() => ledger.ingest({ ...ev(1), attempt: 2 })).toThrowError(/attempt 与当前账本不一致/)
    expect(() => ledger.ingest({ ...ev(1), executorAgentId: 'a2' })).toThrowError(/executorAgentId 与当前账本不一致/)
    expect(ledger.cursor()).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(0)
  })

  it('旧 attempt 不污染新 attempt 的游标', () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const oldAttempt = ledgerFor(db, 1)
    oldAttempt.ingest(ev(1))
    const newAttempt = ledgerFor(db, 2)
    expect(newAttempt.cursor()).toBe(0)
    expect(newAttempt.ingest(ev(1)).appended).toBe(true)
    expect(oldAttempt.cursor()).toBe(1)
    expect(newAttempt.cursor()).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(2)
  })

  it('onEvent 失败只推进已落账位：重连从已处理位重放，不跳过该事件', async () => {
    const { dir, db } = freshLedger()
    dirs.push(dir)
    dbs.push(db)
    seed(db)
    const ledger = ledgerFor(db)
    const buf = new BridgeEventBuffer(
      { limitBytes: 8192, highWaterBytes: 4096, spillDir: dir, agentId: 'a1' },
      { lastPersistedAckSeq: ledger.handled(), lookupPersisted: (seq) => ledger.lookup(seq) },
    )
    let calls = 0
    const consumer = new BridgeConsumer({} as never, buf, ledger, async () => {
      calls += 1
      if (calls === 1) throw new OrchError('SERVICE_UNAVAILABLE', '宿主暂不可用')
    })
    await expect(consumer.receive(ev(1))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(ledger.cursor()).toBe(1)
    expect(ledger.handled()).toBe(0)
    await consumer.receive(ev(1))
    expect(calls).toBe(2)
    expect(ledger.cursor()).toBe(1)
    expect(ledger.handled()).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM bridge_event_receipts')).toBe(1)
  })
})
