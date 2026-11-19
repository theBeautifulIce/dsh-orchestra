// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { EventStream, type Invalidation, type StreamStatus } from '../../src/client/api/sse.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { createFakeService, deferred, page, renderPanel } from './harness.ts'

it('Q-17 / Q-18 面板用快照续传，重复不增行，断号丢弃旧读并重新读取时间线', async () => {
  const subscriptions: number[] = []
  const staleRead = deferred<{ ok: true; asOfSeq: number; data: unknown }>()
  let deliver: (event: Invalidation) => void = () => {}
  let currentSequence = 40
  let nextReadIsStale = false
  const event = (seq: number) => ({ seq, event_id: `event-${seq}`, type: `测试事件 ${seq}`, occurred_at: '2026-11-19T00:00:00Z', details: [] })
  const service = createFakeService(({ path }) => {
    if (path === '/v1/events') return { ok: true, asOfSeq: currentSequence, data: { items: [], next_cursor: null } }
    if (path !== '/v1/activity') throw new Error('unexpected query ' + path)
    if (nextReadIsStale) {
      nextReadIsStale = false
      return staleRead.promise
    }
    return { ok: true, asOfSeq: currentSequence, data: { items: [event(currentSequence)], next_before_seq: null } }
  })
  const createEventStream = (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) => new EventStream({
    subscribe(afterSeq, onEvent, _, _error, onOpen) {
      subscriptions.push(afterSeq)
      deliver = onEvent
      onOpen()
      return () => {}
    },
    readAfter: async () => [], onInvalidate, onStatus, coalesceMs: 0,
  })
  const client = createApiClient('http://panel.test', service.fetcher)
  const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="activity" createEventStream={createEventStream} />)
  expect(subscriptions).toEqual([40])
  expect(view.text()).toContain('测试事件 40')

  const bubble = async (seq: number) => {
    await act(async () => {
      deliver(event(seq))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  currentSequence = 41
  await bubble(41)
  const afterFirst = service.calls.length
  await bubble(41)
  expect(service.calls).toHaveLength(afterFirst)
  expect(view.findAll('li').map((item) => item.querySelector('strong')?.textContent)).toEqual(['测试事件 41'])

  currentSequence = 42
  nextReadIsStale = true
  await bubble(42)
  currentSequence = 44
  await bubble(44)
  expect(subscriptions).toEqual([40, 44])
  expect(view.text()).toContain('测试事件 44')
  staleRead.resolve({ ok: true, asOfSeq: 42, data: { items: [event(42)], next_before_seq: null } })
  await view.flush()
  expect(view.text()).not.toContain('测试事件 42')
  currentSequence = 45
  await bubble(45)
  expect(subscriptions).toEqual([40, 44])
  expect(view.text()).toContain('测试事件 45')
  view.unmount()
})

it('Q-17 没有屏幕快照回调的设置页自动从通用账本快照恢复订阅', async () => {
  const subscriptions: number[] = []
  let deliver: (event: Invalidation) => void = () => {}
  const service = createFakeService(({ path }) => {
    if (path === '/v1/tasks') return { ok: true, asOfSeq: 40, data: page([]) }
    if (path === '/v1/events') return { ok: true, asOfSeq: 42, data: page([]) }
    throw new Error('unexpected query ' + path)
  })
  const createEventStream = (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) => new EventStream({
    subscribe(afterSeq, onEvent, _, _error, onOpen) {
      subscriptions.push(afterSeq)
      deliver = onEvent
      onOpen()
      return () => {}
    },
    readAfter: async () => [], onInvalidate, onStatus,
  })
  const client = createApiClient('http://panel.test', service.fetcher)
  const view = await renderPanel(<PanelApp client={client} serviceConnected createEventStream={createEventStream} />)
  try {
    expect(subscriptions).toEqual([40])
    await view.click(view.findAll('button').find((item) => item.textContent === '设置')!)
    await act(async () => { deliver({ seq: 42, type: 'fixture.gap', event_id: 'event-42' }) })
    expect(subscriptions).toEqual([40, 42])
    expect(service.calls.filter(({ path }) => path === '/v1/events')).toHaveLength(1)
    expect(view.text()).toContain('实时更新')
    expect(view.text()).not.toContain('数据可能已过期')
  } finally {
    view.unmount()
  }
})
