import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { serveDshOrchestra } from '../../src/index.ts'
import { createWindowsReadOnlyHost } from '../../src/executor/windows-readonly-host.ts'
import { installLocalDshHost, localDshHostConfig, type TrustedLocalReadOnlyCommands } from '../../src/service/local-dsh-host.ts'

const enabled = process.platform === 'win32' && process.env.ORCHESTRA_TEST_WINDOWS_APP_CONTAINER === '1'
const windowsPowerShell = () => join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const powershellArg = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

it.runIf(enabled)('enforces actual AppContainer BFS reads in a trusted DSH workspace view and records separate RPC provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orch-appcontainer-'))
  const workspaceRoot = join(directory, 'workspace')
  const outside = join(directory, 'outside.txt')
  const sessionId = 'bound-session'
  const workspaceId = 'bound-workspace'
  const agent = { session: { id: sessionId, header: { cwd: workspaceRoot } } }
  const ctx = new Context()
  let fetchRoute!: (request: Request) => Promise<Response>
  let view!: string
  const scopeProvider = vi.fn<TrustedLocalReadOnlyCommands>(async () => ({
    commands: [{ name: 'native_probe', capability: 'read_only', command: {
      bin: windowsPowerShell(),
      args: powershellArg([
        "$result = @{ read = [IO.File]::ReadAllText('sample.txt'); write = 'permitted'; outside = 'permitted' }",
        "try { [IO.File]::AppendAllText('sample.txt', 'forbidden') } catch [UnauthorizedAccessException] { $result.write = 'denied' }",
        "try { [IO.File]::ReadAllText('" + outside.replace(/'/gu, "''") + "') | Out-Null } catch [UnauthorizedAccessException] { $result.outside = 'denied' }",
        '[Console]::Write((ConvertTo-Json -Compress $result))',
      ].join('\n')),
    } }],
    async populate(path) {
      view = path
      await writeFile(join(view, 'sample.txt'), 'isolated sample')
    },
  }))
  const serve = vi.fn<typeof serveDshOrchestra>(async () => ({
    endpoint: 'http://127.0.0.1:55555', close: async () => {},
  }) as Awaited<ReturnType<typeof serveDshOrchestra>>)
  ctx.provide('connection', { fetch: { register(input: { fetch: typeof fetchRoute }) { fetchRoute = input.fetch } } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], get(id: string) {
    if (id === workspaceId) return { id, path: workspaceRoot, sessionIds: [sessionId] }
  } })
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) })
  ctx.provide('credentials', { modifyRecord: async (_key: string, update: (record: undefined) => unknown) => update(undefined) })
  ctx.provide('agents', { get: () => agent })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  ctx.provide('workspaceFiles', { read: async () => ({ text: 'dsh fixture', eof: true }) })
  ctx.provide('orchestraReadonlyCommands', scopeProvider)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
  const plugin = ctx.plugin((host) => {
    installLocalDshHost(host, localDshHostConfig.parse({
      local: { enabled: true, dataDirectory: directory, sampleFile: join(workspaceRoot, 'sample.txt') },
    }).local, serve, false)
  })
  try {
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'sample.txt'), 'original sample')
    await writeFile(outside, 'ordinary user can read this')
    expect(await readFile(outside, 'utf8')).toBe('ordinary user can read this')
    await plugin.await()
    await expect.poll(() => typeof fetchRoute).toBe('function')
    const query = new URLSearchParams({ path: '/health', workspaceId, sessionId })
    expect(await fetchRoute(new Request('http://dsh.internal/api/orchestra.request?' + query, {
      headers: { host: '127.0.0.1:3210' },
    }))).toMatchObject({ status: 200 })
    expect(scopeProvider).toHaveBeenCalledWith({ workspaceId, workspaceRoot, sessionId })
    const runner = serve.mock.calls[0]![0].tools.runner
    const common = { args: ['untrusted override'], cwd: '.', timeoutMs: 10_000, workspaceRoot }
    const isolated = await runner.runTool({ ...common, command: 'native_probe' })
    expect(isolated.evidence).toMatchObject({ source: 'run_tool', boundary: 'windows_appcontainer_bfs', exitCode: 0 })
    expect(JSON.parse(isolated.stdout)).toEqual({ read: 'isolated sample', write: 'denied', outside: 'denied' })
    expect(await readFile(join(view, 'sample.txt'), 'utf8')).toBe('isolated sample')
    expect(await readFile(join(workspaceRoot, 'sample.txt'), 'utf8')).toBe('original sample')
    const rpc = await runner.runTool({ ...common, command: 'workspace_read_sample' })
    expect(rpc.stdout).toBe('dsh fixture')
    expect(rpc.evidence).toMatchObject({ source: 'run_tool', boundary: 'dsh_workspace_rpc', exitCode: 0 })
    await expect(runner.runTool({ ...common, command: 'native_probe', cwd: '../outside' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(runner.readonlyAvailable('unregistered')).toBe(false)
    await plugin.dispose()
    await expect(readFile(join(view, 'sample.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    fetch.mockRestore()
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)

it.runIf(enabled).each(['junction', 'hard link'])('blocks a staged Windows %s before issuing an execution receipt', async (kind) => {
  const workspace = await mkdtemp(join(tmpdir(), 'orch-appcontainer-reparse-'))
  let view: string | undefined
  const host = await createWindowsReadOnlyHost(workspace, async (created) => {
    view = created
    if (kind === 'junction') await symlink(workspace, join(created, 'outside'), 'junction')
    else {
      const external = join(workspace, 'source.txt')
      await writeFile(external, 'outside')
      await link(external, join(created, 'outside'))
    }
  })
  try {
    await expect(host!.run({ bin: windowsPowerShell(), args: powershellArg('[Console]::Write("unexpected")'),
      cwd: workspace, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' })
  } finally {
    await host?.close()
    await rm(workspace, { recursive: true, force: true })
  }
  await expect(readFile(join(view!, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 20_000)
