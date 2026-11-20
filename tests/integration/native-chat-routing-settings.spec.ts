import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'

it('authenticates local preference requests and persists a revision across sessions and host restarts', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-chat-settings-'))
  const workspaces = ['one', 'two'].map((id) => ({ id, path: join(profile, id), sessionIds: [id + '-session'] }))
  const agents = new Map(workspaces.map(({ path, sessionIds }) => [sessionIds[0], {
    session: { id: sessionIds[0], header: { cwd: path } }, model: { current: () => undefined },
  }]))
  const archivedSessionIds: string[] = []
  const serve = vi.fn(serveDshOrchestra)

  async function start(native: boolean) {
    let fetch!: (request: Request) => Promise<Response>
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'desktop', dir: profile })
    ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
    ctx.provide('llm', {})
    ctx.provide('tools', { register() {}, guard() {} })
    ctx.provide('systemPrompt', { section() {} })
    ctx.provide('sessions', { flush: async () => true })
    ctx.provide('webServer', { host: '127.0.0.1' })
    ctx.provide('credentials', { modifyRecord: async () => ({ kind: 'grant', payload: 'a'.repeat(64) }) })
    ctx.provide('workspaceRegistry', { archivedSessionIds, list: () => workspaces,
      get: (id: string) => workspaces.find((workspace) => workspace.id === id) })
    ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: agents.get(id) }) })
    ctx.provide('connection', { fetch: { register(route: { fetch: typeof fetch }) { fetch = route.fetch } } })
    const plugin = ctx.plugin((host) => installLocalDshHost(host, localDshHostConfig.parse({
      local: { enabled: true, dataDirectory: join(profile, 'ledgers') },
    }).local, serve, native))
    await plugin.await()
    await expect.poll(() => typeof fetch).toBe('function')
    return {
      dispose: () => plugin.dispose(),
      request(options: { path?: string; workspaceId?: string; sessionId?: string; body?: unknown; headers?: HeadersInit } = {}) {
        const workspaceId = options.workspaceId ?? 'one'
        const query = new URLSearchParams({ workspaceId, sessionId: options.sessionId ?? workspaceId + '-session',
          path: options.path ?? '/v1/settings/chat-routing' })
        const headers = new Headers({ host: '127.0.0.1:3210', 'x-orchestra-request': '1', 'content-type': 'application/json' })
        new Headers(options.headers).forEach((value, key) => headers.set(key, value))
        return fetch(new Request('http://dsh.internal/api/orchestra.request?' + query, {
          headers, ...(options.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }),
        }))
      },
    }
  }

  let host: Awaited<ReturnType<typeof start>> | undefined
  try {
    host = await start(false)
    expect((await host.request()).status).toBe(404)
    expect((await (await host.request({ path: '/health' })).json()).data).not.toHaveProperty('native_chat_routing_enabled')
    await host.dispose()
    serve.mockClear()

    host = await start(true)
    expect(await (await host.request()).json()).toMatchObject({ data: { enabled: true, revision: 0 } })
    expect((await host.request({ sessionId: 'two-session' })).status).toBe(403)
    expect((await host.request({ headers: { host: '192.0.2.1:3210' } })).status).toBe(403)
    expect((await host.request({ headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await host.request({ body: { enabled: false, expected_revision: 0 }, headers: { 'x-orchestra-request': '0' } })).status).toBe(403)
    expect((await host.request({ body: { enabled: 'false', expected_revision: 0 } })).status).toBe(400)
    expect(await (await host.request({ body: { enabled: false, expected_revision: 0 } })).json()).toMatchObject({ data: { enabled: false, revision: 1 } })
    expect((await host.request({ workspaceId: 'two', body: { enabled: true, expected_revision: 0 } })).status).toBe(409)
    expect(await (await host.request({ workspaceId: 'two' })).json()).toMatchObject({ data: { enabled: false, revision: 1 } })
    expect(serve).not.toHaveBeenCalled()
    expect(await (await host.request({ path: '/health' })).json()).toMatchObject({ data: { native_chat_routing_enabled: true } })
    await host.dispose()

    host = await start(true)
    expect(await (await host.request()).json()).toMatchObject({ data: { enabled: false, revision: 1 } })
    expect(await (await host.request({ workspaceId: 'two', body: { enabled: true, expected_revision: 1 } })).json()).toMatchObject({ data: { enabled: true, revision: 2 } })
    archivedSessionIds.push('two-session')
    expect((await host.request({ workspaceId: 'two' })).status).toBe(403)
    await writeFile(join(profile, 'orchestra', 'chat-settings.sqlite'), 'invalid database')
    expect((await host.request()).status).toBe(503)
    expect((await host.request({ body: { enabled: false, expected_revision: 2 } })).status).toBe(503)
  } finally {
    await host?.dispose()
    await rm(profile, { recursive: true, force: true })
  }
})
