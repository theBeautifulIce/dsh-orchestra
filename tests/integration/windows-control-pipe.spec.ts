import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createSseSubscribe } from '../../src/client/api/sse-fetch.ts'
import { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'
import { requestControlPipe } from '../../src/service/windows-control-pipe.ts'

const desktopToken = process.platform === 'win32' && process.env.ORCHESTRA_TEST_WINDOWS_PIPE === '1'

it.runIf(desktopToken)('prefers the SID-restricted Windows pipe for DSH controls and reconnects SSE over loopback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orch-windows-pipe-'))
  const ctx = new Context()
  const workspace = { id: 'work', path: directory, sessionIds: ['session'] }
  const selected = { provider: 'fixture', model: 'selected' }
  const agent = { session: { id: 'session', header: { cwd: directory } }, model: { current: () => selected } }
  let serveOptions!: Parameters<typeof serveDshOrchestra>[0]
  let service!: Awaited<ReturnType<typeof serveDshOrchestra>>
  let route!: (request: Request) => Promise<Response>
  let credential: unknown
  ctx.provide('connection', { fetch: { register(input: { fetch: typeof route }) { route = input.fetch } } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: (id: string) => id === workspace.id ? workspace : undefined })
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }), modelCatalog: async () => ({ groups: [] }) })
  ctx.provide('credentials', { async modifyRecord(_key: string, update: (record: unknown) => Promise<unknown>) {
    credential = await update(credential) ?? credential
    return credential
  } })
  ctx.provide('agents', { get: () => agent })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  const plug = () => ctx.plugin((host) => {
    installLocalDshHost(host, localDshHostConfig.parse({ local: { enabled: true, dataDirectory: directory } }).local, async (options) => {
      serveOptions = options
      service = await serveDshOrchestra(options)
      return service
    }, false)
  })
  const proxy = (path: string, body?: object, init?: RequestInit, sessionId = 'session') => {
    const url = new URL('http://dsh.internal/api/orchestra.request')
    url.search = new URLSearchParams({ workspaceId: 'work', sessionId, path }).toString()
    return route(new Request(url, { ...init, method: body ? 'POST' : 'GET',
      headers: { host: '127.0.0.1:3210', ...(body ? { 'x-orchestra-request': '1', 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
  }
  const subscribe = createSseSubscribe((url, init) => {
    const target = new URL(String(url))
    return proxy(target.pathname + target.search, undefined, init)
  }, 'http://dsh.internal/')
  const observeCapacity = (after: number) => {
    const seen = Promise.withResolvers<number>()
    const failed = () => seen.reject(new Error('SSE closed before observing a capacity change'))
    const stop = subscribe(after, (event) => {
      if (event.type === 'execution_capacity.updated') seen.resolve(event.seq)
    }, failed, failed, () => {})
    return { seen: seen.promise, stop }
  }
  const settings = '/v1/settings/execution-capacity'
  const save = (id: number, revision: number) => ({
    operation_id: '018f1190-2c22-7ed2-bb35-99b707dbcd0' + id, expected_revision: revision, values: null,
  })
  let plugin = plug()
  const network = vi.spyOn(globalThis, 'fetch')
  const stopStreams: Array<() => void> = []
  try {
    await plugin.await()
    await expect.poll(() => typeof route).toBe('function')
    expect((await proxy(settings, undefined, undefined, 'wrong')).status).toBe(403)
    expect((await proxy(settings)).status).toBe(200)
    expect(network).not.toHaveBeenCalled()
    const first = service.controlPipe
    expect(first).toMatch(/^\\\\\.\\pipe\\dsh-orchestra-[a-f0-9]{32}$/u)
    const requestPipe = (path: string, secret?: string) => requestControlPipe(path, new URL(settings, service.endpoint), {
      method: 'GET', headers: new Headers(secret ? { 'x-orchestra-secret': secret } : {}), signal: AbortSignal.timeout(3000),
    })
    const anon = await requestPipe(first!)
    expect(anon?.status).toBe(401)
    await anon?.body?.cancel()
    const noHuman = await requestPipe(first!, serveOptions.secret)
    expect(noHuman?.status).toBe(403)
    await noHuman?.body?.cancel()
    const firstStream = observeCapacity(0)
    stopStreams.push(firstStream.stop)
    const writes = await Promise.all([1, 2, 3].map((id) => proxy(settings, save(id, 0))))
    expect(writes.map((res) => res.status).sort()).toEqual([200, 409, 409])
    expect(network).toHaveBeenCalledTimes(1)
    const firstSeq = await firstStream.seen
    firstStream.stop()
    await Promise.all(writes.map((res) => res.body?.cancel()))

    service.controlPipe = first + '-missing'
    const fallbackWrite = await proxy(settings, save(4, 1))
    expect(fallbackWrite.status).toBe(200)
    expect(network).toHaveBeenCalledTimes(2)
    await fallbackWrite.body?.cancel()
    const secondStream = observeCapacity(firstSeq)
    stopStreams.push(secondStream.stop)
    expect(await secondStream.seen).toBeGreaterThan(firstSeq)
    expect(network).toHaveBeenCalledTimes(3)
    await plugin.dispose()
    expect(await requestPipe(first!)).toBeUndefined()

    plugin = plug()
    await plugin.await()
    const reopened = await proxy(settings)
    expect(reopened.status).toBe(200)
    expect(await reopened.json()).toMatchObject({ data: { revision: 2 } })
    expect(service.controlPipe).toBeDefined()
    expect(service.controlPipe).not.toBe(first)
    expect(network).toHaveBeenCalledTimes(3)
  } finally {
    for (const stop of stopStreams) stop()
    network.mockRestore()
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)
