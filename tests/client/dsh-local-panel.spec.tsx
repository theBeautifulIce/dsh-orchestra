// @vitest-environment jsdom
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { act, createElement, type ReactElement } from 'react'
import { expect, it, vi } from 'vitest'
import { DshLocalPanel, isDshLocalShell, type DshLocalPanelSources } from '../../src/client/dsh-local-panel.tsx'
import { apply, inject, type DshPanelContext } from '../../src/client/dsh-sidebar.tsx'
import { createFakeService, page, renderPanel } from './harness.ts'

function store<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: T) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

const workspace = { workspaceId: 'workspace-test', sessionIds: ['session-test'] }
type WorkspaceSnapshot = ReturnType<DshLocalPanelSources['workspaces']['list']['getSnapshot']>
type SessionSnapshot = ReturnType<DshLocalPanelSources['sessions']['list']['getSnapshot']>
const initialWorkspaces: WorkspaceSnapshot = { items: [workspace], archivedSessionIds: [] }
const selectedRow = { id: 'session-test', retainedBy: { mainView: 1 } }

it('recognizes the Electron application authority and loopback web hosts', () => {
  expect(isDshLocalShell('dsh-app://app/index.html')).toBe(true)
  expect(isDshLocalShell('http://127.0.0.1:9999/')).toBe(true)
  expect(isDshLocalShell('dsh-app://shell/')).toBe(false)
  expect(isDshLocalShell('http://localhost.example.invalid/')).toBe(false)
  expect(isDshLocalShell('https://dsh.example.invalid/')).toBe(false)
})

it('sends task commands through the authenticated carrier and cancels the scoped event stream on archive', async () => {
  const sessions = { list: store<SessionSnapshot>({ byId: {} }) }
  const workspaces = { list: store(initialWorkspaces) }
  let streamSignal: AbortSignal | null | undefined
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'dsh-app://app')
    expect(url.pathname).toBe('/api/orchestra.request')
    expect(url.searchParams.get('workspaceId')).toBe(workspace.workspaceId)
    expect(url.searchParams.get('sessionId')).toBe('session-test')
    expect(init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error' })
    const path = new URL(url.searchParams.get('path')!, 'http://service.test')
    if (path.pathname === '/v1/events/stream') {
      expect(path.searchParams.has('after_seq')).toBe(true)
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream')
      streamSignal = init?.signal
      return new Response(new ReadableStream({
        start(controller) {
          streamSignal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (path.pathname === '/v1/task-plans') return Response.json({
      ok: false, schema_version: 1, as_of_seq: 1,
      error: { code: 'SERVICE_UNAVAILABLE', message: '测试结束', retryable: false },
    }, { status: 503 })
    const data = path.pathname === '/health' ? { ok: true, phase: 'S6' }
      : path.pathname === '/v1/task-plans/capability' ? { enabled: true }
      : page([])
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = await renderPanel(<DshLocalPanel sessions={sessions} workspaces={workspaces} />)
  try {
    expect(view.text()).toContain('打开一个会话')
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => { sessions.list.set({ byId: {
      'session-test': selectedRow,
      'session-other': { id: 'session-other', retainedBy: { mainView: 1 } },
    } }) })
    expect(view.text()).toContain('打开一个会话')
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => { sessions.list.set({ byId: { 'session-test': selectedRow } }) })
    await view.flush()
    expect(streamSignal?.aborted).toBe(false)

    await view.click(view.findAll('summary').find(summary => summary.textContent === '用自然语言规划任务')!)
    await view.flush()
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '阅读报告')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(view.findAll('button').find(button => button.textContent === '生成计划')!)
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post).toBeDefined()
    const url = new URL(String(post![0]), 'dsh-app://app')
    expect(url.searchParams.get('path')).toBe('/v1/task-plans')
    const headers = new Headers(post![1]?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-orchestra-request')).toBe('1')
    expect([...headers.keys()].sort()).toEqual(['accept', 'content-type', 'x-orchestra-request'])
    expect(JSON.parse(String(post![1]?.body))).toMatchObject({ goal: '阅读报告' })

    await act(async () => { workspaces.list.set({ ...initialWorkspaces, archivedSessionIds: ['session-test'] }) })
    expect(streamSignal?.aborted).toBe(true)
    expect(view.text()).toContain('打开一个会话')
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})

it('prefers an explicit adapter and returns to the one local panel when the adapter is removed', async () => {
  const host = new Context()
  const entries = new Map<string, () => ReactElement>()
  const slots: DshPanelContext['slots'] = {
    inject(_slot, mount) { return mount() },
    register(slot, component) {
      expect(entries.has(slot.name)).toBe(false)
      entries.set(slot.name, component)
      return () => { entries.delete(slot.name) }
    },
  }
  host.provide('slots', slots)
  host.provide('sessions', { list: store({ byId: {} }) })
  host.provide('workspaces', { list: store(initialWorkspaces) })
  const product = host.plugin({ apply, inject } as unknown as Plugin)
  await product.await()
  await expect.poll(() => entries.size).toBe(2)
  const main = entries.get('main')!
  const view = await renderPanel(createElement(main))
  try {
    expect(view.text()).toContain('打开一个会话')
    const service = createFakeService(() => ({ ok: true, data: { ok: true, phase: 'S6' } }))
    let remove!: () => void
    await act(async () => {
      remove = host.provide('orchestraPanelTransport', {
        baseUrl: 'http://explicit.test',
        fetcher: service.fetcher,
        initialRoute: 'settings',
      })
    })
    await view.flush()
    expect(view.text()).toContain('服务已连接')
    expect(entries.get('main')).toBe(main)
    await act(async () => { remove() })
    await view.flush()
    expect(view.text()).toContain('打开一个会话')
    expect(entries.get('main')).toBe(main)
  } finally {
    view.unmount()
    await product.dispose()
  }
  expect(entries.size).toBe(0)
})
