import { Context } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { ToolsService, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDshExecutor } from '../../src/executor/dsh-host.ts'
import { dshCapabilitySnapshot, hasAihotReadCapability, inheritDshComposition } from '../../src/executor/dsh-execution-capabilities.ts'
import { PUBLIC_READ_TOOL } from '../../src/executor/public-read.ts'
import type { ExecutionPermissionMode } from '../../src/core/execution-permissions.ts'

type Agent = AgentHandle['agent']
const route = { provider: 'fixture', model: 'fixture' }

it.each(['full', 'inherit', 'brain', 'user'] as const)('真实DSH registry/skill/scope 与执行pipeline：%s模式继承、审批、撤权和取消', async (mode: ExecutionPermissionMode) => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const tools = ctx.plugin(ToolsService, {})
  const skills = ctx.plugin(SkillRegistry, {})
  await tools.await(); await skills.await()
  const live = new Map<string, Agent>()
  let authorized = true
  const scopes: Scope[] = []
  let runtime!: Context
  const approval = vi.fn(async () => 'allowed-once')
  ctx.provide('approval', { config: { policy: 'ask' }, overrideOf: () => 'ask', request: approval })
  ctx.provide('permissionPresets', { names: ['workspace-write', 'danger-full-access'], current: () => 'workspace-write', set() {} })
  ctx.provide('llm', { listModels: async () => [{ id: route.model }],
    prepareCall: async (config: unknown) => ({ config, async *stream() {
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify({ decision: 'allow', effect: 'read', reason: '读取任务指定的公开资讯。' }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }),
  })
  const create = async (options: CreateAgentOptions) => {
    const events: any[] = []
    const idle = Promise.withResolvers<void>()
    const child = { session: { id: options.sessionId, header: options.meta ?? {}, snapshotEvents: () => events,
      append: (type: string, data: unknown) => { events.push({ type, data }) } }, status: 'idle',
    model: { current: () => route, select() {} },
    followup() { child.status = 'running'; events.push({ type: 'request/header', data: { header: { config: route } } }) },
    whenIdle: () => idle.promise, cancel() { child.status = 'idle'; idle.resolve() }, ctx: undefined as unknown as Context }
    const scope = createScope(runtime, child)
    scopes.push(scope)
    child.ctx = scope.ctx
    await options.setup?.(scope.ctx, child as unknown as Agent)
    live.set(child.session.id, child as unknown as Agent)
    return { agent: child as unknown as Agent, async dispose() { child.cancel(); live.delete(child.session.id); await scope.dispose() } }
  }
  ctx.provide('agents', { get: (id: string) => live.get(id), create })
  const composition = ctx.inject(['tools', 'skills', 'llm', 'agents'], ready => { runtime = ready })
  await composition.await()
  const parent = { session: { id: 'source', header: { cwd: process.cwd() } }, model: { current: () => route }, ctx: undefined as unknown as Context }
  const sourceScope = createScope(runtime, parent)
  scopes.push(sourceScope)
  parent.ctx = sourceScope.ctx
  live.set('source', parent as unknown as Agent)
  const body = vi.fn(async () => ({ text: '已读取一条新闻' }))
  const registration = parent.ctx.tools.register({ name: 'bili_hot', description: '读取公开热点',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] }, execute: body })
  parent.ctx.tools.register({ name: 'skill', description: '读取技能', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'skill' })
  const skillRegistration = parent.ctx.skills.register({ name: 'aihot', description: '读取AI资讯', source: 'runtime', content: '只读取公开资讯。' })
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response('今日科技新闻', { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  vi.stubGlobal('fetch', fetch)
  const host = createDshExecutor({ context: runtime, parentForNode: () => authorized ? parent as unknown as Agent : undefined,
    models: [{ ...route, ref: 'fixture/fixture', capacity: 'routine' }], recommend: () => ({ complexity: 'routine', reason: 'test' }),
    executionPermissionMode: () => mode, nativeToolPolicyForNode: () => ({ sideEffectPolicy: 'pure' }) })
  try {
    const spawned = await host.bridge.spawn({ nodeRunId: 'node', attempt: 1, actionGeneration: 1, input: {}, outputSchema: {},
      toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'fixture/fixture' })
    const child = live.get(spawned.agentId)!
    expect(runtime.tools.schemas(child).map(tool => tool.name)).toContain('bili_hot')
    expect((await runtime.skills.list({ scope: child })).map(skill => skill.name)).toContain('aihot')
    expect((await runtime.skills.get('aihot', { scope: child }))?.content).toBe('只读取公开资讯。')
    const stop = new AbortController()
    host.bridge.installAttemptMonitor({ binding: { nodeRunId: 'node', attempt: 1, actionGeneration: 1,
      executorAgentId: spawned.agentId, executorSessionId: spawned.sessionId }, actionTimeoutMs: 1000, budget: () => 1000 },
    () => !stop.signal.aborted, stop.signal)
    await host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '读取公开AI资讯。' })
    let call = 0
    async function execute(name = 'bili_hot', args: Record<string, unknown> = {}) {
      const toolSet = await runtime.tools.resolve({ agent: child, modelSelection: route, signal: new AbortController().signal })
      try {
        const pipeline = new ToolExecutionPipeline(runtime)
        const prepared = await pipeline.prepare({ name, arguments: args, agent: child, toolSet,
          callId: 'call-' + (++call), signal: new AbortController().signal } as ToolExecutionInput)
        return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
      } finally { toolSet.dispose() }
    }
    expect((await execute()).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(1)
    expect(approval).toHaveBeenCalledTimes(mode === 'user' ? 1 : 0)
    expect((await execute(PUBLIC_READ_TOOL, { action: 'aihot_latest' })).isError).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('https://aihot.news/api/v1/agent/latest')
    expect(approval).toHaveBeenCalledTimes(mode === 'user' ? 2 : 0)
    skillRegistration()
    expect((await execute(PUBLIC_READ_TOOL, { action: 'aihot_latest' })).isError).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    authorized = false
    expect((await execute()).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
    authorized = true
    const deny = ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'deny', reason: '宿主硬拒绝' }))
    expect((await execute()).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
    deny()
    stop.abort()
    expect((await execute()).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
    registration()
    expect(runtime.tools.schemas(child).map(tool => tool.name)).not.toContain('bili_hot')
  } finally {
    await host.close()
    vi.unstubAllGlobals()
    for (const scope of scopes.reverse()) await scope.dispose()
    await composition.dispose()
    await skills.dispose(); await tools.dispose()
  }
})

it('真实AgentPresetRegistry继承原组合插件、全局工具和同cwd技能，规划不承诺source独有临时层', async () => {
  const { Loader } = await import(pathToFileURL(createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'))
    .resolve('@deepseek-ai/cordis-plugin-loader')).href)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  ctx.provide('agents', {})
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) })
  const loader = new Loader(ctx)
  const tools = ctx.plugin(ToolsService, {})
  const skills = ctx.plugin(SkillRegistry, {})
  const presets = ctx.plugin(AgentPresetRegistry, { default: 'fixture' })
  await tools.await(); await skills.await(); await presets.await()
  const cwd = process.cwd()
  const definition = { name: 'aihot', description: '读取本工作区AI资讯', source: 'project-dsh', provider: 'cwd-fixture',
    path: cwd + '/skills/aihot/SKILL.md', invocation: { modelInvocable: true, userInvocable: true }, content: '当前工作区的公开资讯读取技能。' }
  const read = (name: string) => ({ name, description: '读取公开资料', parameters: { type: 'object' as const, properties: {} },
    output: { schema: { type: 'string' as const }, render: () => [] }, execute: vi.fn(async () => 'read') })
  const presetTool = read('bili_hot')
  loader.builtins.fixture = { inject: ['tools', 'skills'], apply(mounted: Context) {
    mounted.tools.register(presetTool)
    mounted.skills.registerProvider(() => ({ name: definition.provider,
      list: async options => options.cwd === cwd ? [{ ...definition, rank: 100, locator: 'fixture' }] : [],
      get: async (_candidate, options) => options.cwd === cwd ? definition : undefined,
    }))
  } }
  let runtime!: Context
  const composition = ctx.inject(['tools', 'skills', 'agentPresets'], ready => { runtime = ready })
  await composition.await()
  const globalTool = read('read')
  runtime.tools.register(globalTool)
  runtime.tools.register(read('skill'))
  const unregister = await runtime.agentPresets.register({ id: 'fixture', plugins: [{ name: 'cordis:fixture' }] })
  const source = { ctx: undefined as unknown as Context, session: { id: 'source', header: { cwd } } }
  const executor = { ctx: undefined as unknown as Context, session: { id: 'child', header: { cwd } } }
  const parent = source as unknown as Agent
  const child = executor as unknown as Agent
  const sourceScope = createScope(runtime, parent)
  const childScope = createScope(runtime, child)
  source.ctx = sourceScope.ctx
  executor.ctx = childScope.ctx
  try {
    expect(await runtime.agentPresets.mount(parent.ctx, 'fixture')).toEqual({ id: 'fixture' })
    parent.ctx.tools.register(read('bili_search'))
    parent.ctx.skills.register({ name: 'source-only', description: '来源临时技能', source: 'runtime', content: '来源独有。' })
    inheritDshComposition(child.ctx, child, parent)
    expect(runtime.agentPresets.composedPreset(child.ctx)).toBe('fixture')
    expect(runtime.tools.get('bili_hot', child)).toBe(runtime.tools.get('bili_hot', parent))
    expect(runtime.tools.get('read', child)).toBe(runtime.tools.get('read', parent))
    expect(runtime.tools.get('bili_search', child)).toBeUndefined()
    expect((await runtime.skills.get('aihot', { cwd: child.session.header.cwd, scope: child }))?.content).toBe(definition.content)
    expect(await runtime.skills.get('aihot', { cwd: cwd + '/different', scope: child })).toBeUndefined()
    expect(await runtime.skills.get('source-only', { cwd, scope: child })).toBeUndefined()
    const snapshot = await dshCapabilitySnapshot(parent, 'full', new AbortController().signal)
    expect(snapshot.native_tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['bili_hot', 'read', 'skill', PUBLIC_READ_TOOL]))
    expect(snapshot.native_tools.map(tool => tool.name)).not.toContain('bili_search')
    expect(snapshot.skills.map(skill => skill.name)).toEqual(['aihot'])
    expect(snapshot.excluded_source_scope_tools).toBe(1)
    expect(snapshot.excluded_source_scope_skills).toBe(1)
    // A temporary override may retain the same name, provenance and URI but change its instructions.
    const override = parent.ctx.skills.register({ ...definition, content: '来源会话临时修改了技能要求。' })
    const changed = await dshCapabilitySnapshot(parent, 'full', new AbortController().signal)
    expect(changed.skills).toEqual([])
    expect(changed.native_tools.map(tool => tool.name)).not.toContain(PUBLIC_READ_TOOL)
    expect(await hasAihotReadCapability(parent, new AbortController().signal)).toBe(false)
    override()
    expect(await hasAihotReadCapability(parent, new AbortController().signal)).toBe(true)
    const toolSet = await runtime.tools.resolve({ agent: child, modelSelection: route, signal: new AbortController().signal })
    try {
      const pipeline = new ToolExecutionPipeline(runtime)
      const prepared = await pipeline.prepare({ name: 'bili_hot', arguments: {}, agent: child, toolSet,
        callId: 'preset-read', signal: new AbortController().signal } as ToolExecutionInput)
      const result = await pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
      expect(result.isError).toBe(false)
      expect(presetTool.execute).toHaveBeenCalledOnce()
    } finally { toolSet.dispose() }
  } finally {
    await childScope.dispose(); await sourceScope.dispose()
    await unregister()
    await composition.dispose(); await presets.dispose(); await skills.dispose(); await tools.dispose()
  }
})

it('大目录的规划快照有界，明确截断，并且不给未知工具伪造只读身份', async () => {
  const parent = { session: { id: 'source', header: { cwd: process.cwd() } }, ctx: {
    tools: { schemas: () => [{ name: 'bili_hot', description: 'a'.repeat(10000) },
      ...Array.from({ length: 1000 }, (_, i) => ({ name: 'unknown-' + i, description: 'b'.repeat(10000) }))] },
    skills: { list: async () => Array.from({ length: 1000 }, (_, i) => ({ name: 'skill-' + i,
      description: 'c'.repeat(10000), invocation: { modelInvocable: true } })) },
  } } as unknown as Agent
  const snapshot = await dshCapabilitySnapshot(parent, 'full', new AbortController().signal)
  expect(snapshot.native_tools.map(tool => tool.name)).toEqual(['bili_hot'])
  expect(snapshot.excluded_non_read_tools).toBe(1000)
  expect(snapshot.skills).toHaveLength(64)
  expect(snapshot.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(12000)
})
