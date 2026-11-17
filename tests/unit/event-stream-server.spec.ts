import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { nextSeq, startEventStream, type EventPage } from '../../src/service/events/stream.ts'

type FakeResponse = {
  chunks: string[]
  destroyed: boolean
  writableEnded: boolean
  writableLength: number
  writeHead: () => void
  write: (chunk: string) => boolean
  end: () => void
  once: (event: string, handler: () => void) => void
  on: (event: string, handler: () => void) => void
}

function fakeResponse(): FakeResponse {
  const chunks: string[] = []
  const listeners: Record<string, () => void> = {}
  const res: FakeResponse = {
    chunks,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    writeHead: () => undefined,
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: () => { res.writableEnded = true },
    once: (event: string, handler: () => void) => { listeners[event] = handler },
    on: (event: string, handler: () => void) => { listeners[event] = handler },
  }
  return res
}

function fakeRequest(): { once: (event: string, handler: () => void) => void } {
  const listeners: Record<string, () => void> = {}
  return { once: (event: string, handler: () => void) => { listeners[event] = handler } }
}

function pagesInOrder(pages: EventPage[]): (afterSeq: number, limit: number) => EventPage {
  let index = 0
  return () => pages[index++] ?? { rows: [], as_of_seq: 10 }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('事件流的序号规则', () => {
  it('只有紧挨着的序号才算继续，否则返回 null', () => {
    expect(nextSeq(10, 11)).toBe(11)
    expect(nextSeq(10, 12)).toBeNull()
    expect(nextSeq(10, 10)).toBeNull()
  })
})

describe('服务端事件流', () => {
  it('序号连续：逐条发出 invalidation 帧', async () => {
    const res = fakeResponse()
    const pages: EventPage[] = [
      { rows: [{ seq: 11, event_id: 'e1', type: 'task.updated' }], as_of_seq: 11 },
      { rows: [{ seq: 12, event_id: 'e2', type: 'workflow.updated' }], as_of_seq: 12 },
    ]
    startEventStream(
      fakeRequest() as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      pagesInOrder(pages),
      10,
    )
    expect(res.chunks[0]).toBe(': connected\n\n')

    await vi.advanceTimersByTimeAsync(250)
    expect(res.chunks[1]).toBe('id: 11\nevent: invalidation\ndata: {"seq":11,"event_id":"e1","type":"task.updated"}\n\n')

    await vi.advanceTimersByTimeAsync(250)
    expect(res.chunks[2]).toBe('id: 12\nevent: invalidation\ndata: {"seq":12,"event_id":"e2","type":"workflow.updated"}\n\n')
    expect(res.writableEnded).toBe(false)
  })

  it('序号有缺口：发出 resync_required 并带上应有的序号和实际序号', async () => {
    const res = fakeResponse()
    const pages: EventPage[] = [
      { rows: [{ seq: 11, event_id: 'e1', type: 'task.updated' }], as_of_seq: 11 },
      { rows: [{ seq: 13, event_id: 'e3', type: 'task.updated' }], as_of_seq: 13 },
    ]
    startEventStream(
      fakeRequest() as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      pagesInOrder(pages),
      10,
    )
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    expect(res.chunks[2]).toBe('event: resync_required\ndata: {"expected_seq":12,"actual_seq":13,"as_of_seq":13}\n\n')
    expect(res.writableEnded).toBe(true)

    const count = res.chunks.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(res.chunks.length).toBe(count)
  })

  it('重复的序号同样按缺口处理：要求客户端整体重同步', async () => {
    const res = fakeResponse()
    const pages: EventPage[] = [
      { rows: [{ seq: 11, event_id: 'e1', type: 'task.updated' }], as_of_seq: 11 },
      { rows: [{ seq: 11, event_id: 'e1', type: 'task.updated' }], as_of_seq: 11 },
    ]
    startEventStream(
      fakeRequest() as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      pagesInOrder(pages),
      10,
    )
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    expect(res.chunks[2]).toBe('event: resync_required\ndata: {"expected_seq":12,"actual_seq":11,"as_of_seq":11}\n\n')
    expect(res.writableEnded).toBe(true)
  })
})
