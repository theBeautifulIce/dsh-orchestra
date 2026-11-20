import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { serveDshOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
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
    expect(serve.mock.calls[0]?.[0].dsh.sessionExecutionModelRef?.()).toBe('trusted/selected')
    const load = serve.mock.calls[0]?.[0].dsh.loadModelCatalog
    expect(await load!()).toMatchObject({ session_execution_model_ref: 'trusted/selected', profiles: [
      { ref: 'trusted/default', capacity: null }, { ref: 'trusted/selected', capacity: null },
    ] })
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
    expect(serve.mock.calls[0]?.[0].dsh.sessionExecutionModelRef?.()).toBeUndefined()
    expect(serve).toHaveBeenCalledTimes(1)
  } finally {
    await plugin.dispose()
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  }
  expect(close).toHaveBeenCalledTimes(1)
})

it('reads real personal ledger memory pages without a writer and isolates workspace sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orch-local-memory-'))
  const workspaces = ['one', 'two'].map((id) => ({ id, path: join(directory, id), sessionIds: [id + '-session'] }))
  await Promise.all(workspaces.map(({ path }) => mkdir(path)))
  const route = { provider: 'fixture', model: 'selected' }
  const agents = new Map(workspaces.map((workspace) => [workspace.sessionIds[0]!, {
    session: { id: workspace.sessionIds[0], header: { cwd: workspace.path } }, model: { current: () => route },
  }]))
  const ctx = new Context()
  const archivedSessionIds: string[] = []
  let handleRequest!: (request: Request) => Promise<Response>
  ctx.provide('connection', { fetch: { register(options: { fetch: typeof handleRequest }) { handleRequest = options.fetch } } })
  ctx.provide('workspaceRegistry', { archivedSessionIds, get: (id: string) => workspaces.find((item) => item.id === id) })
  ctx.provide('sessionController', {
    resolveAgent: async (id: string) => ({ agent: agents.get(id) }),
    modelCatalog: async () => ({ default: route, groups: [{ id: route.provider, models: [{ id: route.model }] }] }),
  })
  ctx.provide('credentials', { modifyRecord: async (_key: string, update: (value: undefined) => Promise<unknown>) => update(undefined) })
  ctx.provide('agents', { get: (id: string) => agents.get(id) })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  const services: Awaited<ReturnType<typeof serveDshOrchestra>>[] = []
  const plugin = ctx.plugin((host) => { installLocalDshHost(host, localDshHostConfig.parse({ local: {
    enabled: true, dataDirectory: join(directory, 'db'),
  } }).local, async (options) => {
    const service = await serveDshOrchestra(options)
    services.push(service)
    return service
  }) })
  const request = (target: string, workspaceId = 'one', sessionId = workspaceId + '-session', method = 'GET') => {
    const query = new URLSearchParams({ workspaceId, sessionId, path: target })
    return handleRequest(new Request('http://dsh.internal/api/orchestra.request?' + query, {
      method, headers: { host: '127.0.0.1:3210', 'x-orchestra-request': '1', 'content-type': 'application/json' },
    }))
  }
  const path = '/v1/memory/batches'
  try {
    await plugin.await()
    await expect.poll(() => typeof handleRequest).toBe('function')
    const empty = await request(path)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ ok: true, schema_version: 1, data: { items: [], next_cursor: null } })
    const owner = services[0]!
    expect((await fetch(owner.endpoint + path)).status).toBe(401)
    expect(await (await request('/health')).json()).toMatchObject({ data: { memory_enabled: false } })

    const now = '2026-11-20T00:00:00.000Z'
    const { db } = owner.orchestra
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('owned-task','历史整理','running',?,?)", [now, now])
      for (const number of [1, 2]) {
        const source = `source-${number}`
        const memory = `memory-${number}`
        for (const runId of [source, memory]) {
          tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES (?,'owned-task','succeeded',?,?)", [runId, now, now])
        }
        tx.run(`INSERT INTO memory_batches (batch_id,task_id,source_run_id,memory_run_id,attempt,status,created_at,updated_at)
          VALUES (?,'owned-task',?,?,1,'draft',?,?)`, [`batch-${number}`, source, memory, now, now])
      }
      tx.run(`INSERT INTO memory_items (item_id,batch_id,client_key,action,layer,title,content,tags_json,questions_json,content_hash,status)
        VALUES ('item','batch-2','key','create','L4','合法历史条目','实际账本正文','[]','[]','hash','proposed')`)
    })
    const first = await request(path + '?task_id=owned-task&limit=1')
    expect(first.status).toBe(200)
    const page = await first.json()
    expect(page.data).toMatchObject({ next_cursor: expect.any(String), items: [
      { batch_id: 'batch-2', pending_count: 1, items: [{ title: '合法历史条目', content: '实际账本正文' }] },
    ] })
    const second = await request(path + '?' + new URLSearchParams({ task_id: 'owned-task', limit: '1', cursor: page.data.next_cursor }))
    expect(await second.json()).toMatchObject({ ok: true, data: { items: [{ batch_id: 'batch-1' }], next_cursor: null } })
    const invalid = await request(path + '?limit=101')
    expect(invalid.status).toBe(413)
    expect(await invalid.json()).toMatchObject({ error: { code: 'RANGE_TOO_LARGE' } })
    const badCursor = await request(path + '?cursor=invalid')
    expect(badCursor.status).toBe(410)
    expect(await badCursor.json()).toMatchObject({ error: { code: 'CURSOR_EXPIRED' } })
    expect((await request(path, 'one', 'two-session')).status).toBe(403)
    expect(await (await request(path + '?task_id=owned-task', 'two')).json()).toMatchObject({ ok: true, data: { items: [] } })
    for (const action of ['runs/start', 'recovery/inspect', 'recovery/resolve']) {
      expect((await request('/v1/memory/' + action, 'one', 'one-session', 'POST')).status).toBe(404)
    }
    archivedSessionIds.push('one-session')
    expect((await request(path)).status).toBe(403)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM memory_batches').get()?.n).toBe(2)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM memory_items').get()?.n).toBe(1)
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
