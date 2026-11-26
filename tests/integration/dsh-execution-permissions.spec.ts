import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createDshExecutor } from '../../src/executor/dsh-host.ts'
import { dshCapabilitySnapshot, nativeToolConstraint } from '../../src/executor/dsh-execution-capabilities.ts'
import { PUBLIC_READ_TOOL } from '../../src/executor/public-read.ts'
import type { ExecutionPermissionMode } from '../../src/core/execution-permissions.ts'
import type { RequirementsContract } from '../../src/core/task-requirements.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { callDshRework } from '../../src/service/dsh-rework.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { snapshotArtifactInputs } from '../../src/service/rework-runtime.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

type Options = Parameters<typeof createDshExecutor>[0]
type Definition = Parameters<Context['tools']['register']>[0]
type Agent = NonNullable<ReturnType<Options['parentForNode']>>
type Pre = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
type Around = (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>

function fixture(mode: ExecutionPermissionMode, review: unknown = { decision: 'allow', effect: 'read', reason: '任务要求读取公开资讯。' },
  requirementsContract?: RequirementsContract, rework?: Options['rework'],
  publicationTargets?: NonNullable<Options['publicationTargets']>) {
  const route = { provider: 'p', model: 'm' }
  const live = new Map<string, unknown>()
  const presetWrites: string[] = []
  const events: Array<{ type: string; data: any }> = []
  const prompts: string[] = []
  const tools = new Set(['skill', 'bili_hot', 'read', 'write', 'pwsh', 'memory_write'])
  const definitions = new Map([...tools].map(name => [name, { name }]))
  const local = new Map<string, Definition>()
  const registrations = new Map<string, Definition[]>()
  const sessionEventListeners = new Set<(session: { id: string }, event: any) => void>()
  const pending = vi.fn(() => vi.fn())
  let idle = Promise.withResolvers<void>()
  let markIdle = () => {}
  let publicSkill = false
  const listSkills = vi.fn(async () => publicSkill
    ? [{ name: 'aihot', description: '读取公开资讯', invocation: { modelInvocable: true } }] : [])
  let authorized = true
  let childSession: { id: string } | undefined
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
      : name === 'approval' ? { overrideOf: () => 'ask', config: { policy: 'ask' } }
        : name === 'skills' ? { list: listSkills } : undefined
  const toolRegistry = { get: (name: string) => local.get(name) ?? (tools.has(name) ? definitions.get(name) : undefined),
    schemas: () => {
      const current = new Map([...tools].map(name => [name, { name, description: name }]))
      for (const [name, definition] of local) current.set(name, definition)
      return [...current.values()].map(definition => ({ ...definition }))
    },
    restrict, register(definition: Definition) {
      const stack = registrations.get(definition.name) ?? []
      stack.push(definition)
      registrations.set(definition.name, stack)
      local.set(definition.name, definition)
      return () => {
        const index = stack.lastIndexOf(definition)
        if (index >= 0) stack.splice(index, 1)
        if (stack.length > 0) local.set(definition.name, stack.at(-1)!)
        else { registrations.delete(definition.name); local.delete(definition.name) }
      }
    }, guard: (fn: typeof guard) => { guard = fn } }
  const parent = { session: { id: 'source', header: { cwd: process.cwd() } }, model: { current: () => route },
    ctx: { get, tools: toolRegistry, agents: { async create(options: { sessionId: string; setup: (ctx: unknown, child: Agent) => void }) {
      const session = { id: options.sessionId, header: { cwd: process.cwd() }, snapshotEvents: () => events,
        append: (type: string, data: unknown) => appendSessionEvent(session, type, data) }
      childSession = session
      const ctx = { get, tools: toolRegistry, on(name: string, fn: any) {
        if (name === 'tools/pre-execute') pre = fn
        if (name === 'tools/execute') around = fn
        if (name === 'tools/result') resultEvent = fn
        if (name === 'session/event') {
          sessionEventListeners.add(fn)
          return () => sessionEventListeners.delete(fn)
        }
      } }
      const child = { session,
      ctx, status: 'idle', model: { current: () => route, select() {} },
      followup(message: { content: Array<{ text: string }> }) {
        prompts.push(message.content[0]!.text)
        idle = Promise.withResolvers<void>()
        child.status = 'running'
        events.push({ type: 'request/header', data: { header: { config: route } } })
      },
      whenIdle: () => idle.promise, cancel() { child.status = 'idle'; idle.resolve() },
      }
      markIdle = () => { child.status = 'idle' }
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
    executionPermissionMode: () => mode, onNativeApprovalPending: pending, rework, publicationTargets,
    nativeToolPolicyForNode: () => ({ sideEffectPolicy: 'pure', ...(requirementsContract ? { requirementsContract } : {}) }),
  })
  let childSessionId = ''
  function appendSessionEvent(session: { id: string }, type: string, data: any) {
    const event = { type, data, seq: events.length + 1 }
    if (session === childSession) events.push({ type, data })
    for (const listener of sessionEventListeners) listener(session, event)
    return event
  }
  async function start(actionGeneration: number | undefined = 1) {
    const spawned = await host.bridge.spawn({ nodeRunId: 'node', attempt: 1,
      ...(actionGeneration === undefined ? {} : { actionGeneration }), input: {},
      outputSchema: {}, toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'p/m' })
    childSessionId = spawned.sessionId
    await host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '查找公开AI资讯。' })
    return spawned
  }
  const call = (name: string, id = name): ToolExecution => ({ agent, name, arguments: {}, callId: id, rootCallId: id,
    token: Symbol(id), signal: new AbortController().signal }) as unknown as ToolExecution
  function finishText(text: string) {
    appendSessionEvent(childSession!, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    appendSessionEvent(childSession!, 'turn/end', { reason: { kind: 'completed' } })
    markIdle()
    idle.resolve()
  }
  return { host, start, tools, pending, presetWrites, restrict, events, prompts, call, listSkills,
    enablePublicSkill: () => { publicSkill = true },
    hasLocalTool: (name: string) => local.has(name),
    schemas: () => toolRegistry.schemas(),
    definition: (name: string) => local.get(name),
    sessionEvent(type: string, data: any, sessionId = childSessionId) {
      return appendSessionEvent(sessionId === childSessionId ? childSession! : { id: sessionId }, type, data)
    },
    toolCall(callId: string, input: object) {
      return appendSessionEvent(childSession!, 'tool/call', { turn: 1, step: 1, callId,
        name: 'orchestra_rework', arguments: JSON.stringify(input) })
    },
    toolResult(callId: string, text: string, options: { isError?: boolean; sessionId?: string } = {}) {
      const { isError, sessionId = childSessionId } = options
      return appendSessionEvent(sessionId === childSessionId ? childSession! : { id: sessionId }, 'tool/result', { turn: 1, step: 1, message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }],
      } })
    },
    stepEnd() { appendSessionEvent(childSession!, 'step/end', { turn: 1, step: 1 }) },
    revokeSource: () => { authorized = false },
    replaceSource: () => { live.set('source', {}) },
    parent: parent as unknown as Agent,
    pre: (exec: ToolExecution, next: PreToolDecision = { kind: 'allow' }) => pre(exec, async () => next),
    guard: (exec: ToolExecution) => guard(exec),
    run: (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => around(exec, next),
    async executeLocal(name: string, input: object, id: string) {
      const execution = { ...call(name, id), arguments: input }
      const decision = await pre(execution, async () => ({ kind: 'allow' }))
      expect(decision).toEqual({ kind: 'allow' })
      expect(guard(execution)).toBeUndefined()
      const result = await around(execution, async () => {
        const value = await local.get(name)!.execute(input, { ...execution, deferContext() {}, concludeTurn() {} })
        if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') {
          throw new Error('Expected an internal tool text receipt')
        }
        return { content: [], isError: false, value: { text: value.text } }
      })
      return JSON.parse((result.value as { text: string }).text)
    },
    finishCall: (exec: ToolExecution, result: ToolExecutionResult = { content: [], isError: false, value: {} }) => resultEvent(exec, result),
    finishText,
    finish(report: unknown = { status: 'done', output: { summary: '已核对公开资讯。', completion: { outcome: 'completed' } } }) {
      finishText(JSON.stringify(report))
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
      expect(f.guard(call)).toMatch(/来源会话.*撤回|主脑会话未在线/)
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
    expect(f.guard(call)).toContain('工具授权已结束')
    await expect(f.run(call, vi.fn())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally { await f.host.close() }
})

it.each(['blocked', 'failed', 'completed'] as const)('授权结束后保留%s回报，不能把被拒调用当作完成', async (outcome) => {
  const f = fixture('full')
  try {
    const spawned = await f.host.bridge.spawn({ nodeRunId: 'node', attempt: 1, actionGeneration: 1, input: {}, outputSchema: {},
      toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'p/m' })
    const stop = new AbortController()
    f.host.bridge.installAttemptMonitor({ binding: { nodeRunId: 'node', attempt: 1, actionGeneration: 1,
      executorAgentId: spawned.agentId, executorSessionId: spawned.sessionId }, budget: () => 1000, actionTimeoutMs: 1000 },
    () => !stop.signal.aborted, stop.signal)
    await f.host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '读取公开资料。' })
    stop.abort()
    const call = f.call('read')
    expect(f.guard(call)).toContain('不要重试或切换工具')
    const execute = vi.fn()
    await expect(f.run(call, execute)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(execute).not.toHaveBeenCalled()
    f.finish({ status: outcome === 'completed' ? 'done' : 'failed', output: { completion: outcome === 'completed' ? { outcome }
      : { outcome, reason: '执行时限已到，剩余资料未读取。', next_action: '增加本步时限后重试。', missing: ['剩余资料'] } } })
    await f.host.bridge.whenIdle({ executorAgentId: spawned.agentId, timeoutMs: 1000 })
    const events = f.host.bridge.listen({ executorAgentId: spawned.agentId, attempt: 1, fromSeq: 0 }, new AbortController().signal)
      [Symbol.asyncIterator]()
    try {
      if (outcome === 'completed') await expect(events.next()).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
      else await expect(events.next()).resolves.toMatchObject({ value: { type: 'turn', payload: { report: {
        status: 'failed', output: { completion: { outcome, missing: ['剩余资料'] } },
      } } } })
    } finally { await events.return?.() }
  } finally { await f.host.close() }
})

function reworkReceipt(input: unknown) {
  const request = input as { action: string; deliverable_index?: number; file_name?: string }
  const target = request.action === 'publish_text_result' ? request.deliverable_index : request.file_name
  return {
    publication_status: 'registered', artifact_id: `artifact-${String(target)}`, sha256: 'a'.repeat(64), size_bytes: 24,
    ...(typeof target === 'number' ? { deliverable_index: target } : { file_name: target }),
  }
}

function reworkSchema(f: ReturnType<typeof fixture>) {
  return f.schemas().find((schema: any) => schema.name === 'orchestra_rework') as any
}

function schemaActions(f: ReturnType<typeof fixture>) {
  return reworkSchema(f).parameters.properties.action.enum as string[]
}

it('只在同一子会话提交成功回执后，于step/end收窄下一轮的发布目标', async () => {
  const targets = { texts: [
    { index: 2, title: 'title-2.txt', fileName: 'internal-2.md' },
    { index: 3, title: 'title-3.txt', fileName: 'internal-3.md' },
    { index: 4, title: 'title-4.txt', fileName: 'internal-4.md' },
  ], files: ['physical.csv'] }
  const publicationTargets = vi.fn<NonNullable<Options['publicationTargets']>>(() => targets)
  const feedback = vi.fn<NonNullable<Options['rework']>>((_binding, input) => reworkReceipt(input))
  const f = fixture('full', undefined, undefined, feedback, publicationTargets)
  try {
    await f.start()
    const initial = reworkSchema(f)
    expect(schemaActions(f)).toEqual(['publish', 'publish_text_result','read','read_material','inbox','get','request','accept','request_changes','escalate'])
    expect(initial.parameters.properties.deliverable_index).not.toHaveProperty('enum')
    expect(initial.parameters.properties.file_name).not.toHaveProperty('enum')

    const attempt = async (id: string, input: object, delivery: 'forged' | 'failed' | 'undelivered' | 'other-session') => {
      f.toolCall(id, input)
      const receipt = await f.executeLocal('orchestra_rework', input, id)
      const raw = JSON.stringify(receipt)
      if (delivery === 'forged') f.toolResult(id, JSON.stringify({ ...receipt, artifact_id: 'forged-artifact' }))
      if (delivery === 'failed') f.toolResult(id, raw, { isError: true })
      if (delivery === 'other-session') f.toolResult(id, raw, { sessionId: 'another-session' })
      f.stepEnd()
      expect(schemaActions(f)).toContain('publish')
      expect(schemaActions(f)).toContain('publish_text_result')
      expect(publicationTargets).not.toHaveBeenCalled()
      return receipt
    }
    const textInput = { action: 'publish_text_result', deliverable_index: 2, text: '可核验的正文。' }
    await attempt('forged-result', textInput, 'forged')
    await attempt('failed-result', textInput, 'failed')
    await attempt('other-session-result', textInput, 'other-session')
    await attempt('undelivered-result', textInput, 'undelivered')

    const realText = { action: 'publish_text_result', deliverable_index: 2, text: '真实登记正文。' }
    f.toolCall('real-text', realText)
    const textReceipt = await f.executeLocal('orchestra_rework', realText, 'real-text')
    f.toolResult('real-text', JSON.stringify(textReceipt))
    expect(schemaActions(f)).toContain('publish')
    expect(schemaActions(f)).toContain('publish_text_result')
    expect(publicationTargets).not.toHaveBeenCalled()
    f.stepEnd()
    expect(publicationTargets).toHaveBeenCalledOnce()
    expect(publicationTargets).toHaveBeenCalledWith(expect.objectContaining({ node_run_id: 'node', attempt: 1,
      action_generation: 1 }))
    expect(reworkSchema(f).parameters.properties.deliverable_index.enum).toEqual([3, 4])
    expect(reworkSchema(f).parameters.properties.file_name.enum).toEqual([
      'physical.csv', 'title-3.txt', 'internal-3.md', 'title-4.txt', 'internal-4.md',
    ])
    expect(schemaActions(f)).toContain('read')
    expect(schemaActions(f)).toContain('read_material')

    const beforeInvalidFile = feedback.mock.calls.length
    const invalidPhysical = { action: 'publish', file_name: 'title-3.txt', text: '不能把正文别名冒充文件。' }
    f.toolCall('wrong-physical-file', invalidPhysical)
    await expect(f.executeLocal('orchestra_rework', invalidPhysical, 'wrong-physical-file'))
      .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(feedback).toHaveBeenCalledTimes(beforeInvalidFile)

    const fileInput = { action: 'publish', file_name: 'physical.csv', text: '文件原件。' }
    f.toolCall('real-file', fileInput)
    const fileReceipt = await f.executeLocal('orchestra_rework', fileInput, 'real-file')
    f.toolResult('real-file', JSON.stringify(fileReceipt))
    f.stepEnd()
    expect(schemaActions(f)).not.toContain('publish')
    expect(schemaActions(f)).toContain('publish_text_result')
    expect(reworkSchema(f).parameters.properties.deliverable_index.enum).toEqual([3, 4])
    expect(reworkSchema(f).parameters.properties.file_name.enum).toEqual([
      'title-3.txt', 'internal-3.md', 'title-4.txt', 'internal-4.md',
    ])

    const titleAlias = { action: 'publish_text_result', deliverable_index: 3,
      file_name: 'title-3.txt', text: '用正式标题登记正文。' }
    f.toolCall('title-alias', titleAlias)
    const titleReceipt = await f.executeLocal('orchestra_rework', titleAlias, 'title-alias')
    expect(titleReceipt).toMatchObject({ publication_status: 'registered', deliverable_index: 3 })
    f.toolResult('title-alias', JSON.stringify(titleReceipt))
    f.stepEnd()
    expect(schemaActions(f)).toEqual(['publish_text_result','read','read_material','inbox','get','request','accept','request_changes','escalate'])
    expect(reworkSchema(f).parameters.properties.deliverable_index.enum).toEqual([4])
    expect(reworkSchema(f).parameters.properties.file_name.enum).toEqual(['title-4.txt', 'internal-4.md'])

    const internalAlias = { action: 'publish_text_result', deliverable_index: 4,
      file_name: 'internal-4.md', text: '用内部文件名登记正文。' }
    f.toolCall('internal-alias', internalAlias)
    const internalReceipt = await f.executeLocal('orchestra_rework', internalAlias, 'internal-alias')
    expect(internalReceipt).toMatchObject({ publication_status: 'registered', deliverable_index: 4 })
    f.toolResult('internal-alias', JSON.stringify(internalReceipt))
    f.stepEnd()
    expect(schemaActions(f)).toEqual(['read','read_material','inbox','get','request','accept','request_changes','escalate'])
    expect(reworkSchema(f).parameters.properties).not.toHaveProperty('text')
    expect(reworkSchema(f).parameters.properties).not.toHaveProperty('file_name')
    expect(reworkSchema(f).parameters.properties).not.toHaveProperty('deliverable_index')
    expect(feedback).toHaveBeenCalledTimes(8)
  } finally { await f.host.close() }
})

it('同批次两个已登记发布都可确认，显式operation_id保留，隐式ID对同目标重试稳定', async () => {
  const targets = { texts: [
    { index: 0, title: 'title-0.md', fileName: 'internal-0.md' },
    { index: 1, title: 'title-1.md', fileName: 'internal-1.md' },
  ], files: ['one.md', 'two.md'] }
  const publicationTargets = vi.fn<NonNullable<Options['publicationTargets']>>(() => targets)
  const feedback = vi.fn<NonNullable<Options['rework']>>((_binding, input) => reworkReceipt(input))
  const f = fixture('full', undefined, undefined, feedback, publicationTargets)
  try {
    await f.start()
    const first = { action: 'publish_text_result', deliverable_index: 0, text: '正文0。' }
    const second = { action: 'publish', file_name: 'one.md', text: '文件1。' }
    f.toolCall('batch-text', first)
    f.toolCall('batch-file', second)
    const firstReceipt = await f.executeLocal('orchestra_rework', first, 'batch-text')
    const secondReceipt = await f.executeLocal('orchestra_rework', second, 'batch-file')
    expect(firstReceipt).toMatchObject({ publication_status: 'registered', deliverable_index: 0 })
    expect(secondReceipt).toMatchObject({ publication_status: 'registered', file_name: 'one.md' })
    f.toolResult('batch-text', JSON.stringify(firstReceipt))
    f.toolResult('batch-file', JSON.stringify(secondReceipt))
    f.stepEnd()
    expect(reworkSchema(f).parameters.properties.deliverable_index.enum).toEqual([1])
    expect(reworkSchema(f).parameters.properties.file_name.enum).toEqual(['two.md', 'title-1.md', 'internal-1.md'])

    const implicit = { action: 'publish_text_result', deliverable_index: 1, text: '重试正文。' }
    const explicit = { action: 'publish', file_name: 'two.md', text: '显式ID文件。', operation_id: 'explicit-operation-id' }
    const implicit1 = await f.executeLocal('orchestra_rework', implicit, 'implicit-1')
    const implicit2 = await f.executeLocal('orchestra_rework', implicit, 'implicit-2')
    await f.executeLocal('orchestra_rework', explicit, 'explicit')
    const calls = feedback.mock.calls.map(([, input]) => input as Record<string, unknown>)
    expect(calls.slice(-3, -1).map(call => call.operation_id)).toEqual([expect.any(String), expect.any(String)])
    expect(calls.at(-2)?.operation_id).toBe(calls.at(-3)?.operation_id)
    expect(calls.at(-1)?.operation_id).toBe('explicit-operation-id')
    expect(implicit1).toMatchObject({ publication_status: 'registered', deliverable_index: 1 })
    expect(implicit2).toMatchObject({ publication_status: 'registered', deliverable_index: 1 })
  } finally { await f.host.close() }
})

it('无计划和新子会话保留首次发布工具，不继承旧子会话的收窄状态', async () => {
  const feedback = vi.fn<NonNullable<Options['rework']>>((_binding, input) => reworkReceipt(input))
  const unplanned = fixture('full', undefined, undefined, feedback, () => null)
  const fresh = fixture('full', undefined, undefined, feedback, () => ({ texts: [
    { index: 0, title: 'first-title.md', fileName: 'first-internal.md' },
  ], files: ['first.md'] }))
  try {
    await unplanned.start()
    expect(schemaActions(unplanned)).toContain('publish')
    expect(schemaActions(unplanned)).toContain('publish_text_result')
    const first = { action: 'publish_text_result', deliverable_index: 0, text: '无计划也能首次交付。' }
    unplanned.toolCall('unplanned-first', first)
    const receipt = await unplanned.executeLocal('orchestra_rework', first, 'unplanned-first')
    expect(receipt).toMatchObject({ publication_status: 'registered', deliverable_index: 0 })
    unplanned.toolResult('unplanned-first', JSON.stringify(receipt))
    unplanned.stepEnd()
    expect(schemaActions(unplanned)).toContain('publish_text_result')

    await fresh.start()
    expect(schemaActions(fresh)).toContain('publish')
    expect(schemaActions(fresh)).toContain('publish_text_result')
    expect(reworkSchema(fresh).parameters.properties.deliverable_index).not.toHaveProperty('enum')
    expect(reworkSchema(fresh).parameters.properties.file_name).not.toHaveProperty('enum')
  } finally { await Promise.all([unplanned.host.close(), fresh.host.close()]) }
})

it.each(['valid', 'repair', 'still malformed', 'expired'] as const)(
'成果读取范围和一次无工具补报在真实执行宿主保持有效（%s）', async scenario => {
  const { db, dir } = freshLedger()
  const host = createReworkHost(db, TEST_SECRET)
  const rework = vi.fn<NonNullable<Options['rework']>>((binding, input) => callDshRework(db, host, binding, input))
  const source = { message_id: 'm', text: '不联网，不读写工作区文件' }
  const f = fixture('inherit', undefined, { version: 1, start_policy: 'immediate', sources: [source], constraints: [
    { id: 'net', kind: 'no_network', source_message_id: source.message_id, quote: '不联网' },
    { id: 'read', kind: 'no_workspace_read', source_message_id: source.message_id, quote: '不读写工作区文件' },
    { id: 'write', kind: 'no_workspace_files', source_message_id: source.message_id, quote: '不读写工作区文件' },
  ] }, rework)
  try {
    const now = new Date().toISOString()
    withTx(db, tx => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','核算','running',?,?)", [now, now])
      tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES ('run','task','running',?,?)", [now, now])
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,side_effect_policy,created_at,updated_at)
        VALUES ('upstream','run','upstream',1,'agent','done',1,1,'pure',?,?),('node','run','review',2,'agent','started',1,1,'pure',?,?)`,
      [now, now, now, now])
    })
    const upstream = registerRunArtifact(db, { artifactId: 'approved-input', nodeRunId: 'upstream',
      runId: 'run', fileName: 'input.md', bytes: Buffer.from('已登记上游结果') }, now)
    withTx(db, tx => snapshotArtifactInputs(tx, 'node', ['upstream'], now))
    const spawned = await f.host.bridge.spawn({ nodeRunId: 'node', attempt: 1, actionGeneration: 1, input: {},
      outputSchema: {}, toolPolicy: { allow: [] }, inheritHistory: false, modelRef: 'p/m' })
    const fence = new AbortController()
    expect(f.host.bridge.installAttemptMonitor({ binding: { nodeRunId: 'node', attempt: 1, actionGeneration: 1,
      executorAgentId: spawned.agentId, executorSessionId: spawned.sessionId }, budget: () => 1000, actionTimeoutMs: 1000 },
    () => !fence.signal.aborted, fence.signal)).toBeTypeOf('function')
    await f.host.bridge.send({ executorAgentId: spawned.agentId, attempt: 1, attemptId: 'node:1', instruction: '核对已登记的内部成果。' })
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]).toContain('orchestra_rework({action:"read",artifact_id,artifact_hash})')
    expect(f.prompts[0]).toContain('publish_text_result 的成功回执已证明登记，无须再读自己的交付')
    const tool = 'orchestra_rework'
    const published = await f.executeLocal(tool, { action: 'publish', file_name: 'result.md', text: '退款 2 笔，合计 100 元。' }, 'publish')
    expect(published).toMatchObject({ artifact_id: expect.any(String), sha256: expect.any(String),
      publication_status: 'registered', file_name: 'result.md', next_action: expect.stringContaining('无需重发或回读') })
    expect(published).not.toHaveProperty('text')
    await expect(f.executeLocal(tool, { action: 'read', run_id: 'run' }, 'invalid-read'))
      .rejects.toMatchObject({ issues: expect.arrayContaining([
        expect.objectContaining({ path: ['artifact_id'] }), expect.objectContaining({ path: ['artifact_hash'] }),
      ]) })
    await expect(f.executeLocal(tool, { action: 'read', artifact_id: published.artifact_id,
      artifact_hash: published.sha256 }, 'own-read')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.executeLocal(tool, { action: 'read', artifact_id: upstream.artifact_id,
      artifact_hash: upstream.sha256 }, 'bound-read')).resolves.toMatchObject({ text: '已登记上游结果' })
    expect(f.guard(f.call('read'))).toBeTruthy()
    expect(f.guard(f.call('bili_hot'))).toBeTruthy()
    const report = { status: 'done', output: { summary: '退款核对完成。', completion: { outcome: 'completed' },
      facts: { refund_count: 2, refund_total_yuan: 100 } } }
    if (scenario === 'valid') f.finish(report)
    else {
      if (scenario === 'expired') fence.abort()
      f.finishText('## 已完成\n退款 2 笔，共 100 元。')
      if (scenario !== 'expired') {
        await expect.poll(() => f.prompts.length, { timeout: 1_000 }).toBe(2)
        expect(f.prompts[1]).toContain('JSON')
        expect(f.restrict).toHaveBeenCalledWith({ allow: [] })
        for (const toolName of ['orchestra_rework', 'read', 'bili_hot', 'run_code']) {
          const call = f.call(toolName, 'repair-attempt-' + toolName)
          expect(f.guard(call)).toBeTruthy()
          expect((await f.pre(call)).kind).toBe('deny')
          const execute = vi.fn()
          await expect(f.run(call, execute)).rejects.toThrow()
          expect(execute).not.toHaveBeenCalled()
        }
        if (scenario === 'repair') f.finish(report)
        else f.finishText('## 我仍然只返回 Markdown')
      }
    }
    await f.host.bridge.whenIdle({ executorAgentId: spawned.agentId, timeoutMs: 1000 })
    const events = f.host.bridge.listen({ executorAgentId: spawned.agentId, attempt: 1, fromSeq: 0 }, new AbortController().signal)
      [Symbol.asyncIterator]()
    try {
      if (scenario === 'valid' || scenario === 'repair') {
        await expect(events.next()).resolves.toMatchObject({ value: { type: 'turn', attempt: 1, executorAgentId: spawned.agentId,
          payload: { report } } })
      } else await expect(events.next()).rejects.toThrow()
    } finally { await events.return?.() }
    expect(f.prompts).toHaveLength(scenario === 'repair' || scenario === 'still malformed' ? 2 : 1)
    expect(rework).toHaveBeenCalledTimes(4)
    expect(db.raw.prepare('SELECT node_run_id FROM artifact_contents WHERE artifact_id=?').get(published.artifact_id))
      .toMatchObject({ node_run_id: 'node' })
  } finally {
    await f.host.close()
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
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

it('禁止工作区读取时派发不发现目录技能，普通任务仍可用已授权的公开读取工具', async () => {
  const source = { message_id: 'm', text: '查询公开资讯，不读取工作区文件' }
  const restricted = fixture('inherit', undefined, { version: 1, start_policy: 'immediate', sources: [source], constraints: [
    { id: 'read', kind: 'no_workspace_read', source_message_id: source.message_id, quote: '不读取工作区文件' },
  ] })
  const normal = fixture('inherit')
  restricted.enablePublicSkill()
  normal.enablePublicSkill()
  try {
    await restricted.start()
    expect(restricted.listSkills).not.toHaveBeenCalled()
    expect(restricted.hasLocalTool(PUBLIC_READ_TOOL)).toBe(false)
    expect(restricted.guard(restricted.call('read'))).toContain('禁止读取工作区')
    await normal.start()
    expect(normal.listSkills).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: process.cwd() }))
    expect(normal.hasLocalTool(PUBLIC_READ_TOOL)).toBe(true)
    expect(normal.guard(normal.call(PUBLIC_READ_TOOL))).toBeUndefined()
    expect(await normal.pre(normal.call(PUBLIC_READ_TOOL))).toEqual({ kind: 'allow' })
  } finally {
    await Promise.all([restricted.host.close(), normal.host.close()])
  }
})

it.each(['full', 'inherit', 'user', 'brain'] as const)('offline/read boundary also blocks the actual native execution hook in %s mode', async mode => {
  const source = { message_id: 'm', text: '不联网，不读写工作区文件' }
  const f = fixture(mode, undefined, { version: 1, start_policy: 'immediate', sources: [source], constraints: [
    { id: 'net', kind: 'no_network', source_message_id: 'm', quote: '不联网' },
    { id: 'read', kind: 'no_workspace_read', source_message_id: 'm', quote: '不读写工作区文件' },
    { id: 'write', kind: 'no_workspace_files', source_message_id: 'm', quote: '不读写工作区文件' },
  ] })
  try {
    await f.start()
    for (const name of ['bili_hot', 'read', 'write', 'pwsh', 'run_code']) {
      const next = vi.fn(async () => ({ content: [], isError: false as const, value: {} }))
      expect(f.guard(f.call(name))).toBeTruthy()
      expect((await f.pre(f.call(name))).kind).toBe('deny')
      await expect(f.run(f.call(name), next)).rejects.toThrow()
      expect(next).not.toHaveBeenCalled()
    }
  } finally { await f.host.close() }
})
