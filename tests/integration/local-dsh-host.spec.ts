import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'

it('binds the native DSH route to one local workspace session and keeps the ledger credentials on the host', async () => {
  expect(localDshHostConfig.parse(undefined).local.enabled).toBe(false)
  const dir = await mkdtemp(join(tmpdir(), 'orch-local-host-'))
  const ctx = new Context()
  let route: ((request: Request) => Promise<Response>) | undefined
  const workspaceId = 'work-id'
  const sessionId = 'session-id'
  const archivedSessionIds: string[] = []
  const agent = { session: { id: sessionId, header: { cwd: dir } }, model: { current: () => ({ provider: 'trusted', model: 'selected' }) } }
  let groups = [{ id: 'trusted', models: [{ id: 'default' }, { id: 'selected' }] }]
  const modelCatalog = vi.fn(async () => ({ default: { provider: 'trusted', model: 'default' }, groups }))
  const close = vi.fn(async () => {})
  ctx.provide('connection', { fetch: { register(options: { fetch: NonNullable<typeof route> }) { route = options.fetch } } })
  ctx.provide('workspaceRegistry', {
    archivedSessionIds,
    get: (id: string) => id === workspaceId ? { id, path: dir, sessionIds: [sessionId] } : undefined,
  })
  ctx.provide('sessionController', {
    resolveAgent: async () => ({ agent }),
    modelCatalog,
  })
  ctx.provide('credentials', { modifyRecord: async (_key: string, update: (value: undefined) => Promise<unknown>) => update(undefined) })
  ctx.provide('agents', { get: () => agent })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  const read = vi.fn(async () => ({ text: 'sample-row,12', eof: true }))
  ctx.provide('workspaceFiles', { read })
  const serve = vi.fn(async (_options: Parameters<typeof serveDshOrchestra>[0]) =>
    ({ endpoint: 'http://127.0.0.1:55555', close }) as unknown as Awaited<ReturnType<typeof serveDshOrchestra>>)
  const forwarded = vi.fn(async (_target: URL, init: RequestInit) => {
    if (init.body) expect(await new Response(init.body).json()).toEqual({ goal: '整理月报' })
    return new Response('event: ready\n\n', { headers: { 'content-type': 'text/event-stream', 'x-private': 'strip' } })
  })
  vi.stubGlobal('fetch', forwarded)
  const plugin = ctx.plugin((host) => { installLocalDshHost(host, localDshHostConfig.parse({ local: {
    enabled: true, dataDirectory: dir, sampleFile: join(dir, 'approved.txt'),
  } }).local, serve) })
  try {
    await plugin.await()
    await expect.poll(() => typeof route).toBe('function')
    function request(path: string, options: { workspace?: string; method?: 'POST'; headers?: HeadersInit } = {}) {
      const url = new URL('http://dsh.internal/api/orchestra.request')
      url.search = new URLSearchParams({ workspaceId: options.workspace ?? workspaceId, sessionId, path }).toString()
      return route!(new Request(url, {
        headers: { host: '127.0.0.1:3210', cookie: 'fake-dsh-cookie', ...options.headers },
        ...(options.method ? { method: options.method, body: JSON.stringify({ goal: '整理月报' }) } : {}),
      }))
    }
    expect((await request('/health', { workspace: 'wrong-workspace' })).status).toBe(403)
    expect((await request('/health', { headers: { host: 'lan.invalid' } })).status).toBe(403)
    expect((await request('/v1/node-runs/run', { method: 'POST', headers: {
      'x-orchestra-request': '1', 'content-type': 'application/json',
    } })).status).toBe(404)
    expect((await request('/v1/task-plans', { method: 'POST' })).status).toBe(403)
    const directStart = await request('/v1/runs/start', { method: 'POST', headers: {
      'x-orchestra-request': '1', 'content-type': 'application/json',
    } })
    expect(directStart.status).toBe(403)
    expect(await directStart.text()).toContain('用自然语言规划任务')
    expect(serve).not.toHaveBeenCalled()
    const response = await request('/v1/events/stream?after_seq=10')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.has('x-private')).toBe(false)
    expect(await response.text()).toBe('event: ready\n\n')
    expect(String(forwarded.mock.calls[0]?.[0])).toBe('http://127.0.0.1:55555/v1/events/stream?after_seq=10')
    expect((await request('/v1/task-plans', { method: 'POST', headers: {
      'x-orchestra-request': '1', 'content-type': 'application/json', 'x-orchestra-secret': 'browser-provided',
    } })).status).toBe(200)
    const headers = new Headers(forwarded.mock.calls[1]?.[1].headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.get('x-orchestra-secret')).toMatch(/^[a-f0-9]{64}$/u)
    expect(serve.mock.calls[0]?.[0].dsh.parentForNode('node')).toBe(agent)
    expect(modelCatalog).not.toHaveBeenCalled()
    const load = serve.mock.calls[0]?.[0].dsh.loadModelCatalog
    expect((await load!()).profiles).toMatchObject([
      { ref: 'trusted/default', capacity: null }, { ref: 'trusted/selected', capacity: 'standard' },
    ])
    groups = [{ id: 'trusted', models: [{ id: 'default' }] }, { id: 'other', models: [{ id: 'default' }] }]
    expect((await load!()).profiles).toMatchObject([
      { ref: 'trusted/default', capacity: null }, { ref: 'other/default', capacity: null },
    ])
    expect((await request('/v1/rework/plan')).status).toBe(200)
    const result = await serve.mock.calls[0]![0].tools.runner.runTool({ command: 'workspace_read_sample', args: ['other.txt'],
      cwd: '.', timeoutMs: 1000, workspaceRoot: dir })
    expect(result.stdout).toBe('sample-row,12')
    expect(read).toHaveBeenCalledWith({ sessionId, workspaceRoot: dir }, 'approved.txt', { offset: 1, limit: 200 }, expect.any(AbortSignal))
    archivedSessionIds.push(sessionId)
    expect((await request('/health')).status).toBe(403)
    expect(serve.mock.calls[0]?.[0].dsh.parentForNode('node')).toBeUndefined()
    expect(serve).toHaveBeenCalledTimes(1)
  } finally {
    await plugin.dispose()
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  }
  expect(close).toHaveBeenCalledTimes(1)
})
