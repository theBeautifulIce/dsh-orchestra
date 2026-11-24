import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import type { installNativeChat } from '../../src/service/chat-native.ts'
import type { serveDshOrchestra } from '../../src/index.ts'
import { installLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'

type NativeOptions = Parameters<typeof installNativeChat>[1]
const captured = vi.hoisted(() => ({ options: undefined as NativeOptions | undefined }))
vi.mock('../../src/service/chat-native.ts', () => ({
  installNativeChat: (_context: unknown, options: NativeOptions) => { captured.options = options },
}))

it('keeps the native service alive across disposal until all acquired operations finish', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orch-native-lease-'))
  const ctx = new Context()
  const workspace = { id: 'workspace', path: directory, sessionIds: ['session'] }
  const agent = { session: { id: 'session', header: { cwd: directory } }, model: { current: () => ({ provider: 'fixture', model: 'one' }) } }
  const close = vi.fn(async () => {})
  const service = { close, endpoint: 'http://127.0.0.1:1',
    orchestra: { db: { raw: { prepare: () => ({ get: () => ({ n: 0 }) }) } } } } as unknown as Awaited<ReturnType<typeof serveDshOrchestra>>
  ctx.provide('connection', { fetch: { register: () => {} } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [workspace], get: (id: string) => id === workspace.id ? workspace : undefined })
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) })
  ctx.provide('credentials', { modifyRecord: async (_key: string, update: (value: undefined) => Promise<unknown>) => update(undefined) })
  ctx.provide('agents', { get: (id: string) => id === agent.session.id ? agent : undefined })
  for (const name of ['llm', 'tools', 'systemPrompt', 'sessions', 'webServer']) ctx.provide(name, {})
  const plugin = ctx.plugin(host => installLocalDshHost(host, localDshHostConfig.parse({ local: {
    enabled: true, dataDirectory: directory,
  } }).local, async () => service))
  try {
    await plugin.await()
    await expect.poll(() => typeof captured.options?.acquireService).toBe('function')
    const options = captured.options!
    const binding = options.bindingFor(agent as never)!
    expect(binding).toBeDefined()
    const first = await options.acquireService!(binding)
    const second = await options.acquireService!(binding)
    expect(first.service).toBe(service)
    await agentEvents(ctx, agent as never).emit('agent/disposed', { agent })
    expect(close).not.toHaveBeenCalled()
    first.release()
    first.release()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    second.release()
    await expect.poll(() => close.mock.calls.length).toBe(1)
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
    captured.options = undefined
  }
  expect(close).toHaveBeenCalledTimes(1)
})
