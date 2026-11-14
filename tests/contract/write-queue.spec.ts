// 写队列接入服务写路径：队列满时 503 + warning，且不落账本（审计 M2 的回归）
// 评审 P1：写队列是真 FIFO —— 同一时刻只有一笔在跑，后来的按入队顺序排队
import { describe, expect, it } from 'vitest'
import { startServer, type ServerDeps } from '../../src/service/server.ts'
import { WriteQueue } from '../../src/service/write-queue.ts'
import { createLogger } from '../../src/infra/logger.ts'

const TIMEOUT = 10000
const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

describe('写队列', () => {
  it('超过上限直接抛 SERVICE_UNAVAILABLE', async () => {
    const q = new WriteQueue(2)
    let release: () => void = () => {}
    const hang = (): Promise<void> => new Promise<void>((r) => { release = r })
    void q.run(hang)
    void q.run(hang)
    await expect(q.run(() => 1)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    release()
  })

  it('真 FIFO：同一时刻只有一笔在跑，后来的按入队顺序执行', async () => {
    const q = new WriteQueue(10)
    const order: number[] = []
    let active = 0
    let maxActive = 0
    const tasks = [0, 1, 2].map((i) => q.run(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(i)
      await delay(5)
      active -= 1
      return i
    }))
    const results = await Promise.all(tasks)
    expect(results).toEqual([0, 1, 2])
    expect(order).toEqual([0, 1, 2])
    expect(maxActive).toBe(1)
  })

  it('一笔失败不卡住后面的笔：链尾照样接上', async () => {
    const q = new WriteQueue(10)
    const bad = q.run(async () => { throw new Error('boom') })
    await expect(bad).rejects.toThrow('boom')
    const good = await q.run(async () => 'ok')
    expect(good).toBe('ok')
    expect(q.size).toBe(0)
  })

  it('size 是已受理未做完的笔数，capacity 是上限', async () => {
    const q = new WriteQueue(4)
    expect(q.capacity).toBe(4)
    expect(q.size).toBe(0)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const running = q.run(() => gate)
    const queued = q.run(() => gate)
    // 两笔都已受理：一笔在跑，一笔在排
    expect(q.size).toBe(2)
    release()
    await running
    await queued
    expect(q.size).toBe(0)
  })

  it('服务写入口走队列：满时 503、记 warning、不落账本', async () => {
    const lines: string[] = []
    const log = createLogger({ write: (line: string) => { lines.push(line) } })
    let appended = 0
    const deps: ServerDeps = {
      secret: 's1-test',
      phase: 'S1',
      epoch: 1,
      asOfSeq: () => 0,
      listTasks: () => [],
      listEvents: () => [],
      appendLedgerEvent: () => { appended += 1; return { seq: appended, event_id: 'evt_' + String(appended) } },
      log,
      queue: new WriteQueue(0, log),
    }
    const s = await startServer(deps)
    try {
      const res = await fetch(s.endpoint + '/v1/ledger/events', {
        method: 'POST',
        headers: { 'x-orchestra-secret': deps.secret, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SERVICE_UNAVAILABLE')
      expect(appended).toBe(0)
      expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('写队列满了'))).toBe(true)
    } finally {
      await s.close()
    }
  }, TIMEOUT)
})
