import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'

it('本机操作人设置四种执行权限；跨会话共享、版本冲突拒绝、重启保留', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-execution-permissions-'))
  const workspaces = ['one', 'two'].map(id => ({ id, path: join(profile, id), sessionIds: [id + '-session'] }))
  const agents = new Map(workspaces.map(({ path, sessionIds }) => [sessionIds[0], {
    session: { id: sessionIds[0], header: { cwd: path, origin: undefined as string | undefined } },
    model: { current: () => undefined },
  }]))
  const archivedSessionIds: string[] = []
  const serve = vi.fn<typeof serveDshOrchestra>(async () => { throw Error('Settings must not start a task service') })
  async function start() {
    let fetch!: (request: Request) => Promise<Response>
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'desktop', dir: profile })
    ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
    ctx.provide('llm', {})
    ctx.provide('tools', {})
    ctx.provide('webServer', { host: '127.0.0.1' })
    ctx.provide('credentials', {})
    ctx.provide('workspaceRegistry', { archivedSessionIds, list: () => workspaces,
      get: (id: string) => workspaces.find(workspace => workspace.id === id) })
    ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: agents.get(id) }) })
    ctx.provide('connection', { fetch: { register(route: { fetch: typeof fetch }) { fetch = route.fetch } } })
    const plugin = ctx.plugin(host => installLocalDshHost(host,
      localDshHostConfig.parse({ local: { enabled: true, dataDirectory: join(profile, 'ledgers') } }).local, serve, false))
    await plugin.await()
    await expect.poll(() => typeof fetch).toBe('function')
    return { dispose: () => plugin.dispose(),
      request(options: { workspaceId?: string; sessionId?: string; body?: unknown; headers?: HeadersInit } = {}) {
        const workspaceId = options.workspaceId ?? 'one'
        const query = new URLSearchParams({ workspaceId, sessionId: options.sessionId ?? workspaceId + '-session',
          path: '/v1/settings/execution-permissions' })
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
    host = await start()
    expect(await (await host.request()).json()).toMatchObject({ data: { mode: 'full', revision: 0 } })
    expect((await host.request({ sessionId: 'two-session' })).status).toBe(403)
    expect((await host.request({ headers: { host: '198.51.100.1:3210' } })).status).toBe(403)
    expect((await host.request({ headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await host.request({ body: { mode: 'inherit', expected_revision: 0 }, headers: { 'x-orchestra-request': '0' } })).status).toBe(403)
    expect((await host.request({ body: { mode: 'unsafe', expected_revision: 0 } })).status).toBe(400)
    agents.get('one-session')!.session.header.origin = 'subagent'
    expect((await host.request({ body: { mode: 'inherit', expected_revision: 0 } })).status).toBe(403)
    agents.get('one-session')!.session.header.origin = undefined
    for (const [index, mode] of (['inherit', 'brain', 'user', 'full'] as const).entries()) {
      expect(await (await host.request({ body: { mode, expected_revision: index } })).json())
        .toMatchObject({ data: { mode, revision: index + 1 } })
      expect(await (await host.request({ workspaceId: 'two' })).json())
        .toMatchObject({ data: { mode, revision: index + 1 } })
    }
    expect((await host.request({ body: { mode: 'user', expected_revision: 0 } })).status).toBe(409)
    expect(serve).not.toHaveBeenCalled()
    await host.dispose()
    host = await start()
    expect(await (await host.request()).json()).toMatchObject({ data: { mode: 'full', revision: 4 } })
    archivedSessionIds.push('two-session')
    expect((await host.request({ workspaceId: 'two' })).status).toBe(403)
    await writeFile(join(profile, 'orchestra', 'execution-settings.sqlite'), 'invalid database')
    expect((await host.request()).status).toBe(503)
    expect((await host.request({ body: { mode: 'user', expected_revision: 4 } })).status).toBe(503)
  } finally {
    await host?.dispose()
    await rm(profile, { recursive: true, force: true })
  }
})
