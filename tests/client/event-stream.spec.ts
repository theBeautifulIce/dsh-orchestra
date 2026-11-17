import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventStream, type Invalidation, type StreamStatus } from '../../src/client/api/sse.ts'

type ReadAfter = (afterSeq: number, limit: number) => Promise<Invalidation[]>

type StreamHandle = {
  stream: EventStream
  statuses: StreamStatus[]
  invalidations: string[]
  subscribeCalls: number[]
  readonly unsubscribed: number
  push: (event: Invalidation) => void
  open: () => void
  error: () => void
  resync: () => void
}

function makeStream(readAfter: ReadAfter = async () => []): StreamHandle {
  const statuses: StreamStatus[] = []
  const invalidations: string[] = []
  const subscribeCalls: number[] = []
  const handlers: {
    onEvent: ((event: Invalidation) => void) | null
    onResyncRequired: (() => void) | null
    onError: (() => void) | null
    onOpen: (() => void) | null
  } = { onEvent: null, onResyncRequired: null, onError: null, onOpen: null }
  let unsubscribed = 0
  const stream = new EventStream({
    subscribe(afterSeq, onEvent, onResyncRequired, onError, onOpen) {
      subscribeCalls.push(afterSeq)
      handlers.onEvent = onEvent
      handlers.onResyncRequired = onResyncRequired
      handlers.onError = onError
      handlers.onOpen = onOpen
      return () => { unsubscribed += 1 }
    },
    readAfter,
    onInvalidate: (type) => { invalidations.push(type) },
    onStatus: (status) => { statuses.push(status) },
    coalesceMs: 10,
    pollIntervalMs: 5000,
  })
  return {
    stream,
    statuses,
    invalidations,
    subscribeCalls,
    get unsubscribed() { return unsubscribed },
    push: (event) => { handlers.onEvent?.(event) },
    open: () => { handlers.onOpen?.() },
    error: () => { handlers.onError?.() },
    resync: () => { handlers.onResyncRequired?.() },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('事件流的可靠性', () => {
  it('重复投递同一个事件：只算一次，不重复触发刷新', async () => {
    const handle = makeStream()
    handle.stream.start(10)
    expect(handle.subscribeCalls).toEqual([10])
    expect(handle.statuses).toEqual(['stale'])
    handle.open()
    expect(handle.statuses).toEqual(['stale', 'live'])

    handle.push({ seq: 11, event_id: 'e1', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['task.updated'])
    expect(handle.stream.lastEventSeq).toBe(11)

    handle.push({ seq: 11, event_id: 'e1', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['task.updated'])
    expect(handle.stream.lastEventSeq).toBe(11)
  })

  it('序号有缺口：标成过期并要求完整重同步，缺口之后的事件不再单独投递', async () => {
    const handle = makeStream()
    handle.stream.start(10)
    handle.open()

    handle.push({ seq: 12, event_id: 'e2', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['resync_required'])
    expect(handle.statuses).toContain('stale')
    expect(handle.stream.lastEventSeq).toBe(10)
    expect(handle.unsubscribed).toBe(1)

    handle.push({ seq: 13, event_id: 'e3', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['resync_required'])
    expect(handle.stream.lastEventSeq).toBe(10)
  })

  it('重同步之后重新订阅：事件序号接上以后恢复正常投递', async () => {
    const handle = makeStream()
    handle.stream.start(10)
    handle.open()
    handle.push({ seq: 12, event_id: 'e2', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)

    handle.stream.setSnapshot(12)
    expect(handle.subscribeCalls).toEqual([10, 12])
    handle.open()

    handle.push({ seq: 13, event_id: 'e4', type: 'task.updated' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['resync_required', 'task.updated'])
    expect(handle.stream.lastEventSeq).toBe(13)
  })

  it('连接断开：转入轮询状态，轮询拿到的事件照常投递', async () => {
    const reads: number[] = []
    const handle = makeStream(async (afterSeq) => {
      reads.push(afterSeq)
      return afterSeq < 11 ? [{ seq: 11, event_id: 'e1', type: 'task.updated' }] : []
    })
    handle.stream.start(10)
    handle.open()

    handle.error()
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.statuses).toContain('polling')
    expect(reads[0]).toBe(10)
    expect(handle.invalidations).toContain('task.updated')
    expect(handle.stream.lastEventSeq).toBe(11)
  })

  it('轮询也失败：状态退回过期', async () => {
    const handle = makeStream(async () => { throw new Error('读不到事件') })
    handle.stream.start(10)
    handle.open()

    handle.error()
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.statuses).toContain('polling')
    expect(handle.statuses).toContain('stale')
  })

  it('断线一段时间后重新订阅：状态回到实时', async () => {
    const handle = makeStream(async () => [])
    handle.stream.start(10)
    handle.open()
    handle.error()
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.statuses).toContain('polling')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(handle.subscribeCalls.length).toBe(2)
    handle.open()
    expect(handle.statuses[handle.statuses.length - 1]).toBe('live')
  })
})
