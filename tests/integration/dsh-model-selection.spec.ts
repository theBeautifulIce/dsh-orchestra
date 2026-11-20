import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createDshExecutor, MODEL_CATALOG_TIMEOUT_MS } from '../../src/executor/dsh-host.ts'
import type { ModelReasoning } from '../../src/executor/model-routing.ts'

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
