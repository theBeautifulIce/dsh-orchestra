import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { createApiClient, type FetchLike } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { EventStream, type Invalidation } from '../../src/client/api/sse.ts'
import { PanelApp, type PanelAppProps } from '../../src/client/panel/app.tsx'
import { PanelHost } from '../../src/client/panel-host.tsx'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { seed } from '../fixtures/ledger.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'
import type { PanelView } from './harness.ts'

type TestDom = { window: Window & typeof globalThis }
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => TestDom
}
let dom: TestDom
let deferred: typeof import('./harness.ts')['deferred']
let renderPanel: typeof import('./harness.ts')['renderPanel']
beforeAll(async () => {
  // Keep Node's server modules and fetch in the Node test environment.
  dom = new JSDOM('', { url: 'http://panel.test', pretendToBeVisual: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event'] as const) {
    vi.stubGlobal(key, dom.window[key])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const harness = await import('./harness.ts')
  deferred = harness.deferred
  renderPanel = harness.renderPanel
})
afterAll(() => {
  dom?.window.close()
  vi.unstubAllGlobals()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function boot(wrap?: (send: FetchLike) => FetchLike, executor?: Parameters<typeof serveOrchestra>[0]['executor']) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-panel-stream-'))
  const secret = 'panel-stream-contract'
  const service = await serveOrchestra({
    dbFile: join(directory, 'orchestra.sqlite'), secret, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    executor,
  })
  cleanups.push(async () => {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const { db } = service.orchestra
  seed(db)
  const send: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', secret)
    return fetch(input, { ...init, headers })
  }
  const client = createApiClient(service.endpoint, wrap?.(send) ?? send)
  const api = createResourcesApi(client)
  return {
    db, send, client, api, endpoint: service.endpoint,
    addEvent: (type: string) => withTx(db, (tx) => ({ ...appendEvent(tx, { type }), type })),
  }
}

function button(view: PanelView, text: string): HTMLButtonElement {
  const found = view.findAll('button').find((candidate) => candidate.textContent?.trim() === text)
  if (!found) throw new Error('面板未显示按钮 ' + text)
  return found as HTMLButtonElement
}

async function waitFor(view: PanelView, predicate: () => unknown) {
  await expect.poll(async () => {
    await view.flush()
    return predicate()
  }, { timeout: 3000 }).toBeTruthy()
}

async function firstBacklogEvent(send: FetchLike, endpoint: string, afterSeq: number): Promise<Invalidation> {
  const response = await send(endpoint + '/v1/events/stream', {
    headers: { 'Last-Event-ID': String(afterSeq) }, signal: AbortSignal.timeout(3000),
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) throw new Error('SSE 未补齐事件就结束')
      buffer += decoder.decode(result.value, { stream: true })
      const event = /id: (\d+)\nevent: invalidation\ndata: ([^\n]+)\n\n/.exec(buffer)
      if (!event) continue
      const data = JSON.parse(event[2]!) as Invalidation
      expect(Number(event[1])).toBe(data.seq)
      return data
    }
  } finally {
    await reader.cancel()
  }
}

it('Q-16 丢失已提交响应后按原 operation_id 读取 applied，面板刷新仅归档一次', async () => {
  const commands: string[] = []
  const receipts: Array<{ id: string; status: string; kind: string }> = []
  const { client, db } = await boot((send) => async (input, init) => {
    const url = new URL(String(input))
    const response = await send(input, init)
    if (url.pathname === '/v1/tasks/archive') {
      commands.push(JSON.parse(String(init?.body)).operation_id)
      expect((await response.json()).ok).toBe(true)
      throw new Error('服务完成提交后，传输丢弃响应')
    }
    if (url.pathname === '/v1/operations/get') {
      const { data } = await response.clone().json()
      receipts.push({ id: url.searchParams.get('operation_id')!, status: data.status, kind: data.kind })
    }
    return response
  })
  const view = await renderPanel(<PanelApp client={client} serviceConnected />)
  try {
    await waitFor(view, () => view.text().includes('样本任务'))
    await view.click(button(view, '样本任务'))
    await waitFor(view, () => view.text().includes('归档任务'))
    await view.click(button(view, '归档任务'))
    await view.click(button(view, '确认归档'))
    await waitFor(view, () => view.text().includes('已归档，运行记录仍可查看。'))
    expect(commands).toHaveLength(1)
    expect(receipts).toEqual([{ id: commands[0], status: 'applied', kind: 'task.archive' }])
    await view.click(button(view, '关闭'))
    await waitFor(view, () => !view.text().includes('样本任务'))
    await view.click(button(view, '归档箱'))
    await waitFor(view, () => view.text().includes('样本任务'))
    expect(commands).toHaveLength(1)
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task.archived'").get()).toEqual({ n: 1 })
    expect(db.raw.prepare("SELECT operation_id, status FROM inbox WHERE kind = 'task.archive'").all())
      .toEqual([{ operation_id: commands[0], status: 'applied' }])
  } finally {
    view.unmount()
  }
}, 12_000)

it('Q-17/Q-18 面板迟到快照不倒退，断号整页重取并续传，重复事件只显示一行', async () => {
  let holdRead: { reached: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined
  let activityReads = 0
  const { addEvent, client, api, send, endpoint } = await boot((transport) => async (input, init) => {
    const path = new URL(String(input)).pathname
    const response = await transport(input, init)
    if (path === '/v1/activity') {
      activityReads++
      const held = holdRead
      holdRead = undefined
      if (held) {
        held.reached.resolve()
        await held.release.promise
      }
    }
    return response
  })
  const initial = (await api.listActivity()).as_of_seq
  const subscriptions: Array<{ after: number; onEvent: (event: Invalidation) => void; close: ReturnType<typeof vi.fn> }> = []
  let stream!: EventStream
  const createEventStream: NonNullable<PanelAppProps['createEventStream']> = (onInvalidate, onStatus) => {
    stream = new EventStream({
      onInvalidate, onStatus, coalesceMs: 75,
      subscribe(after, onEvent, _resync, _error, onOpen) {
        const close = vi.fn()
        subscriptions.push({ after, onEvent, close })
        onOpen()
        return close
      },
      readAfter: async (from_seq, limit) => (await api.listEvents({ from_seq, limit })).data.items,
    })
    return stream
  }
  const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="activity" createEventStream={createEventStream} />)
  const late = { reached: deferred<void>(), release: deferred<void>() }
  const resync = { reached: deferred<void>(), release: deferred<void>() }
  try {
    await waitFor(view, () => subscriptions.length === 1)
    const first = subscriptions[0]!
    expect(first.after).toBe(initial)
    const applySnapshot = vi.spyOn(stream, 'setSnapshot')
    holdRead = late
    const one = addEvent('fixture.first')
    first.onEvent(one)
    await late.reached.promise
    const two = addEvent('fixture.second')
    first.onEvent(two)
    late.release.resolve()
    await waitFor(view, () => applySnapshot.mock.calls.some(([seq]) => seq === one.seq))
    expect(stream.lastEventSeq).toBe(two.seq)
    expect(subscriptions.map(({ after }) => after)).toEqual([initial])
    await waitFor(view, () => view.text().includes(two.type))

    const omitted = addEvent('fixture.omitted')
    const gap = addEvent('fixture.gap')
    holdRead = resync
    await act(async () => { first.onEvent(gap) })
    await resync.reached.promise
    expect(first.close).toHaveBeenCalledOnce()
    expect(stream.lastEventSeq).toBe(two.seq)
    expect(subscriptions).toHaveLength(1)
    const duringRefresh = addEvent('fixture.after_snapshot')
    resync.release.resolve()
    await waitFor(view, () => subscriptions.length === 2 && view.text().includes(omitted.type))
    expect(view.text()).toContain(gap.type)
    const resumed = subscriptions[1]!
    expect(resumed.after).toBe(gap.seq)
    const backlog = await firstBacklogEvent(send, endpoint, resumed.after)
    expect(backlog).toEqual(duringRefresh)
    resumed.onEvent(backlog)
    await waitFor(view, () => view.text().includes(backlog.type))
    const beforeDuplicate = activityReads
    resumed.onEvent(backlog)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
    const rows = view.findAll('[aria-label="账本活动"] ol > li')
    expect(rows.filter((row) => row.textContent?.includes(backlog.type))).toHaveLength(1)
    expect(activityReads).toBe(beforeDuplicate)
    expect(stream.lastEventSeq).toBe(backlog.seq)
  } finally {
    late.release.resolve()
    resync.release.resolve()
    view.unmount()
  }
}, 12_000)

it('Q-17 / Q-20 设置页断号时新一轮账本、健康与模型读取完成后恢复写入', async () => {
  const registry = new ToolRegistry()
  const hold = () => ({ entered: deferred<void>(), release: deferred<void>() })
  const lateModel = hold()
  const lateHealth = hold()
  const freshModel = hold()
  let modelGate: ReturnType<typeof hold> | undefined
  let healthGate: ReturnType<typeof hold> | undefined
  let modelWrites = 0
  const subscriptions: Array<{ after: number; deliver: (event: Invalidation) => void }> = []
  const { client, endpoint, addEvent } = await boot(undefined, {
    registry,
    runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, '.'),
    agents: { create: async () => ({ agentId: 'fixture', sessionId: 'fixture' }) },
    bridge: fakeAgentClient({ agentId: 'fixture', steps: [] }),
    modelRouting: { profiles: [{ ref: 'fast', capacity: 'routine' }, { ref: 'strong', capacity: 'complex' }],
      recommend: () => ({ complexity: 'routine', reason: 'fixture' }) },
  })
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/events/stream') {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          subscriptions.push({ after: Number(url.searchParams.get('after_seq')),
            deliver: (event) => controller.enqueue(encoder.encode(`event: invalidation\ndata: ${JSON.stringify(event)}\n\n`)) })
          init?.signal?.addEventListener('abort', () => {
            try { controller.close() } catch { /* Reader may already have cancelled. */ }
          }, { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', 'panel-stream-contract')
    const response = await fetch(input, { ...init, headers })
    const model = url.pathname === '/v1/settings/model-routing'
    if (model && init?.method === 'POST') modelWrites++
    const gate = model && init?.method !== 'POST' ? modelGate : url.pathname === '/health' ? healthGate : undefined
    if (gate) {
      if (model) modelGate = undefined
      else healthGate = undefined
      gate.entered.resolve()
      await gate.release.promise
    }
    return response
  }
  const view = await renderPanel(<PanelHost baseUrl={endpoint} fetcher={fetcher} />)
  const selected = () => view.container.querySelector<HTMLSelectElement>('#model-route-routine')
  const choose = async (value: string) => {
    await act(async () => {
      selected()!.value = value
      selected()!.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  try {
    await waitFor(view, () => subscriptions.length === 1 && view.text().includes('样本任务'))
    await view.click(button(view, '设置'))
    await waitFor(view, () => selected())
    await choose('fast')
    expect(button(view, '保存模型分配').disabled).toBe(false)
    modelGate = lateModel
    await view.click(button(view, '重新读取'))
    await lateModel.entered.promise

    await client.post('/v1/settings/model-routing', { expected_revision: 0, operation_id: uuidv7(),
      mapping: { routine: 'strong', standard: null, complex: null } })
    const gap = addEvent('fixture.settings_gap')
    healthGate = lateHealth
    await act(async () => { subscriptions[0]!.deliver(gap) })
    await lateHealth.entered.promise
    expect(button(view, '保存模型分配').disabled).toBe(true)
    expect(view.text()).toContain('数据可能已过期')

    modelGate = freshModel
    await view.click(button(view, '重新检测'))
    await freshModel.entered.promise
    lateModel.release.resolve()
    lateHealth.release.resolve()
    await view.flush()
    expect(subscriptions).toHaveLength(1)
    expect(button(view, '保存模型分配').disabled).toBe(true)
    await view.click(button(view, '保存模型分配'))
    expect(modelWrites).toBe(0)

    freshModel.release.resolve()
    await waitFor(view, () => subscriptions.length === 2 && selected()?.value === 'fast' && view.text().includes('实时更新'))
    expect(subscriptions[1]?.after).toBe(gap.seq)
    expect(view.text()).toContain('S5')
    expect(view.text()).toContain('模型设置有冲突')
    expect(button(view, '保存模型分配').disabled).toBe(true)
    await view.click(button(view, '保存模型分配'))
    expect(modelWrites).toBe(0)
    await view.click(button(view, '保留我的修改'))
    expect(button(view, '保存模型分配').disabled).toBe(false)
    await view.click(button(view, '保存模型分配'))
    await waitFor(view, () => view.text().includes('已保存，下一次派发采用新配置。'))
    expect(modelWrites).toBe(1)
    expect((await client.get('/v1/settings/model-routing')).data).toMatchObject({ revision: 2, mapping: { routine: 'fast' } })
  } finally {
    for (const pending of [lateModel, lateHealth, freshModel]) pending.release.resolve()
    view.unmount()
  }
}, 10_000)

it('Q-24 查询伪造或含路径的产物 id 返回 NOT_FOUND 且不回显路径', async () => {
  const { api, db, send, endpoint } = await boot()
  const privatePath = 'file:///private/artifact-root/actual.txt'
  withTx(db, (tx) => tx.run(
    "INSERT INTO artifacts (artifact_id, run_id, uri, sha256, created_at) VALUES ('actual', 'r1', ?, ?, ?)",
    [privatePath, '0'.repeat(64), new Date().toISOString()],
  ))
  expect((await api.getArtifact('actual')).data).toMatchObject({ artifact_id: 'actual' })
  for (const id of ['forged', '../private/artifact-root/actual.txt']) {
    const url = new URL('/v1/artifacts/get', endpoint)
    url.searchParams.set('artifact_id', id)
    const response = await send(url)
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(JSON.stringify(body)).not.toContain('artifact-root')
  }
})
