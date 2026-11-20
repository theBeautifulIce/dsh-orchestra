import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { summarizeLag, type LagObservation } from '../../scripts/event-lag.ts'
import { serveOrchestra } from '../../src/index.ts'
import { appendEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { createSseSubscribe } from '../../src/client/api/sse-fetch.ts'
import { WriteQueue } from '../../src/service/write-queue.ts'
import { createLogger } from '../../src/infra/logger.ts'
import { startServer } from '../../src/service/server.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import { listEvents } from '../../src/service/queries/list_events.ts'

it('recomputes all slots, thresholds and ten-minute alarms independently', () => {
  const window = { startMs: 0, slotMs: 30_000, slots: 20, slotsPerSlice: 2 }
  const data = (lags: number[]) => lags.map((ms, i) => ({
    slot: i, seq: i + 1, committedMs: i * 30_000, observedMs: i * 30_000 + ms,
  }))
  const baseline = data(Array(20).fill(2_000))
  expect(summarizeLag(baseline, window)).toMatchObject({ passed: true, alert: false })
  expect(summarizeLag(data([10_000, ...Array(19).fill(2_000)]), { ...window, slotsPerSlice: 20 })).toMatchObject({ passed: true })
  expect(summarizeLag(data([11_000, ...Array(19).fill(0)]), window)).toMatchObject({ passed: false, alert: false })
  expect(summarizeLag(data(Array(20).fill(2_001)), window)).toMatchObject({ passed: false, alert: true })
  for (const bad of [[], baseline.slice(1), [...baseline, baseline[19]!],
    [{ ...baseline[0]!, observedMs: null }, ...baseline.slice(1)],
    [{ ...baseline[0]!, observedMs: -1 }, ...baseline.slice(1)]]) {
    expect(summarizeLag(bad, window)).toMatchObject({ passed: false, complete: false })
  }
})

it('measures a committed ledger event through the production HTTP and panel SSE transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's6-lag-'))
  const secret = randomUUID()
  let committed: Omit<LagObservation, 'observedMs'> | undefined
  let seq = 0
  let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
  let stop: (() => void) | undefined
  try {
    service = await serveOrchestra({ dbFile: join(dir, 'ledger.db'), phase: 'S6', secret,
      asOfSeq: () => seq, listTasks: () => [], listEvents: () => [], appendLedgerEvent() {
        const receipt = withTx(service!.orchestra.db, (tx) => appendEvent(tx, { type: 's6.lag_probe' }))
        seq = receipt.seq
        committed = { slot: 0, seq, committedMs: performance.now() }
        return receipt
      },
    })
    const headers = { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
    const subscribe = createSseSubscribe(fetch, service.endpoint, { headers })
    const open = Promise.withResolvers<void>()
    const received = Promise.withResolvers<LagObservation>()
    const failed = () => { const err = new Error('SSE observer lost its window'); open.reject(err); received.reject(err) }
    stop = subscribe(0, (event) => {
      if (event.type === 's6.lag_probe' && committed?.seq === event.seq) received.resolve({ ...committed, observedMs: performance.now() })
    }, failed, failed, open.resolve)
    const startMs = performance.now()
    await open.promise
    const response = await fetch(service.endpoint + '/v1/ledger/events', { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(200)
    const row = await received.promise
    expect(summarizeLag([row], { startMs, slotMs: 10_000, slots: 1, slotsPerSlice: 1 })).toMatchObject({ passed: true, alert: false })
  } finally { stop?.(); await service?.close(); rmSync(dir, { recursive: true, force: true }) }
}, 15_000)

it('reads a file-backed ledger while the default 1000-slot queue is full, rejects the 1001st write and drains in order', async () => {
  const { dir, db } = freshLedger()
  const logs: string[] = []
  const logger = createLogger({ write: (line) => logs.push(line) })
  const queue = new WriteQueue(undefined, logger)
  const secret = randomUUID()
  const release = Promise.withResolvers<void>()
  const write = (index: number) => withTx(db, (tx) => appendEvent(tx, { type: 's6.queue', payload: { index } }))
  const server = await startServer({ secret, phase: 'S6', epoch: 1, log: logger, queue, asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => listEvents(db, { limit: 1 }).rows, appendLedgerEvent: () => write(1000),
  })
  const headers = { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
  const accepted = [queue.run(async () => { await release.promise; return write(0) })]
  try {
    for (let i = 1; i < 1000; i++) accepted.push(queue.run(() => write(i)))
    expect(queue.size).toBe(queue.capacity)
    const refused = await fetch(server.endpoint + '/v1/ledger/events', { method: 'POST', headers, body: '{}' })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
    expect(logs.some((line) => line.includes('"level":"warn"') && line.includes('1000'))).toBe(true)
    const read = await fetch(server.endpoint + '/v1/events', { headers })
    expect(read.status).toBe(200)
    expect(listEvents(db, { limit: 1 }).rows).toHaveLength(0)
    release.resolve()
    const receipts = await Promise.all(accepted)
    expect(queue.size).toBe(0)
    expect(receipts.map((item) => item.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(1000)
  } finally {
    release.resolve()
    await Promise.allSettled(accepted)
    await server.close()
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
