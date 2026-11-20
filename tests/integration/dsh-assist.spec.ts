import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { ASSIST_TIMEOUT_MS, createDshExecutor } from '../../src/executor/dsh-host.ts'
import type { SpawnParams } from '../../src/executor/bridge.ts'
import { RELEASE_CHECK_WORKFLOW_ID } from '../../src/core/wf-release-v1.ts'
import { describeEvent } from '../../src/service/queries/execution-history.ts'

const toolName = 'orchestra_assist'
const selection = { provider: 'p', model: 'm', reasoningEffort: 'high' }
type Agent = { session: { id: string; header: object }; status: string }
type Message = { source: { kind: string }; content: Array<{ text: string }> }

function fixture() {
  const live = new Map<string, unknown>()
  const onPrompt = vi.fn()
  const children: Array<ReturnType<typeof makeChild>> = []
  function makeChild(options: {
    sessionId: string; meta: { parentSession: string; delegationDepth: number }; seed?: unknown;
    agentOptions: typeof selection; setup(ctx: unknown, agent: Agent): void
  }) {
    const output = Promise.withResolvers<void>()
    const events: unknown[] = []
    const tools = new Map<string, ToolDefinition>()
    const restrict = vi.fn()
    let route = options.agentOptions
    const agent = {
      session: { id: options.sessionId, header: options.meta, snapshotEvents: () => events },
      ctx: { agents: { create } },
      model: { current: () => route, select: (value: typeof route) => { route = value } },
      status: 'idle',
      followup(message: Message) {
        agent.status = 'running'
        onPrompt(options, message)
      },
      cancel: vi.fn(() => { agent.status = 'idle'; output.resolve() }),
      whenIdle: () => output.promise,
    }
    options.setup({ tools: { restrict, register: (tool: ToolDefinition) => tools.set(tool.name, tool) }, on() {} }, agent)
    const dispose = vi.fn(async () => { live.delete(options.sessionId); output.resolve() })
    const finish = (review = '复核完成', reason = 'completed') => {
      agent.status = 'idle'
      events.push({ type: 'request/header', data: { header: { config: route } } },
        { type: 'turn/end', data: { reason: { kind: reason } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: review }] } } })
      output.resolve()
    }
    return { agent, dispose, finish, tools, restrict, options }
  }
  async function create(args: Parameters<typeof makeChild>[0]): Promise<ReturnType<typeof makeChild>> {
    const child = makeChild({ ...args, meta: { ...args.meta, ...{ cwd: process.cwd() } } })
    live.set(args.sessionId, child.agent)
    children.push(child)
    return child
  }
  const root = { session: { id: 'root', header: { cwd: process.cwd() } }, ctx: { agents: { create } } }
  live.set('root', root)
  const host = createDshExecutor({
    context: { agents: { get: (id: string) => live.get(id) }, llm: {
      listModels: async () => [{ id: selection.model }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: selection.reasoningEffort }] } }),
    } } as unknown as Context,
    parentForNode: () => root as unknown as NonNullable<ReturnType<Parameters<typeof createDshExecutor>[0]['parentForNode']>>,
    models: [{ ...selection, ref: 'p/m', capacity: 'standard' }],
    recommend: () => ({ complexity: 'standard', reason: 'fixture' }),
  })
  const spawn = async (toolPolicy: unknown, actionGeneration: number | null = 1) => {
    const params: SpawnParams = {
      input: {}, outputSchema: {}, toolPolicy, inheritHistory: false, nodeRunId: 'node', attempt: 1,
      ...(actionGeneration === null ? {} : { actionGeneration }),
      modelRef: 'p/m', reasoningEffort: selection.reasoningEffort,
    }
    const { agentId } = await host.bridge.spawn(params)
    const node = children.find(({ agent }) => agent.session.id === agentId)!
    await host.bridge.send({ executorAgentId: agentId, attempt: 1, attemptId: 'one', instruction: 'private parent history marker' })
    const assist = node.tools.get(toolName)
    return { node, agentId, assist, review: (names: string[], callId: string, signal = new AbortController().signal,
      agent = node.agent) => assist!.execute({
      tasks: names.map((name) => ({ name, instruction: '只核对这一条', material: 'text-' + name })),
    }, { callId, signal, agent } as unknown as Parameters<ToolDefinition['execute']>[1]) }
  }
  return { host, children, onPrompt, spawn }
}

it('shares the attempt concurrency limit across overlapping batches, fills slots and returns ordered independent reviews', async () => {
  const { host, children, onPrompt, spawn } = fixture()
  try {
    const { agentId, review } = await spawn({ allow: [], workflowHelperLimit: 2 })
    const first = review(['A', 'B', 'C'], 'first')
    const second = review(['D'], 'second')
    await vi.waitFor(() => expect(children).toHaveLength(3))
    expect(onPrompt).toHaveBeenCalledTimes(3)
    for (const [, message] of onPrompt.mock.calls.slice(1) as Array<[unknown, Message]>) {
      expect(message.source.kind).toBe('plugin:dsh-orchestra')
      expect(message.content[0]?.text).not.toContain('private parent history marker')
    }
    const [a, b] = children.slice(1)
    expect(a!.tools.size).toBe(0)
    expect(a!.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(a!.options.agentOptions).toMatchObject(selection)
    expect(a!.options.seed).toBeUndefined()
    expect(a!.options.meta).toMatchObject({ parentSession: agentId, delegationDepth: 2, origin: 'subagent', isSeeded: false })
    b!.finish('B clean')
    await vi.waitFor(() => expect(children).toHaveLength(4))
    const c = children[3]!
    c.finish('', 'error')
    await vi.waitFor(() => expect(children).toHaveLength(5))
    a!.finish('A clean')
    children[4]!.finish('D clean')
    const results = (value: unknown) => JSON.parse((value as { text: string }).text).results
    expect(results(await first)).toEqual([
      { name: 'A', status: 'completed', review: 'A clean' },
      { name: 'B', status: 'completed', review: 'B clean' },
      { name: 'C', status: 'failed' },
    ])
    expect(results(await second)).toEqual([{ name: 'D', status: 'completed', review: 'D clean' }])
    for (const child of children.slice(1)) expect(child.dispose).toHaveBeenCalledTimes(1)
    const { events } = await host.bridge.fetchPage({ executorAgentId: agentId, attempt: 1, fromSeq: 0, pageSize: 10 })
    const trace = events.map((event) => ({ type: event.type, details: describeEvent('bridge.' + event.type, JSON.stringify(event)) }))
    expect(trace).toHaveLength(4)
    expect(trace).toContainEqual(expect.objectContaining({ type: 'tool.result', details: expect.arrayContaining([
      { label: '工具', value: toolName }, { label: '调用 ID', value: 'first' }, { label: '复核批次', value: '完成 2/3 项文本复核' },
    ]) }))
    expect(JSON.stringify(trace)).not.toContain('text-A')
  } finally { await host.close() }
})

it('tool unavailable by default, for an explicit deny, outside authorized dispatch and for release checks', async () => {
  const { host, spawn } = fixture()
  try {
    expect((await spawn({ allow: [] })).assist).toBeUndefined()
    expect((await spawn({ allow: [], deny: [toolName], workflowHelperLimit: 4 })).assist).toBeUndefined()
    expect((await spawn({ allow: [RELEASE_CHECK_WORKFLOW_ID], workflowHelperLimit: 2 })).assist).toBeUndefined()
    expect((await spawn({ allow: [], workflowHelperLimit: 9 })).assist).toBeUndefined()
    expect((await spawn({ allow: [], workflowHelperLimit: 2 }, null)).assist).toBeUndefined()
    const node = await spawn({ allow: [], workflowHelperLimit: 2 })
    const other = await spawn({ allow: [] })
    await expect(node.review(['A'], 'wrong-agent', undefined, other.node.agent)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(node.review(['A', 'A'], 'duplicate-names')).rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  } finally { await host.close() }
})

it('each child deadline releases its slot and attempt cancellation clears running and waiting jobs', async () => {
  const { host, children, spawn } = fixture()
  vi.useFakeTimers()
  try {
    const { review, agentId } = await spawn({ workflowHelperLimit: 1 })
    const batch = review(['deadline', 'next', 'never'], 'run')
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(ASSIST_TIMEOUT_MS)
    expect(children[1]!.agent.cancel).toHaveBeenCalledTimes(1)
    expect(children[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(3)
    await host.bridge.cancel({ executorAgentId: agentId, attempt: 1 })
    const response = await batch
    expect(JSON.parse((response as { text: string }).text).results).toEqual([
      { name: 'deadline', status: 'timeout' }, { name: 'next', status: 'failed' }, { name: 'never', status: 'failed' },
    ])
    expect(children[2]!.agent.cancel).toHaveBeenCalledTimes(1)
    expect(children[2]!.dispose).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(3)
  } finally {
    await host.close()
    vi.useRealTimers()
  }
})

it('tool abort frees capacity for subsequent batches and closing the host disposes all remaining helper handles', async () => {
  const { host, children, spawn } = fixture()
  try {
    const { review } = await spawn({ workflowHelperLimit: 1 })
    const abort = new AbortController()
    const batch = expect(review(['aborted', 'never'], 'abort', abort.signal)).rejects.toBe('tool-aborted')
    await vi.waitFor(() => expect(children).toHaveLength(2))
    abort.abort('tool-aborted')
    await batch
    const next = review(['next'], 'next')
    await vi.waitFor(() => expect(children).toHaveLength(3))
    await host.close()
    await expect(next).resolves.toMatchObject({ text: expect.stringContaining('"status":"failed"') })
    expect(children[2]!.agent.cancel).toHaveBeenCalledTimes(1)
    expect(children[2]!.dispose).toHaveBeenCalledTimes(1)
  } finally { await host.close() }
})
