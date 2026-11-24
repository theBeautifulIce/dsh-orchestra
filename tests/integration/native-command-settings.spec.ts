import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'
import { createNativeCommandSettings } from '../../src/service/native-command-settings.ts'
import { normalizeTaskCommandName } from '../../src/core/task-command.ts'

it('persists a canonical command with CAS and rejects corrupt preferences', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-command-store-'))
  try {
    const first = createNativeCommandSettings(profile)
    expect(first.read()).toEqual({ name: 'orchestra', revision: 0 })
    expect(normalizeTaskCommandName(' /Run-2 ')).toBe('run-2')
    for (const value of ['', '/go extra', '//go', '2go', '执行', 'a'.repeat(33)]) expect(normalizeTaskCommandName(value)).toBeUndefined()
    expect(first.save({ name: 'go', expected_revision: 0 })).toEqual({ name: 'go', revision: 1 })
    const restarted = createNativeCommandSettings(profile)
    expect(restarted.read()).toEqual({ name: 'go', revision: 1 })
    expect(restarted.save({ name: 'go', expected_revision: 1 })).toEqual({ name: 'go', revision: 1 })
    expect(() => first.save({ name: 'next', expected_revision: 0 })).toThrow('已更新')
    expect(() => first.save({ name: '/bad', expected_revision: 1 })).toThrow('格式无效')
    await writeFile(join(profile, 'orchestra', 'chat-settings.sqlite'), 'broken')
    expect(() => restarted.read()).toThrow('无法读取')
  } finally { await rm(profile, { recursive: true, force: true }) }
})

it('checks live host commands and user skills before saving, without opening task ledgers', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orchestra-command-http-'))
  const workspace = { id: 'work', path: profile, sessionIds: ['human', 'other'] }
  const agents = new Map(workspace.sessionIds.map(id => [id, { session: { id, header: { cwd: profile } }, model: { current: () => undefined } }]))
  const commandNames = ['help']
  const archivedSessionIds: string[] = []
  const serve = vi.fn(serveDshOrchestra)
  let fetch!: (request: Request) => Promise<Response>
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile })
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('commands', { list: () => commandNames.map(name => ({ name, description: '现有宿主命令' })) })
  ctx.provide('skills', { list: async () => [{ name: 'brief', invocation: { userInvocable: true } }, { name: 'hidden', invocation: { userInvocable: false } }] })
  ctx.provide('llm', {})
  ctx.provide('tools', { register() {}, guard() {} })
  ctx.provide('systemPrompt', { section() {} })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('webServer', { host: '127.0.0.1' })
  ctx.provide('credentials', { modifyRecord: async () => ({ kind: 'grant', payload: 'a'.repeat(64) }) })
  ctx.provide('workspaceRegistry', { archivedSessionIds, list: () => [workspace], get: (id: string) => id === workspace.id ? workspace : undefined })
  ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: agents.get(id) }) })
  ctx.provide('connection', { fetch: { register(route: { fetch: typeof fetch }) { fetch = route.fetch } } })
  const plugin = ctx.plugin(host => installLocalDshHost(host, localDshHostConfig.parse({ local: { enabled: true, dataDirectory: join(profile, 'ledgers') } }).local, serve))
  const request = (body?: object, check = false, sessionId = 'human', headers: HeadersInit = {}) => {
    const query = new URLSearchParams({ workspaceId: 'work', sessionId, path: '/v1/settings/task-command' + (check ? '/check' : '') })
    return fetch(new Request('http://dsh.internal/api/orchestra.request?' + query, {
      headers: { host: '127.0.0.1:3210', 'content-type': 'application/json', 'x-orchestra-request': '1', ...headers },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    }))
  }
  try {
    await plugin.await()
    await expect.poll(() => typeof fetch).toBe('function')
    expect(await (await request()).json()).toMatchObject({ data: { name: 'orchestra', revision: 0, check: { available: true } } })
    expect(await (await request({ name: 'help' }, true)).json()).toMatchObject({ data: { available: false, conflicts: [{ kind: 'host_command' }] } })
    expect(await (await request({ name: 'brief' }, true)).json()).toMatchObject({ data: { available: false, conflicts: [{ kind: 'skill' }] } })
    expect(await (await request({ name: 'hidden' }, true)).json()).toMatchObject({ data: { available: true } })
    expect((await request({ name: 'help', expected_revision: 0 })).status).toBe(409)
    expect((await request({ name: 'bad task', expected_revision: 0 })).status).toBe(400)
    expect((await request({ name: 'go', expected_revision: 0 }, false, 'human', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await request({ name: 'go', expected_revision: 0 }, false, 'missing')).status).toBe(403)
    expect(await (await request({ name: 'go', expected_revision: 0 })).json()).toMatchObject({ data: { name: 'go', revision: 1 } })
    expect(await (await request(undefined, false, 'other')).json()).toMatchObject({ data: { name: 'go', revision: 1 } })
    expect((await request({ name: 'next', expected_revision: 0 })).status).toBe(409)
    commandNames.push('next')
    expect((await request({ name: 'next', expected_revision: 1 })).status).toBe(409)
    expect(createNativeCommandSettings(profile).read()).toEqual({ name: 'go', revision: 1 })
    archivedSessionIds.push('human')
    expect((await request()).status).toBe(403)
    expect(serve).not.toHaveBeenCalled()
  } finally { await plugin.dispose(); await rm(profile, { recursive: true, force: true }) }
})
