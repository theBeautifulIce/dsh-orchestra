// 写队列接入服务写路径：队列满时 503 + warning，且不落账本（审计 M2 的回归）
import { describe, expect, it } from 'vitest'
import { startServer, type ServerDeps } from '../src/service/server.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { createLogger } from '../src/infra/logger.ts'

const TIMEOUT = 10000

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
