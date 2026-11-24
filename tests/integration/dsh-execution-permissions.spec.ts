import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { createDshExecutor } from '../../src/executor/dsh-host.ts'
import { dshCapabilitySnapshot, nativeToolConstraint } from '../../src/executor/dsh-execution-capabilities.ts'
import type { ExecutionPermissionMode } from '../../src/core/execution-permissions.ts'

type Options = Parameters<typeof createDshExecutor>[0]
type Agent = NonNullable<ReturnType<Options['parentForNode']>>
type Pre = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
type Around = (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>

function fixture(mode: ExecutionPermissionMode, review: unknown = { decision: 'allow', effect: 'read', reason: '任务要求读取公开资讯。' }) {
  const route = { provider: 'p', model: 'm' }
  const live = new Map<string, unknown>()
  const presetWrites: string[] = []
  const events: Array<{ type: string; data: any }> = []
  const tools = new Set(['skill', 'bili_hot', 'read', 'write', 'pwsh', 'memory_write'])
  const definitions = new Map([...tools].map(name => [name, { name }]))
  const pending = vi.fn(() => vi.fn())
  const idle = Promise.withResolvers<void>()
  let authorized = true
  let agent!: Agent
  let pre!: Pre
  let around!: Around
  let resultEvent!: (exec: ToolExecution, result: ToolExecutionResult) => void
  let guard!: (exec: ToolExecution) => string | undefined
  const restrict = vi.fn()
  const preset = { names: ['danger-full-access', 'workspace-write'], current: () => 'workspace-write',
    set: (_session: unknown, name: string) => { presetWrites.push(name) } }
  const get = (name: string): unknown => name === 'tools' ? toolRegistry : name === 'permissionPresets' ? preset
    : name === 'sandboxPolicy' ? { overrideOf: () => 'workspace-write' }
      : name === 'approval' ? { overrideOf: () => 'ask', config: { policy: 'ask' } } : undefined
  const toolRegistry = { get: (name: string) => tools.has(name) ? definitions.get(name) : undefined,
    schemas: () => [...tools].map(name => ({ name, description: name })),
    restrict, register() {}, guard: (fn: typeof guard) => { guard = fn } }
  const parent = { session: { id: 'source', header: { cwd: process.cwd() } }, model: { current: () => route },
    ctx: { get, tools: toolRegistry, agents: { async create(options: { sessionId: string; setup: (ctx: unknown, child: Agent) => void }) {
      const child = { session: { id: options.sessionId, header: { cwd: process.cwd() }, snapshotEvents: () => events,
        append: (type: string, data: unknown) => { events.push({ type, data }) } },
      status: 'idle', model: { current: () => route, select() {} },
      followup() { child.status = 'running'; events.push({ type: 'request/header', data: { header: { config: route } } }) },
      whenIdle: () => idle.promise, cancel() { child.status = 'idle'; idle.resolve() },
      }
      const ctx = { get, tools: toolRegistry, on(name: string, fn: any) {
        if (name === 'tools/pre-execute') pre = fn
        if (name === 'tools/execute') around = fn
        if (name === 'tools/result') resultEvent = fn
      } }
      agent = child as unknown as Agent
      options.setup(ctx, agent)
      live.set(options.sessionId, agent)
      return { agent, async dispose() { live.delete(options.sessionId); child.cancel() } }
    } } } }
  live.set('source', parent)
  const context = { agents: { get: (id: string) => live.get(id) }, llm: {
    listModels: async () => [{ id: 'm' }],
    prepareCall: async (config: unknown) => ({ config, async *stream() {
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(review) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }),
  } } as unknown as Context
  const host = createDshExecutor({ context, parentForNode: () => authorized ? parent as unknown as Agent : undefined,
    models: [{ ...route, ref: 'p/m', capacity: 'routine' }], recommend: () => ({ complexity: 'routine', reason: 'test' }),
    executionPermissionMode: () => mode, onNativeApprovalPending: pending,
    nativeToolPolicyForNode: () => ({ sideEffectPolicy: 'pure' }),
  })
  async function start() {
    const spawned = await host.bridge.spawn({ nodeRunId: 'node', attempt: 1, actionGeneration: 1, input: {},
      outputSchema: {}, toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'p/m' })
    await host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '查找公开AI资讯。' })
    return spawned
  }
  const call = (name: string, id = name): ToolExecution => ({ agent, name, arguments: {}, callId: id, rootCallId: id,
    token: Symbol(id), signal: new AbortController().signal }) as unknown as ToolExecution
  return { host, start, tools, pending, presetWrites, restrict, events, call,
    revokeSource: () => { authorized = false },
    replaceSource: () => { live.set('source', {}) },
    parent: parent as unknown as Agent,
    pre: (exec: ToolExecution, next: PreToolDecision = { kind: 'allow' }) => pre(exec, async () => next),
    guard: (exec: ToolExecution) => guard(exec),
    run: (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => around(exec, next),
    finishCall: (exec: ToolExecution, result: ToolExecutionResult = { content: [], isError: false, value: {} }) => resultEvent(exec, result),
    finish() {
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ status: 'done',
        output: { summary: '已核对公开资讯。', completion: { outcome: 'completed' } } }) }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } })
      idle.resolve()
    },
  }
}

it('全权限执行继承真实读取能力，并保留来源撤权、节点只读限制与宿主拒绝', async () => {
  const f = fixture('full')
  try {
    const spawned = await f.start()
    expect(f.presetWrites).toEqual(['danger-full-access'])
    expect(f.restrict).not.toHaveBeenCalledWith({ allow: [] })
    const read = f.call('bili_hot')
    expect(await f.pre(read)).toEqual({ kind: 'allow' })
    expect(f.guard(read)).toBeUndefined()
    expect(await f.pre(read, { kind: 'deny', reason: 'host denied' })).toEqual({ kind: 'deny', reason: 'host denied' })
    expect((await f.pre(f.call('write'))).kind).toBe('deny')
    expect((await f.pre(f.call('pwsh'))).kind).toBe('deny')
    expect((await f.pre(f.call('memory_write'))).kind).toBe('deny')
    const run = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'headline' }], isError: false as const, value: { text: 'headline' } }))
    f.finishCall(read, await f.run(read, run))
    expect(run).toHaveBeenCalledOnce()
    expect((await f.host.bridge.state({ executorAgentId: spawned.agentId })).hasToolCall).toBe(true)
    f.tools.delete('bili_hot')
    expect(f.guard(read)).toContain('来源会话当前不能访问')
    f.finish()
    await f.host.bridge.whenIdle({ executorAgentId: spawned.agentId, timeoutMs: 1000 })
    const page = await f.host.bridge.fetchPage({ executorAgentId: spawned.agentId, attempt: 1, fromSeq: 0, pageSize: 10 })
    expect(page.events.map(event => event.type)).toEqual(['tool.start', 'tool.result', 'turn'])
    expect(page.events.at(-1)?.payload).toMatchObject({ report: { output: { native_tool_trace: [{ tool: 'bili_hot', succeeded: true }] } } })
    expect(JSON.stringify(page.events.slice(0, 2))).not.toContain('headline')
  } finally { await f.host.close() }
})

it('来源工作区撤权或来源Agent被重建后，原生预审、guard与审批后的派发都拒绝旧授权', async () => {
  for (const revoke of ['revokeSource', 'replaceSource'] as const) {
    const f = fixture('user')
    try {
      await f.start()
      const call = f.call('read')
      expect((await f.pre(call)).kind).toBe('ask')
      f[revoke]()
      expect((await f.pre(call)).kind).toBe('deny')
      expect(f.guard(call)).toContain('已停止')
      const execute = vi.fn()
      await expect(f.run(call, execute)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(execute).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  }
})

it('跟随模式复制权限快照，用户模式逐调用审批并在结算和关闭时清除等待', async () => {
  const inherited = fixture('inherit')
  try {
    await inherited.start()
    expect(inherited.presetWrites).toEqual(['workspace-write'])
    expect(inherited.events).toContainEqual({ type: 'approval/policy', data: { policy: 'ask', source: 'delegation' } })
    expect((await inherited.pre(inherited.call('read'))).kind).toBe('allow')
  } finally { await inherited.host.close() }
  const user = fixture('user')
  try {
    await user.start()
    const call = user.call('skill')
    expect((await user.pre(call)).kind).toBe('ask')
    expect((await user.pre(call)).kind).toBe('ask')
    expect(user.pending).toHaveBeenCalledTimes(1)
    expect(user.pending).toHaveBeenCalledWith(expect.objectContaining({ nodeRunId: 'node', callId: 'skill', mode: 'user' }))
    user.finishCall(call)
    expect(user.pending.mock.results[0]!.value).toHaveBeenCalledTimes(1)
    await user.pre(user.call('read'))
  } finally { await user.host.close() }
  expect(user.pending.mock.results[1]!.value).toHaveBeenCalledTimes(1)
})

it('主脑只批准明确读取；不明确的裁定升级用户，宿主ask仍必须保留', async () => {
  for (const verdict of [
    { decision: 'allow', effect: 'read', reason: '任务要求读取公开资讯。' },
    { decision: 'ask_user', effect: 'unknown', reason: '范围待确认。' },
    { decision: 'allow', effect: 'external_write', reason: '模型错误分类。' },
  ]) {
    const f = fixture('brain', verdict)
    try {
      await f.start()
      expect((await f.pre(f.call('bili_hot'))).kind).toBe(verdict.effect === 'read' ? 'allow' : 'ask')
      expect(await f.pre(f.call('read'), { kind: 'ask', reason: 'host asks' })).toEqual({ kind: 'ask', reason: 'host asks' })
    } finally { await f.host.close() }
  }
})

it('取消围栏覆盖原生工具与子会话转授权，已关闭的尝试不能启动新读取', async () => {
  const f = fixture('full')
  try {
    // fence must be installed before send, as the production runner does.
    const spawned = await f.host.bridge.spawn({ nodeRunId: 'node', attempt: 1, actionGeneration: 1, input: {}, outputSchema: {},
      toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'p/m' })
    const stop = new AbortController()
    expect(f.host.bridge.installAttemptMonitor({ binding: { nodeRunId: 'node', attempt: 1, actionGeneration: 1,
      executorAgentId: spawned.agentId, executorSessionId: spawned.sessionId }, budget: () => 1000, actionTimeoutMs: 1000 },
    () => !stop.signal.aborted, stop.signal)).toBeTypeOf('function')
    await f.host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '读取公开资讯。' })
    const call = f.call('read')
    expect(f.guard({ ...call, agent: {} as Agent })).toContain('不能将当前工具授权转交')
    stop.abort()
    expect(f.guard(call)).toContain('已停止')
    await expect(f.run(call, vi.fn())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally { await f.host.close() }
})

it('规划快照单独提供实际只读工具，未知命令不伪装成可用能力', async () => {
  const f = fixture('inherit')
  const snapshot = await dshCapabilitySnapshot(f.parent, 'inherit', new AbortController().signal)
  expect(snapshot.native_tools.map(tool => tool.name)).toEqual(['skill', 'bili_hot', 'read'])
  expect(snapshot.excluded_non_read_tools).toBe(2)
  expect(snapshot.truncated).toBe(false)
  expect(nativeToolConstraint('read', 'read', { sideEffectPolicy: 'pure' })).toBeUndefined()
  expect(nativeToolConstraint('unknown', 'unknown', { sideEffectPolicy: 'pure' })).toContain('副作用未获节点授权')
  await f.host.close()
})
