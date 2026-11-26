import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createDshExecutor, createDshPlanningCallback, MODEL_CATALOG_TIMEOUT_MS } from '../../src/executor/dsh-host.ts'
import type { ModelReasoning } from '../../src/executor/model-routing.ts'
import type { RequirementsContract } from '../../src/core/task-requirements.ts'
import { PUBLIC_READ_TOOL } from '../../src/executor/public-read.ts'

it('目录刷新可单飞、有界重试，关闭或超时的迟到结果不得替换目录', async () => {
  const snapshot = (model: string) => ({ profiles: [{ ref: 'p/' + model, provider: 'p', model, capacity: 'standard' as const }] })
  const stale = Promise.withResolvers<ReturnType<typeof snapshot>>()
  const closing = Promise.withResolvers<ReturnType<typeof snapshot>>()
  const load = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(snapshot('new')).mockReturnValueOnce(closing.promise)
  const host = createDshExecutor({ context: {} as Context, parentForNode: () => undefined, models: snapshot('old').profiles,
    loadModelCatalog: load, recommend: () => ({ complexity: 'standard', reason: 'fixture' }) })
  vi.useFakeTimers()
  try {
    const signal = new AbortController()
    const refresh = host.modelRouting.refresh!
    const waiter = refresh(signal.signal)
    const first = expect(waiter).rejects.toBe('test-cancelled')
    const second = expect(refresh()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('读取超时') })
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    signal.abort('test-cancelled')
    await first
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_TIMEOUT_MS)
    await second
    expect(host.modelRouting.catalog!().profiles).toMatchObject([{ model: 'old' }])
    await refresh()
    stale.resolve(snapshot('late'))
    await Promise.resolve()
    expect(host.modelRouting.catalog!().profiles).toMatchObject([{ model: 'new' }])
    const shutdown = expect(refresh()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('关闭') })
    await Promise.resolve()
    await host.close()
    await shutdown
    closing.resolve(snapshot('late-shutdown'))
    expect(load).toHaveBeenCalledTimes(3)
    expect(host.modelRouting.catalog!().profiles).toMatchObject([{ model: 'new' }])
  } finally { vi.useRealTimers(); await host.close() }
})

it('每个主脑阶段固定该次选择，旧供应商额度错误可安全回报并切换后重试', async () => {
  type Selection = { provider: string; model: string; reasoningEffort?: string }
  const old = { provider: 'old', model: 'same' }
  const next = { provider: 'new', model: 'same', reasoningEffort: 'deep' }
  let selection: Selection = old
  const routes: Selection[] = []
  const planned = (options: { agentOptions: Selection; setup: (ctx: unknown, agent: unknown) => void }) => {
    const events: unknown[] = []
    let entered = Promise.resolve()
    let preStep: ({ agent, modelSelection }: { agent: unknown; modelSelection: Selection }, run: () => void) => Promise<void>
    const agent = { model: { select() {} }, session: { snapshotEvents: () => events }, followup(message: { source: { kind: string } }) {
      expect(message.source.kind).toBe('plugin:dsh-orchestra')
      const { provider } = options.agentOptions
      entered = preStep({ agent, modelSelection: options.agentOptions }, () => {
        routes.push(options.agentOptions)
        events.push({ type: 'request/header', data: { header: { config: options.agentOptions } } },
          { type: 'turn/end', data: { reason: provider === old.provider
            ? { kind: 'error', error: { code: 'QUOTA', message: 'private provider diagnostics' } } : { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"ok":true}' }] } } })
      })
    }, whenIdle: () => entered }
    options.setup({ tools: { restrict() {} }, on(_event: string, cb: typeof preStep) { preStep = cb } }, agent)
    return { agent, async dispose() {} }
  }
  type Options = Parameters<typeof createDshPlanningCallback>[0]
  const parent = { session: { id: 'parent', header: { cwd: process.cwd() } }, model: { current: () => selection },
    ctx: { agents: { create: async (options: Parameters<typeof planned>[0]) => planned(options) } } } as unknown as NonNullable<ReturnType<Options['parent']>>
  const context = { agents: { get: () => parent }, llm: { listModels: async () => [{ id: 'same' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'deep' }] } }) } } as unknown as Context
  const model = (agent: typeof parent) => agent.model.current()
  const propose = createDshPlanningCallback({ context, parent: () => parent, model })
  await expect(propose({ goal: 'first' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('额度不足') })
  selection = next
  await expect(propose({ goal: 'retry' })).resolves.toEqual({ ok: true })
  await expect(createDshPlanningCallback({ context, parent: () => parent, model }, 'workflow')({ goal: 'workflow' })).resolves.toEqual({ ok: true })
  await expect(createDshPlanningCallback({ context, parent: () => parent, model }, 'rework')({ purpose: 'inspect' })).resolves.toEqual({ ok: true })
  const pinned = createDshPlanningCallback({ context, parent: () => parent, model: old })
  await expect(pinned({ goal: 'fixed' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('额度不足') })
  expect(routes.map(({ provider, model: id, reasoningEffort }) => [provider, id, reasoningEffort ?? null])).toEqual([
    ['old', 'same', null], ['new', 'same', 'deep'], ['new', 'same', 'deep'], ['new', 'same', 'deep'], ['old', 'same', null],
  ])
})

it.each([
  ['plan', 'success'], ['workflow', 'success'], ['plan', 'reused_header'], ['workflow', 'reused_header'],
  ['plan', 'truncated'], ['plan', 'no_message'], ['plan', 'no_initial_header'],
  ['plan', 'wrong_route'], ['plan', 'wrong_initial_route'], ['rework', 'truncated'],
] as const)('handles a native length stop in the same %s agent (%s)', async (purpose, followup) => {
  const route = { provider: 'fixture', model: 'planner', reasoningEffort: 'high' }
  const events: unknown[] = []
  const prompts: string[] = []
  const dispose = vi.fn(async () => {})
  const create = vi.fn(async (options: { agentOptions: typeof route & { maxTokens: number } }) => {
    expect(options.agentOptions.maxTokens).toBe(8192)
    const agent = { session: { snapshotEvents: () => [...events] }, whenIdle: async () => {},
      followup(message: { content: { text: string }[] }) {
        prompts.push(message.content[0]!.text)
        const first = prompts.length === 1
        const wrongRoute = first ? followup === 'wrong_initial_route' : followup === 'wrong_route'
        const config = wrongRoute ? { ...route, model: 'different' } : route
        if (first ? followup !== 'no_initial_header' : followup !== 'reused_header' && followup !== 'no_message') {
          events.push({ type: 'request/header', data: { header: { config } } })
        }
        if (first || followup !== 'no_message') events.push({ type: 'assistant/message', data: { message: {
          content: [{ type: 'text', text: first ? '{"stale":true}' : '{"complete":true}' }],
        } } })
        events.push({ type: 'turn/end', data: { reason: { kind: first || followup === 'truncated' ? 'max-tokens' : 'completed' } } })
      } }
    return { agent, dispose }
  })
  type Parent = NonNullable<ReturnType<Parameters<typeof createDshPlanningCallback>[0]['parent']>>
  const parent = { session: { id: 'parent', header: { cwd: process.cwd() } }, ctx: { agents: { create } } } as unknown as Parent
  const context = { agents: { get: () => parent }, llm: { listModels: async () => [{ id: route.model }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) } } as unknown as Context
  const result = createDshPlanningCallback({ context, parent: () => parent, model: route }, purpose)({ goal: 'fixture input marker' })
  if (followup === 'success' || followup === 'reused_header') await expect(result).resolves.toEqual({ complete: true })
  else if (followup === 'wrong_route' || followup === 'wrong_initial_route' || followup === 'no_initial_header') {
    await expect(result).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
  }
  else await expect(result).rejects.toMatchObject({ details: { planning_issue: followup === 'no_message' ? 'format' : 'length' } })
  expect(create).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(prompts).toHaveLength(purpose === 'rework' || followup === 'wrong_initial_route' || followup === 'no_initial_header' ? 1 : 2)
  if (prompts.length > 1) {
    expect(prompts[1]).not.toContain('fixture input marker')
    expect(prompts[1]).not.toContain('stale')
  }
})

it('keeps built-in coordination in both planning prompts while offline or workspace-read restrictions suppress skill discovery', async () => {
  type Options = Parameters<typeof createDshPlanningCallback>[0]
  const route = { provider: 'fixture', model: 'gpt-6.2-sol', reasoningEffort: 'medium' }
  const prompts: string[] = []
  const toolSchemas = vi.fn(() => [{ name: 'read', description: '外部能力快照示例' }, { name: 'skill', description: '读取技能' }])
  const listSkills = vi.fn(async () => [{ name: 'aihot', description: '读取公开资讯', invocation: { modelInvocable: true } }])
  const parent = { session: { id: 'fixture', header: { cwd: process.cwd() } }, ctx: {
    get(name: string) { return name === 'tools' ? { schemas: toolSchemas } : name === 'skills' ? { list: listSkills } : undefined },
    agents: { async create(options: { setup(ctx: unknown, agent: unknown): void }) {
      const events: unknown[] = []
      const child = { model: { select() {} }, session: { snapshotEvents: () => events },
        followup(message: { content: Array<{ text: string }> }) {
          prompts.push(message.content[0]!.text)
          events.push({ type: 'request/header', data: { header: { config: route } } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{}' }] } } },
            { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }, whenIdle: async () => {},
      }
      options.setup({ tools: { restrict() {} }, on() {} }, child)
      return { agent: child, async dispose() {} }
    } },
  } } as unknown as NonNullable<ReturnType<Options['parent']>>
  const context = { agents: { get: () => parent }, llm: { listModels: async () => [{ id: route.model }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: route.reasoningEffort }] } }) } } as unknown as Context
  const options = { context, parent: () => parent, model: route, coordinationAvailable: true,
    executionPermissionMode: () => 'inherit' as const }
  const goal = 'T06：两个只读代理独立计算。A 向 B 发一次 30 秒核对请求，立即按原参数重发一次检验去重。B 故意不回应。不要轮询、不联网。'
  const contract: RequirementsContract = { version: 1, start_policy: 'immediate', sources: [{ message_id: 'm', text: goal }],
    constraints: [{ id: 'network', kind: 'no_network', quote: '不联网', source_message_id: 'm' }] }
  const input = { goal, requirements_contract: contract }
  await createDshPlanningCallback(options, 'workflow')(input)
  await createDshPlanningCallback(options, 'plan')({ ...input, workflows: [] })
  expect(toolSchemas).not.toHaveBeenCalled()
  expect(listSkills).not.toHaveBeenCalled()
  expect(prompts).toHaveLength(2)
  for (const prompt of prompts) {
    expect(prompt).toMatch(/内部协作信箱 orchestra_coordination[^。\n]*。它独立于 native_tools 和固定命令/u)
    expect(prompt).toMatch(/同行沟通在现有节点内完成，保留并行职责和正式成果依赖/u)
    expect(prompt).toContain('仅为转述无需增派汇总代理。需要跨分支核算、复核或有指定汇总角色时保留该节点。')
    expect(prompt).toMatch(/可独立完成的工作在无人回复时继续/u)
    expect(prompt).toMatch(/只在实际缺少必需条件时安排重试/u)
    expect(prompt).toMatch(/任务已由宿主强制执行的限制本身不是能力缺口/u)
    expect(prompt).not.toContain('host_capabilities=')
    expect(prompt).toContain('按原参数重发一次检验去重')
  }

  const noWorkspace = '核对公开资讯，不读取工作区文件'
  const workspaceContract: RequirementsContract = { version: 1, start_policy: 'immediate',
    sources: [{ message_id: 'm', text: noWorkspace }],
    constraints: [{ id: 'read', kind: 'no_workspace_read', source_message_id: 'm', quote: '不读取工作区文件' }] }
  const restricted = { goal: noWorkspace, requirements_contract: workspaceContract }
  await createDshPlanningCallback(options, 'workflow')(restricted)
  await createDshPlanningCallback(options, 'plan')({ ...restricted, workflows: [] })
  expect(toolSchemas).not.toHaveBeenCalled()
  expect(listSkills).not.toHaveBeenCalled()
  for (const prompt of prompts.slice(2)) {
    expect(prompt).toContain('禁止读取工作区')
    expect(prompt).not.toContain('host_capabilities=')
    expect(prompt).not.toContain(PUBLIC_READ_TOOL)
  }

  const unavailable = { ...options, coordinationAvailable: false }
  await createDshPlanningCallback(unavailable)({ goal: '核对普通资料' })
  expect(toolSchemas).toHaveBeenCalledOnce()
  expect(listSkills).toHaveBeenCalledOnce()
  expect(prompts.at(-1)).toContain('host_capabilities=')
  expect(prompts.at(-1)).toContain('外部能力快照示例')
  expect(prompts.at(-1)).toContain(PUBLIC_READ_TOOL)
  expect(prompts.at(-1)).not.toMatch(/(?:内置|内部)协作信箱/u)
})

it('显式主脑可选未评级模型，模型或档位失效时按正式目录拒绝且不用旧缓存', async () => {
  const profiles = [
    { ref: 'a/same', provider: 'a', model: 'same', capacity: 'standard' as const },
    { ref: 'b/same', provider: 'b', model: 'same', capacity: null, reasoning: { efforts: [{ id: 'deep', name: 'Deep' }] } },
  ]
  const load = vi.fn().mockResolvedValue({ profiles })
  const host = createDshExecutor({ context: {} as Context, parentForNode: () => undefined,
    models: [], loadModelCatalog: load, recommend: () => ({ complexity: 'standard', reason: 'fixture' }) })
  const signal = new AbortController().signal
  try {
    await expect(host.resolvePlanningModel('b/same', 'deep', signal)).resolves.toEqual({ provider: 'b', model: 'same', reasoningEffort: 'deep' })
    await expect(host.resolvePlanningModel('b/same', null, signal)).resolves.toEqual({ provider: 'b', model: 'same', reasoningEffort: null })
    await expect(host.resolvePlanningModel('b/same', 'invalid', signal)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('思考深度') })
    load.mockRejectedValueOnce(new Error('offline'))
    await expect(host.resolvePlanningModel('b/same', 'deep', signal)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    load.mockResolvedValueOnce({ profiles: profiles.slice(0, 1) })
    await expect(host.resolvePlanningModel('b/same', 'deep', signal)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('没有所选主脑模型') })
  } finally { await host.close() }
})

it('分别固定同名模型的供应商与思考档，并核验并行子会话各自的请求头', async () => {
  type Selection = { provider: string; model: string; reasoningEffort?: string }
  type Agent = { model: { current: () => Selection } }
  type BeforeStep = (step: { agent: Agent; modelSelection: Selection }, next: () => Promise<void>) => Promise<void>
  const thinking = { efforts: [{ id: 'deep', name: 'Deep' }], defaultEffort: 'deep' } satisfies ModelReasoning
  const sent = vi.fn()
  const parent = { session: { id: 'parent', header: { cwd: process.cwd() } }, ctx: { agents: {
    async create(options: { sessionId: string; agentOptions: Selection; setup: (ctx: unknown, agent: Agent) => void }) {
      let selected = options.agentOptions
      let beforeStep: BeforeStep | undefined
      let idle = Promise.resolve()
      const events: unknown[] = []
      const agent = {
        session: { id: options.sessionId, snapshotEvents: () => events },
        model: { current: () => selected, select: (selection: Selection) => { selected = selection } },
        followup() {
          sent(selected)
          idle = beforeStep!({ agent, modelSelection: selected }, async () => {
            events.push({ type: 'request/header', data: { header: { config: selected } } },
              { type: 'turn/end', data: { reason: { kind: 'completed' } } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"status":"done"}' }] } } })
          })
        },
        whenIdle: () => idle,
      }
      options.setup({ tools: { restrict() {} },
        on: (_event: string, handler: BeforeStep) => { beforeStep = handler } }, agent)
      return { agent, async dispose() {} }
    },
  } } }
  const routes = [
    { ref: 'a/same', provider: 'a', model: 'same', capacity: 'standard', reasoning: thinking },
    { ref: 'b/same', provider: 'b', model: 'same', capacity: 'expert' },
  ] as const
  const host = createDshExecutor({
    context: { llm: { listModels: async () => [{ id: 'same' }],
      resolveModelInfo: async (provider: string) => provider === 'a' ? { reasoning: thinking } : {} },
      agents: { get: () => parent } } as unknown as Context,
    parentForNode: () => parent as unknown as NonNullable<ReturnType<Parameters<typeof createDshExecutor>[0]['parentForNode']>>,
    models: routes, recommend: () => ({ complexity: 'standard', reason: 'fixture' }),
  })
  const spawn = (modelRef: string, reasoningEffort: string | null) => host.bridge.spawn({
    modelRef, reasoningEffort, attempt: 1, nodeRunId: modelRef, inheritHistory: false,
    actionGeneration: 1, input: {}, outputSchema: {}, toolPolicy: { allow: [] },
  })
  try {
    await expect(spawn('b/same', 'deep')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const [explicit, defaults] = await Promise.all([spawn('a/same', 'deep'), spawn('b/same', null)])
    expect(explicit).toMatchObject({ effectiveModelRef: 'a/same', effectiveReasoningEffort: 'deep' })
    expect(defaults).toMatchObject({ effectiveModelRef: 'b/same', effectiveReasoningEffort: null })
    const send = (executorAgentId: string) => host.bridge.send({ executorAgentId, attempt: 1, attemptId: executorAgentId, instruction: 'fixture' })
    await Promise.all([send(explicit.agentId), send(defaults.agentId), send(explicit.agentId)])
    expect(sent.mock.calls).toEqual([[{ provider: 'a', model: 'same', reasoningEffort: 'deep' }], [{ provider: 'b', model: 'same' }]])
    const page = (executorAgentId: string) => host.bridge.fetchPage({ executorAgentId, attempt: 1, fromSeq: 0, pageSize: 10 })
    expect((await page(explicit.agentId)).events[0]?.payload).toMatchObject({
      model_use: { model_ref: 'a/same', provider: 'a', model: 'same', reasoning_effort: 'deep', observed_request_headers: 1 },
    })
    expect((await page(defaults.agentId)).events[0]?.payload).toMatchObject({
      model_use: { model_ref: 'b/same', provider: 'b', model: 'same', reasoning_effort: null, observed_request_headers: 1 },
    })
  } finally { await host.close() }
})
