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
  handlers: () => { onEvent: ((event: Invalidation) => void) | null; onOpen: (() => void) | null }
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
    handlers: () => ({ onEvent: handlers.onEvent, onOpen: handlers.onOpen }),
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('事件流的可靠性', () => {
  it('正常接收事件时忽略普通面板读到的较旧和较新快照', async () => {
    const handle = makeStream()
    handle.stream.start(40)
    handle.open()
    handle.push({ seq: 41, event_id: 'e41', type: 'task.updated' })
    handle.stream.setSnapshot(40)
    handle.stream.setSnapshot(45)
    expect(handle.stream.lastEventSeq).toBe(41)

    handle.push({ seq: 42, event_id: 'e42', type: 'decision.opened' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.subscribeCalls).toEqual([40])
    expect(handle.stream.lastEventSeq).toBe(42)
    expect(handle.invalidations).toEqual(['task.updated', 'decision.opened'])
  })

  it('显式重同步到新快照时清除旧事件去重记录和等待中的刷新', async () => {
    const handle = makeStream()
    handle.stream.start(10)
    handle.push({ seq: 11, event_id: 'e11', type: 'old' })
    handle.resync()
    handle.stream.setSnapshot(10)
    handle.push({ seq: 11, event_id: 'e11', type: 'new' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.subscribeCalls).toEqual([10, 10])
    expect(handle.invalidations).toEqual(['resync_required', 'new'])
  })

  it('stop 后重启忽略旧订阅回调且允许新代次复用事件 id', async () => {
    const handle = makeStream()
    handle.stream.start(30)
    const old = handle.handlers()
    handle.push({ seq: 31, event_id: 'same', type: 'old' })
    handle.stream.stop()
    handle.stream.start(40)
    old.onOpen?.()
    old.onEvent?.({ seq: 99, event_id: 'late', type: 'old' })
    expect(handle.statuses).toEqual(['stale', 'stale'])
    handle.open()
    handle.push({ seq: 41, event_id: 'same', type: 'new' })
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['new'])
    expect(handle.stream.lastEventSeq).toBe(41)
  })

  it('轮询迟到时不会覆盖已经恢复的 SSE 状态或游标', async () => {
    let finish: (events: Invalidation[]) => void = () => {}
    const handle = makeStream(() => new Promise((resolve) => { finish = resolve }))
    handle.stream.start(10)
    handle.open()
    handle.error()
    expect(handle.statuses.at(-1)).toBe('stale')
    expect(handle.statuses).not.toContain('polling')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(handle.subscribeCalls).toEqual([10, 10])
    handle.open()
    handle.push({ seq: 11, event_id: 'fresh', type: 'fresh' })
    finish([{ seq: 11, event_id: 'late', type: 'late' }])
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.invalidations).toEqual(['fresh'])
    expect(handle.statuses.at(-1)).toBe('live')
    expect(handle.stream.lastEventSeq).toBe(11)
  })

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
    expect(handle.statuses).not.toContain('polling')
    expect(handle.statuses.at(-1)).toBe('stale')
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
