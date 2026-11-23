import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { serveOrchestra, type serveDshOrchestra, type TaskPlanProposal } from '../../src/index.ts'
import { OrchError } from '../../src/core/errors.ts'
import { decisionId, uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { transitionNode } from '../../src/service/commands/node-state.ts'
import { installConfiguredLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'
import { planningTimeoutDefaults } from '../../src/service/planning-settings.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createDeliveryReviewHost } from '../../src/service/delivery-review.ts'
import { recordArtifactPublication } from '../../src/service/artifact-completion.ts'
import { applyRunAcceptance } from '../../src/service/commands/run-acceptance.ts'
import { classifyChatTask } from '../../src/service/chat-task-intent.ts'
import { reportChatRun } from '../../src/service/chat-task-receipts.ts'
import { installNativeChat } from '../../src/service/chat-native.ts'

type Message = Parameters<Agent['followup']>[0]
type Definition = Parameters<Context['tools']['register']>[0]
type Activation = NonNullable<Parameters<Context['tools']['register']>[1]>
type Guard = Parameters<Context['tools']['guard']>[0]
type Service = Awaited<ReturnType<typeof serveDshOrchestra>>

async function fixture(options: { profile?: string; version?: string; enabled?: false | 'desktop'; host?: string;
  routing?: { enabled: boolean }; reportRequirements?: string[]; planningError?: OrchError; dispatchPlans?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-native-chat-'))
  const ctx = new Context()
  const agents = new Map<string, Agent>()
  const conversations = new Map<string, string[]>()
  const routes: string[] = []
  const notices: Array<{ sessionId: string; message: Message }> = []
  let tool: Definition | undefined
  let activation: Activation | undefined
  let guard: Guard | undefined
  let prompt: ((context: { agent: Agent }) => string) | undefined
  let deny = false
  let badPlan = false
  let plannerUnavailable = false
  const secret = 'fixture-ledger-secret'
  const approval = vi.fn(async (_request: { agent: Agent; toolName: string; callId: string; reason: string; signal: AbortSignal }) =>
    deny ? 'rejected' : 'allowed-once')
  const services = new Map<string, Service>()
  const spawn = vi.fn()
  const registry = new ToolRegistry()
  const planner = vi.fn(async ({ goal, workflows }: Parameters<NonNullable<Parameters<typeof serveOrchestra>[0]['planning']>['propose']>[0]): Promise<TaskPlanProposal> => {
    if (options.planningError) throw options.planningError
    if (plannerUnavailable) throw new Error('fake unavailable host')
    const workflow = workflows[0]!
    return {
      title: goal.slice(0, 40), workflow_id: workflow.workflowId, workflow_version: workflow.version,
      steps: [{ node_id: 'draft', description: '整理报告', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '整理文字' }],
      deliverables: (options.reportRequirements ?? ['report.md']).map((fileName) => ({
        title: fileName, node_id: 'draft', goal_ids: ['goal'],
        acceptance: { kind: 'artifact', file_name: fileName, minimum_bytes: 8 },
      })),
      risks: badPlan ? [{ severity: 'high', description: '涉及影响', mitigation: '需要调整', node_id: 'draft' }] : [],
    }
  })
  const workflowGenerator = vi.fn(async () => ({
    name: '整理报告', nodes: [{ node_id: 'start', type: 'trigger' }, { node_id: 'draft', type: 'agent', title: '整理报告' }],
    edges: [{ from: 'start', to: 'draft' }],
  }))
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
  const controllerPackage = join(directory, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller')
  await mkdir(controllerPackage, { recursive: true })
  await writeFile(join(controllerPackage, 'package.json'), JSON.stringify({ version: options.version ?? '0.2.2-rc.5' }))
  ctx.provide('profileContext', { name: options.profile ?? 'desktop', dir: directory, installAnchor: join(directory, 'package.json') })
  ctx.provide('webServer', { host: options.host ?? '127.0.0.1' })
  ctx.provide('llm', {})
  ctx.provide('tools', {
    register(definition: Definition, options: Activation) { tool = definition; activation = options },
    guard(check: Guard) { guard = check },
  })
  ctx.provide('systemPrompt', { section(section: { text: typeof prompt }) { prompt = section.text } })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('approval', { request: approval })
  ctx.provide('connection', { fetch: { register({ path }: { path: string }) { routes.push(path) } } })
  ctx.provide('credentials', { modifyRecord: async () => ({ kind: 'grant', payload: 'a'.repeat(64) }) })
  ctx.provide('workspaceRegistry', {
    get: (id: string) => conversations.has(id) ? { id, path: directory, sessionIds: conversations.get(id)! } : undefined,
    list: () => [...conversations].map(([id, sessionIds]) => ({ id, path: directory, sessionIds })),
    archivedSessionIds: [],
  })
  ctx.provide('sessionController', {
    resolveAgent: async (id: string) => ({ agent: agents.get(id) }),
    modelCatalog: async () => ({ default: { provider: 'fixture', model: 'model' }, groups: [{ id: 'fixture', models: [{ id: 'model' }] }] }),
  })
  const openService = async (sessionId: string, dbFile: string) => {
    const service = await serveOrchestra({
      dbFile, secret, phase: 'S6', asOfSeq: () => 0, listEvents: () => [], listTasks: () => [],
      appendLedgerEvent: () => { throw new Error('Unexpected raw ledger write') },
      planning: { propose: planner, workflowGenerator },
      ...(options.dispatchPlans && { executor: {
        registry,
        runner: new ReadOnlyToolRunner(registry, {
          readonlyAvailable: () => true, run: async () => { throw new Error('Unexpected tool call') },
        }, directory),
        bridge: new BridgeClient({
          async request(method, params) {
            if (method === 'executor.spawn') spawn(params)
            throw new OrchError('FORBIDDEN', 'Fixture does not start real DSH executors')
          },
          async *listen() {},
        }),
      } }),
    })
    services.set(sessionId, service)
    return service
  }
  const serve = vi.fn<typeof serveDshOrchestra>(async ({ dbFile, dsh }) => openService(dsh.parentForNode('fixture')!.session.id, dbFile))
  const plugin = ctx.plugin((host) => {
    if (!options.routing) {
      installConfiguredLocalDshHost(host, localDshHostConfig.parse({
        local: { enabled: options.enabled ?? 'desktop', dataDirectory: directory },
      }).local, serve)
      return
    }
    const stop = new AbortController()
    host.effect(() => async () => {
      stop.abort()
      await Promise.all([...services.values()].map((service) => service.close()))
    }, 'test routing services')
    host.inject(['agents', 'sessions', 'tools', 'systemPrompt'], (ready) => {
      installNativeChat(ready, {
        operator: 'local-dsh:fixture', signal: stop.signal,
        bindingFor(agent) {
          const sessionId = agent.session.id
          if (agents.get(sessionId) !== agent || agent.session.header.origin === 'subagent') return
          const workspaceId = [...conversations].find(([, ids]) => ids.includes(sessionId))?.[0]
          if (workspaceId) return { identity: workspaceId + '/' + sessionId, workspaceId, sessionId }
        },
        hasService: ({ sessionId }) => services.has(sessionId),
        async serviceFor({ sessionId }) { return services.get(sessionId) ?? openService(sessionId, join(directory, sessionId + '.sqlite')) },
        autoRouteEnabled: () => options.routing!.enabled,
      })
    })
  })
  await plugin.await()
  if ((options.profile ?? 'desktop') === 'desktop' && options.version === undefined && options.enabled !== false) {
    await expect.poll(() => Boolean(tool)).toBe(true)
  }

  function session(workspace: string, sessionId: string, header: Record<string, unknown> = {}) {
    const events: Array<{ type: string; data: unknown }> = []
    const nextTurn: Message[] = []
    const signal = new AbortController()
    let turn = 0
    const agent = {
      id: sessionId, status: 'running', model: { current: () => ({ provider: 'fixture', model: 'model' }) },
      inbox: { nextTurn },
      session: { id: sessionId, header: { cwd: directory, ...header }, snapshotEvents: () => [...events] },
      followup(message: Message) {
        const recorded = structuredClone(message)
        nextTurn.push(recorded)
        events.push({ type: 'agent/inbox/spliced', data: { inserted: [recorded] } })
        notices.push({ sessionId, message: recorded })
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message: recorded })
      },
    } as unknown as Agent
    agents.set(sessionId, agent)
    conversations.set(workspace, [...conversations.get(workspace) ?? [], sessionId])
    async function admitMany(messages: Message[], newInbox = true, advance = true) {
      const dispatch = agentEvents(ctx, agent)
      for (const message of messages) {
        if (newInbox) dispatch.emit('agent/inbox/inserted', { message })
        else {
          const queued = nextTurn.findIndex(({ id }) => id === message.id)
          if (queued !== -1) nextTurn.splice(queued, 1)
        }
      }
      if (advance) turn++
      const claimed = structuredClone(messages)
      const decision = await dispatch.waterfall('agent/pre-step', { messages: claimed, turn, step: advance ? 0 : 1,
        signal: signal.signal, modelSelection: { provider: 'fixture', model: 'model' } },
      async () => ({ kind: 'enter', messages: claimed }))
      if (decision.kind === 'enter') for (const entry of decision.messages) events.push({ type: 'user/message', data: entry })
      return decision
    }
    const admit = (message: Message, newInbox = true, advance = true) => admitMany([message], newInbox, advance)
    async function invoke(input: object = { action: 'start' }) {
      const execution = { agent, callId: 'call', signal: signal.signal } as Parameters<Definition['execute']>[1]
      return await tool!.execute(input, execution) as { text: string; summary: string; preview: string }
    }
    async function call(input: object = { action: 'start' }) {
      return JSON.parse((await invoke(input)).text)
    }
    async function render(input: object = { action: 'start' }) {
      return tool!.output.render(input, await invoke(input))
    }
    const checkTool = (name: string, parent?: symbol) => guard?.({ agent, name, signal: signal.signal, parent } as Parameters<Guard>[0])
    return { agent, admit, admitMany, invoke, call, render, signal, checkTool, nextTurn }
  }
  return { session, serve, services, planner, workflowGenerator, routes, approval, notices, spawn,
    registered: () => ({ activation: activation!, prompt: prompt!, tool: tool! }),
    deny: (value: boolean) => { deny = value }, badPlan: (value: boolean) => { badPlan = value },
    plannerUnavailable: (value: boolean) => { plannerUnavailable = value },
    async close() { await plugin.dispose(); await rm(directory, { recursive: true, force: true }) }, secret,
  }
}

function user(text: string, options: { id?: string; source?: object } = {}): Message {
  return { id: options.id ?? uuidv7(), role: 'user', source: options.source ?? { kind: 'user', rpcId: uuidv7() },
    content: [{ type: 'text', text }] } as unknown as Message
}

function count(service: Service, table: 'tasks' | 'workflows' | 'task_plans' | 'runs' | 'chat_task_receipts') {
  return service.orchestra.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
}

it('applies a captured budget to native chat, including the aggregate deadline, without orphaning work', async () => {
  const test = await fixture()
  const originalPlan = test.planner.getMockImplementation()!
  const originalWorkflow = test.workflowGenerator.getMockImplementation()!
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理第一份办公室事项报告'))
    expect(await human.call()).toMatchObject({ state: 'started' })
    const service = test.services.get('parent')!
    const settings = service.planningSettings!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    let entered!: () => void
    let started = new Promise<void>((resolve) => { entered = resolve })
    test.planner.mockImplementationOnce(async () => {
      entered()
      return new Promise<never>(() => {})
    })
    const oldRequest = human.admit(user('整理第二份办公室事项报告'))
    await started
    settings.save({ operation_id: uuidv7(), expected_revision: 0, values: {
      ...planningTimeoutDefaults, task_seconds: 160, stage_seconds: 180, request_seconds: 200,
    } }, 'settings-owner', new Date().toISOString())
    await vi.advanceTimersByTimeAsync(30_000)
    await oldRequest
    expect(await human.call()).toMatchObject({ state: 'error', code: 'OPERATION_TIMEOUT' })

    started = new Promise<void>((resolve) => { entered = resolve })
    test.planner.mockImplementationOnce(async (input) => {
      entered()
      await delay(135_000)
      return originalPlan(input)
    })
    const extendedRequest = human.admit(user('整理第三份办公室事项报告'))
    await started
    await vi.advanceTimersByTimeAsync(135_000)
    await extendedRequest
    expect(await human.call()).toMatchObject({ state: 'started' })

    settings.save({ operation_id: uuidv7(), expected_revision: 1, values: {
      ...planningTimeoutDefaults, task_seconds: 75, stage_seconds: 80, request_seconds: 100,
    } }, 'settings-owner', new Date().toISOString())
    started = new Promise<void>((resolve) => { entered = resolve })
    test.workflowGenerator.mockImplementationOnce(async () => {
      entered()
      await delay(60_000)
      return originalWorkflow()
    })
    test.planner.mockImplementationOnce(async (input) => {
      await delay(60_000)
      return originalPlan(input)
    })
    const aggregate = human.admit(user('整理第四份办公室事项报告'))
    await started
    await vi.advanceTimersByTimeAsync(100_000)
    await aggregate
    expect(await human.call()).toMatchObject({ state: 'error', code: 'OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(21_000)
    for (const table of ['tasks', 'workflows', 'task_plans', 'runs', 'chat_task_receipts'] as const) {
      expect(count(service, table)).toBe(2)
    }
  } finally {
    vi.useRealTimers()
    await test.close()
  }
})

it('cancels native admission during planning without creating records or launching work', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const planned = Promise.withResolvers<void>()
    test.planner.mockImplementationOnce(async () => {
      planned.resolve()
      return new Promise<never>(() => {})
    })
    const admission = human.admit(user('整理一份待取消的办公报告'))
    await planned.promise
    human.signal.abort(new DOMException('operator cancelled', 'AbortError'))
    await expect(admission).rejects.toMatchObject({ name: 'AbortError' })
    const service = test.services.get('parent')!
    for (const table of ['tasks', 'workflows', 'task_plans', 'runs', 'chat_task_receipts'] as const) {
      expect(count(service, table)).toBe(0)
    }
  } finally { await test.close() }
})

it('binds ordinary native conversation, live owner input and one durable run per message', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const child = test.session('work', 'child', { origin: 'subagent', parentSession: 'parent' })
    const other = test.session('other', 'other')
    expect(test.routes).toHaveLength(1)
    expect(test.registered().prompt({ agent: human.agent })).toContain('The host admits explicit tasks')
    expect(test.registered().prompt({ agent: child.agent })).toBe('')
    const eligible = (agent: Agent) => test.registered().activation.when!({ agent, modelSelection: { provider: 'fixture', model: 'model' },
      signal: new AbortController().signal })
    expect(eligible(human.agent)).toBe(true)
    expect(eligible(child.agent)).toBe(false)
    // C01：普通问答不再被整轮自动接管锁住工具，读取与检索交给宿主自己的工具授权。
    await human.admit(user('你好'))
    expect(human.checkTool('read')).toBeUndefined()
    expect(human.checkTool('ask_user_question')).toBeUndefined()
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    await human.admit(user('什么是并发调度？'))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    for (const consultation of [
      '并行生成几份报告，这个思路可行吗？',
      '分别统计收入和退款再汇总成表格，这样做对吗？',
      '只写报告的话，要采用什么结构？',
      '分别核对收入和退款，再写总结，是指哪两个步骤？',
      '只生成报告是默认行为吗？',
      '只生成一张表格，你能做到吗？我只是想了解能力。',
      '分别统计并生成报告：我们只是讨论，不实际做。',
    ]) {
      const message = user(consultation)
      expect(await human.admit(message)).toMatchObject({ kind: 'enter', messages: [message] })
    }
    expect(test.serve).not.toHaveBeenCalled()
    expect(test.planner).not.toHaveBeenCalled()
    const assigned = user('整理一份办公室事项并交付 Markdown 报告')
    await human.admit(assigned, false)
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('把事项整理成报告', { source: { kind: 'user', rpcId: uuidv7(), principal: { kind: 'guest' } } }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('把事项整理成报告', { source: { kind: 'retry', rpcId: uuidv7() } }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await child.admit(assigned)
    await expect(child.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('把事项整理成报告', { source: { kind: 'chess-context' } }))
    expect(human.checkTool('read')).toBeUndefined()
    const ambiguous = await human.admit(user('请帮我处理一下'))
    expect(ambiguous).toMatchObject({ kind: 'enter', messages: [expect.anything(), expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringContaining('请说明希望拿到什么结果') })],
    })] })
    expect(test.serve).not.toHaveBeenCalled()
    const admitted = await human.admit(assigned)
    expect(admitted).toMatchObject({ kind: 'enter', messages: [assigned, expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringContaining('Orchestra 已接单') })],
    })] })
    expect(count(test.services.get('parent')!, 'runs')).toBe(1)
    expect(human.checkTool('read')).toMatch(/Orchestra 接管/u)
    expect(human.checkTool('shell', Symbol('parent tool'))).toMatch(/Orchestra 接管/u)
    expect(human.checkTool('orchestra_task')).toBeUndefined()
    await expect(human.call({ action: 'start', goal: '替换原文', session_id: 'other' }))
      .resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID' })
    const [first, concurrent] = await Promise.all([human.call(), human.call()])
    expect(first).toMatchObject({ state: 'started', replayed: false })
    expect(concurrent).toEqual(first)
    expect(test.planner.mock.calls[0]?.[0].goal).toBe('整理一份办公室事项并交付 Markdown 报告')
    expect(test.approval).not.toHaveBeenCalled()
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: false })
    await human.admit(assigned)
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: true })
    await human.admit(user('整理一份办公室事项并交付 Markdown 报告', { source: assigned.source }))
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: true })
    await human.admit(user('整理另一份办公室报告', { id: assigned.id }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'OPERATION_ID_CONFLICT' })
    await other.admit(user('查这个任务进度'))
    await expect(other.call({ action: 'status', run_id: first.run_id })).resolves.toMatchObject({ state: 'error', code: 'NOT_FOUND' })
    const service = test.services.get('parent')!
    expect(count(service, 'runs')).toBe(1)
    expect(count(service, 'task_plans')).toBe(1)
    expect(count(service, 'chat_task_receipts')).toBe(1)
  } finally { await test.close() }
})

it('names the real reason for an unusable dispatch instead of a character-count error', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const withImage = {
      id: uuidv7(), role: 'user', source: { kind: 'user', rpcId: uuidv7() },
      content: [{ type: 'text', text: '/orchestra 核对这张图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    } as unknown as Message
    const attached = await human.admit(withImage)
    expect(attached).toMatchObject({ kind: 'enter' })
    const attachedText = JSON.stringify(attached)
    expect(attachedText).toContain('附件没有被读入本次任务')
    expect(attachedText).not.toContain('1 至 2000 个字符')
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID', reason: 'attachments_unsupported' })

    const onlyImage = {
      id: uuidv7(), role: 'user', source: { kind: 'user', rpcId: uuidv7() },
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    } as unknown as Message
    await human.admit(onlyImage)
    await expect(human.call()).resolves.toMatchObject({ state: 'error', reason: 'only_attachments' })

    await human.admit(user('/orchestra ' + '目'.repeat(2001)))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', reason: 'goal_too_long' })

    await human.admit(user('/orchestra 整理这份办公室事项并交付 markdown 报告'))
    await expect(human.call()).resolves.toMatchObject({ state: 'started' })
  } finally { await test.close() }
})

it('consumes each dispatch in one native batch as its own turn and run', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const firstGoal = '整理第一份办公室事项并交付 first.md'
    const secondGoal = '整理第二份办公室事项并交付 second.md'
    const first = user('/orchestra ' + firstGoal)
    const second = user('/orchestra ' + secondGoal)
    const admitted = await human.admitMany([first, second])
    expect(admitted).toMatchObject({ kind: 'enter' })
    if (admitted.kind !== 'enter') throw new Error('unreachable')
    const texts = admitted.messages.flatMap((message) => message.content.flatMap((block) => block.type === 'text' ? [block.text] : []))
    // 每条消息各得一条回执：第一条接单，第二条排队；两条目标不合并。
    expect(texts.filter((text) => text.includes('Orchestra 已接单'))).toHaveLength(1)
    expect(texts.filter((text) => text.includes('排到当前会话的下一轮单独处理'))).toHaveLength(1)
    const startedRun = await human.call()
    expect(startedRun).toMatchObject({ state: 'started' })

    // 下一轮只带着第二条消息的来源与幂等键回来。
    const deferred = human.nextTurn.filter((message) => message.id === second.id)
    expect(deferred).toHaveLength(1)
    const secondTurn = await human.admitMany([deferred[0]!], false)
    expect(secondTurn).toMatchObject({ kind: 'enter' })
    if (secondTurn.kind !== 'enter') throw new Error('unreachable')
    const secondText = secondTurn.messages.flatMap((message) => message.content.flatMap((block) => block.type === 'text' ? [block.text] : []))
      .join('\n')
    expect(secondText).toContain('Orchestra 已接单')
    const nextRun = await human.call()
    expect(nextRun).toMatchObject({ state: 'started' })
    expect(nextRun.run_id).not.toBe(startedRun.run_id)
    expect(test.planner.mock.calls.map((call) => call[0].goal)).toEqual([firstGoal, secondGoal])
  } finally { await test.close() }
})

it('admits the complete named income concentration task through the native owner hook', async () => {
  const goal = `请完成一项名为「收入集中度复核」的任务，使用当前工作区已授权的 office-sample.csv。

请并行做两项核对：
1. 「收入排名」只统计类别为“收入”的记录，按金额从高到低列出明细，写入 income-ranking.md。
2. 「收入总额」独立从原始 CSV 统计收入笔数和收入合计，写入 income-total.md。

两份都完成后，由「集中度复核」读取这两份新报告，核对笔数与合计，计算最大单笔收入占总收入的比例，写入 income-concentration.md。金额和百分比均保留两位小数。

本次只交付上述三份新报告。已有的 summary.md 和 collection-review.md 原样保留。正常进度留在面板，只有确实需要我处理或任务结束时才通知我。`
  const deliverables = ['income-ranking.md', 'income-total.md', 'income-concentration.md']
  const test = await fixture({ reportRequirements: deliverables })
  try {
    const human = test.session('work', 'parent')
    const assigned = user(goal)
    const admitted = await human.admit(assigned)
    expect(admitted).toMatchObject({ kind: 'enter', messages: [assigned, expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringContaining('Orchestra 已接单') })],
    })] })
    await expect(human.call()).resolves.toMatchObject({ state: 'started', run_id: expect.any(String), deliverables })
    expect(test.planner).toHaveBeenCalledOnce()
    expect(test.planner.mock.calls[0]?.[0].goal).toBe(goal)
    const service = test.services.get('parent')!
    expect(count(service, 'runs')).toBe(1)
    expect(count(service, 'chat_task_receipts')).toBe(1)
  } finally { await test.close() }
})

it.each([
  ['读当前工作区的办公流水表，汇总收入和退款并输出 Markdown 报告。', 'task'],
  ['把我提供的会议记录整理成纪要和待办清单，按负责人分组。', 'task'],
  ['为下周园区开放日撰写一段面向家长的活动介绍。', 'task'],
  ['供应商有三家，预算上限是十万元。我现在要你按价格与交期对比它们并制作一份优先级清单。', 'task'],
  ['以下是本次背景。\n请帮我整理一份给项目组的三点沟通摘要。', 'task'],
  ['请核对我上传的成本表，只读不修改原表。', 'task'],
  ['执行任务「月末归档」：把我提供的会议记录整理成纪要。', 'task'],
  ['请开展一项名叫季度复盘的工作。\n一、生成一份季度摘要。', 'task'],
  ['帮我做个叫「台账复核」的任务，使用已授权的 costs.xlsx 生成汇总表。', 'task'],
  ['请完成名为「三项独立流水核对」的任务。使用当前工作区已授权的 office-sample.csv。请并行独立核对收入、退款和记录数，各自交付报告。', 'task'],
  ['请并行分别核对已授权的流水表和发票，交付两份报告。', 'task'],
  ['能帮我并行独立核对两份已授权的流水并各出一份报告吗？', 'task'],
  ['能帮我分别统计已授权的收入和退款并汇总为表格吗？', 'task'],
  ['并行生成两份报告可行吗？', 'conversation'],
  ['并行生成两份报告需要多久？', 'conversation'],
  ['分别汇总成两份表格会消耗多少额度？', 'conversation'],
  ['核对 office-sample.csv 要什么权限？', 'conversation'],
  ['读取 office-sample.csv，交付收入摘要。顺便看看结果是否有异常？', 'task'],
  ['分别统计已授权的收入和退款再汇总成表格应该怎么做？', 'conversation'],
  ['分别统计收入和退款再汇总成表格，可以讲讲实现思路吗？', 'conversation'],
  ['请并行生成两份报告，分别说明两种方案是否可行。', 'task'],
  ['请并行独立核对两份已授权的流水，各写一份报告回答“金额相符吗？”', 'task'],
  ['请完成名为「流水核对」的任务。请并行独立核对已授权的流水与发票，但先不要执行。', 'conversation'],
  ['请完成一项名为「生成审计报告」的任务。', 'clarify'],
  ['请完成一项名为「成本核对」的任务，使用当前工作区已授权的 costs.xlsx。', 'clarify'],
  ['请完成一项名为「成本核对」的任务。先讨论如何生成汇总表。', 'conversation'],
  ['执行任务「成本核对」：核对 costs.xlsx 应该怎么做？', 'conversation'],
  ['请执行任务「成本核对」。请查看当前任务的进度。', 'conversation'],
  ['请完成一项名为「成本核对」的任务。客户说：请生成报价表。', 'conversation'],
  ['请完成一项名为「成本核对」的任务；客户说：\n请生成报价表。', 'conversation'],
  ['示例：请完成一项名为「成本核对」的任务。\n请生成报价表。', 'conversation'],
  ['请完成一项名为「成本核对」的任务。现在不要执行，稍后再说。\n请生成报价表。', 'conversation'],
  ['请执行任务「成本核对」。等我确认后再核对 costs.xlsx 并生成报告。', 'conversation'],
  ['请教我怎么写报告', 'conversation'],
  ['帮我解释一下如何生成汇总表', 'conversation'],
  ['先说方案，等我确认再开始', 'conversation'],
  ['你可以整理 CSV 和生成报告吗？', 'conversation'],
  ['怎么读取当前工作区的 CSV？', 'conversation'],
  ['先别读取或整理表格，稍后再说。', 'conversation'],
  ['请不要生成这份报告。', 'conversation'],
  ['请不要生成汇总表，只说明表的结构。', 'conversation'],
  ['请解释一下报告里“生成汇总表”的含义。', 'conversation'],
  ['请告诉我这份报告写了什么。', 'conversation'],
  ['Please explain how to write a report for our board.', 'conversation'],
  ['Can you explain what tools I can use to read the report?', 'conversation'],
  ['仅做可行性分析，介绍目前方案的风险。', 'conversation'],
  ['请查看上一个任务的运行结果。', 'conversation'],
  ['例子：请生成报价汇总表。', 'conversation'],
  ['下面是客户在会上转述的原话。\n请根据授权样本生成一份 Markdown 报告。', 'conversation'],
  ['老师说：\n请生成一份报告。', 'conversation'],
  ['请看以下示例：\n请生成报告。', 'conversation'],
  ['给我一些起草会议纪要的建议。', 'conversation'],
  ['请在不读取附件的情况下给我解释报告的写作方法。', 'conversation'],
  ['帮我理解怎么写项目计划。', 'conversation'],
  ['请评估一下能否读取 costs.xlsx 中的数据并生成报表。', 'conversation'],
  ['请提供一些起草月报的建议，先讲结构，再讲细节。', 'conversation'],
  ['Would you recommend trying to create a weekly report?', 'conversation'],
  ['这是一个测试案例。请生成季度报告。', 'conversation'],
  ['修一下这个 bug，改好后跑测试', 'task'],
  ['帮我把错别字都改掉并保存', 'task'],
  ['经理说：现在请你生成报价表。', 'conversation'],
  ['同事的原话是“以下不用复核”。\n我现在需要你核对报价并交付风险清单。', 'task'],
  ['客户说：请生成报告。\n我的实际要求是编一份项目进度简报。', 'task'],
  ['请帮我处理一下。', 'clarify'],
] as const)('classifies authenticated wording %s as %s', (text, intent) => {
  expect(classifyChatTask(text)).toBe(intent)
})

it.each(['approval', 'wait', 'no files'] as const)('enforces named approval and delivery constraints in chat planning (%s)', async (scenario) => {
  const test = await fixture({ routing: { enabled: true }, dispatchPlans: true })
  const gateType = scenario === 'wait' ? 'wait' : 'approval'
  const approvalName = '批准合成数据核对'
  const draft = {
    name: '合成数据演练',
    nodes: [
      { node_id: 'start', type: 'trigger' },
      { node_id: 'gate', type: gateType, title: approvalName, config: gateType === 'approval'
        ? { prompt: approvalName, on_timeout: 'fail' }
        : { wait_kind: 'event', match: { type: 'simulated_approval' }, max_wait_ms: 60_000 } },
      { node_id: 'draft', type: 'agent' },
    ],
    edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'draft' }],
  }
  test.workflowGenerator.mockResolvedValue(draft)
  const originalPlan = test.planner.getMockImplementation()!
  test.planner.mockImplementation(async (input) => {
    const plan = await originalPlan(input)
    const draftStep = plan.steps[0]!
    return { ...plan, title: 'F8 演练', steps: [
      { ...draftStep, node_id: 'gate', description: approvalName },
      { ...draftStep, depends_on: ['gate'] },
    ], risks: gateType === 'wait' ? [{ severity: 'low', description: '事件可能延迟', mitigation: '等待到期', node_id: 'gate' }] : [] }
  })
  try {
    const human = test.session('work', 'parent')
    const delivery = scenario === 'no files' ? '在会话中给出结果。不要读写文件。' : '交付 report.md。'
    await human.admit(user('新建一次性测试任务「F8 演练」。为本次测试单独生成流程，设置人工审批步骤「批准合成数据核对」。在我批准前，计算步骤必须等待。批准后，使用模拟数据计算净额并' + delivery))
    const receipt = await human.call()
    const service = test.services.get('parent')!
    if (scenario !== 'approval') {
      expect(receipt).toMatchObject({ state: 'quality_blocked', issues: [expect.stringContaining(scenario === 'wait' ? approvalName : '不写文件')] })
      expect(count(service, 'runs')).toBe(0)
      expect(test.approval).not.toHaveBeenCalled()
      return
    }
    expect(receipt).toMatchObject({ state: 'started', title: 'F8 演练' })
    expect(test.approval.mock.calls[0]?.[0].reason.split('\n')).toEqual([
      'Orchestra 审批', '任务　F8 演练', '步骤　启动前确认（整项任务）',
      '审批原因　计划包含人工审批步骤，启动前需要你确认这份计划。',
      '审批内容　批准启动这份计划，共 2 个步骤。',
      '确认后　按计划启动，流程里的人工审批仍须单独处理。',
      expect.stringContaining('计划步骤　批准合成数据核对'),
    ])
    const steps = () => service.orchestra.db.raw.prepare('SELECT node_id, status FROM node_runs WHERE run_id=? ORDER BY seq').all(receipt.run_id)
    await expect.poll(steps, { timeout: 5_000 }).toEqual([{ node_id: 'gate', status: 'blocked_pre' }, { node_id: 'draft', status: 'queued' }])
    expect(test.spawn).not.toHaveBeenCalled()
    const headers = { 'x-orchestra-secret': test.secret }
    const list = await fetch(service.endpoint + '/v1/decisions?inbox=human', { headers }).then((response) => response.json())
    expect(list.data.items).toEqual([expect.objectContaining({ kind: 'pre_execution', status: 'pending', target_summary: approvalName })])
    const notification = () => test.notices.find(({ message }) => message.content.some((part) => part.type === 'text' && part.text.includes(approvalName)))
    await expect.poll(notification, { timeout: 5_000 }).toMatchObject({ sessionId: 'parent' })
    await human.admit(notification()!.message, false)
    await expect(human.call({ action: 'review', decision_title: approvalName })).resolves.toMatchObject({ state: 'approved' })
    expect(test.approval.mock.calls[1]?.[0].reason.split('\n')).toEqual([
      'Orchestra 审批', '任务　F8 演练', '步骤　批准合成数据核对',
      '审批原因　流程要求你在相关步骤开始前作出人工审批。',
      '审批内容　批准「批准合成数据核对」',
      '确认后　此审批步骤通过，依赖它的步骤可继续执行。',
    ])
    await expect.poll(() => test.spawn.mock.calls.length, { timeout: 5_000 }).toBe(1)
    expect(steps()[0]).toEqual({ node_id: 'gate', status: 'done' })
  } finally { await test.close() }
}, 15_000)

it('queues fresh owner steering from a managed turn and never returns its older run as the new receipt', async () => {
  const test = await fixture({ routing: { enabled: false } })
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('/orchestra 归纳会议事项，交付清单'))
    const original = await human.call()
    const nextTask = user('/orchestra 整理另外一份会议纪要')
    const nextQuestion = user('请说明这份文档的结构')
    for (const message of [nextTask, nextQuestion]) {
      const steering = await human.admit(message, true, false)
      expect(steering).toMatchObject({ kind: 'enter', messages: [expect.objectContaining({
        content: [expect.objectContaining({ text: expect.stringContaining('Orchestra 已排队新消息') })],
      })] })
      expect(await human.call()).toMatchObject({ state: 'queued' })
      expect(await human.call()).not.toHaveProperty('run_id')
    }
    expect(human.nextTurn).toEqual([nextTask, nextQuestion])
    const service = test.services.get('parent')!
    expect(count(service, 'runs')).toBe(1)
    await human.admit(nextTask, false)
    const next = await human.call()
    expect(next).toMatchObject({ state: 'started', replayed: false })
    expect(next.run_id).not.toBe(original.run_id)
    await expect(human.admit(nextQuestion, false)).resolves.toEqual({ kind: 'enter', messages: [nextQuestion] })
    expect(human.checkTool('read')).toBeUndefined()
    expect(count(service, 'runs')).toBe(2)
  } finally { await test.close() }
})

it('takes a new preference snapshot for an owner steer in an ordinary open turn', async () => {
  const routing = { enabled: true }
  const test = await fixture({ routing })
  try {
    const human = test.session('work', 'parent')
    const explanation = user('请解释这个项目的背景')
    await expect(human.admit(explanation)).resolves.toEqual({ kind: 'enter', messages: [explanation] })
    // 普通问答与讨论沿用宿主的工具授权（C01）；下面用同一回合的新偏好快照证明任务仍交给 Orchestra。
    expect(human.checkTool('write')).toBeUndefined()
    routing.enabled = false
    const freshSteer = user('整理一份可交付的项目报告')
    await expect(human.admit(freshSteer, true, false)).resolves.toEqual({ kind: 'enter', messages: [freshSteer] })
    expect(human.checkTool('write')).toBeUndefined()
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    expect(test.services.size).toBe(0)
  } finally { await test.close() }
})

it('offers manual dispatch when the automatic routing setting cannot be read', async () => {
  const readRouting = vi.fn((): boolean => { throw new Error('settings unavailable') })
  const test = await fixture({ routing: { get enabled() { return readRouting() } } })
  try {
    const human = test.session('work', 'parent')
    const goal = '按负责人整理项目待办清单'
    const assigned = user(goal)
    await expect(human.admit(assigned)).resolves.toMatchObject({ kind: 'enter', messages: [assigned, {
      source: { kind: 'plugin:dsh-orchestra', form: 'notice', summary: 'Orchestra 无法读取自动接管设置' },
      content: [{ type: 'text', text: expect.stringContaining('/orchestra 任务内容') }],
    }] })
    expect(test.services.size).toBe(0)
    await human.admit(user(`/orchestra ${goal}`))
    await expect(human.call()).resolves.toMatchObject({ state: 'started' })
    expect(readRouting).toHaveBeenCalledOnce()
    expect(test.registered().prompt({ agent: human.agent })).toContain('relay its manual /orchestra option')
  } finally { await test.close() }
})

it('keeps off-mode DSH and historical approvals, admits only the owner slash, and pins an in-flight turn', async () => {
  const routing = { enabled: false }
  const test = await fixture({ routing })
  try {
    const human = test.session('work', 'parent')
    const child = test.session('work', 'child', { origin: 'subagent', parentSession: 'parent' })
    const goal = '按负责人整理项目待办清单'
    const ordinary = user(goal)
    await expect(human.admit(ordinary)).resolves.toEqual({ kind: 'enter', messages: [ordinary] })
    expect(human.checkTool('read')).toBeUndefined()
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    expect(test.services.size).toBe(0)

    const rpcId = uuidv7()
    const source = { kind: 'plugin:dsh-orchestra', form: 'notice', summary: 'Orchestra 单次任务' }
    await human.admit(user('/orchestra ' + goal, { source }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('/orchestra ' + goal, { source: { kind: 'chess-context' } }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await child.admit(user('/orchestra ' + goal))
    await expect(child.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    const bare = await human.admit(user('/orchestra   '))
    expect(bare).toMatchObject({ kind: 'enter', messages: [expect.anything(), expect.objectContaining({
      source: { kind: 'plugin:dsh-orchestra', form: 'notice', summary: expect.any(String) },
      content: [expect.objectContaining({ text: expect.stringContaining('Orchestra 用法 · /orchestra 任务内容') })],
    })] })
    expect(test.services.size).toBe(0)
    await human.admit(user('/orchestra ' + goal, { source: { kind: 'user', rpcId } }))
    const explicit = await human.call()
    expect(explicit).toMatchObject({ state: 'started', replayed: false })
    expect(human.checkTool('write')).toMatch(/Orchestra 接管/u)
    const service = test.services.get('parent')!
    await human.admit(user('/orchestra ' + goal, { source: { kind: 'user', rpcId } }))
    await expect(human.call()).resolves.toMatchObject({ run_id: explicit.run_id, replayed: true })
    expect(count(service, 'runs')).toBe(1)

    routing.enabled = true
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const plan = test.planner.getMockImplementation()!
    test.planner.mockImplementationOnce(async (input) => {
      entered.resolve()
      await proceed.promise
      return plan(input)
    })
    const pending = human.admit(user('编制下周会议计划'))
    await entered.promise
    routing.enabled = false
    proceed.resolve()
    await pending
    await expect(human.call()).resolves.toMatchObject({ state: 'started' })
    expect(human.checkTool('write')).toMatch(/Orchestra 接管/u)
    await human.admit(user('整理另外一份会议纪要'))
    expect(human.checkTool('write')).toBeUndefined()
    expect(count(service, 'runs')).toBe(2)
    await expect(human.call({ action: 'status', run_id: explicit.run_id })).resolves.toMatchObject({ run_id: explicit.run_id })
    const { db } = service.orchestra
    const decision = decisionId()
    withTx(db, (tx) => openDecision(tx, {
      decisionId: decision, runId: explicit.run_id, nodeRunId: null, kind: 'pre_execution', approver: 'human',
      confirmRequired: true, payload: { target_summary: '关闭自动接管后的待审事项' },
    }))
    const noticeWithDecision = () => test.notices.find((entry) => entry.message.content
      .some((part) => part.type === 'text' && part.text.includes('关闭自动接管后的待审事项')))?.message
    await expect.poll(noticeWithDecision, { timeout: 5_000 }).toBeTruthy()
    await human.admit(noticeWithDecision()!, false)
    expect(human.checkTool('write')).toMatch(/Orchestra 接管/u)
    await expect(human.call({ action: 'review', decision_title: '关闭自动接管后的待审事项' })).resolves.toMatchObject({ state: 'approved', decision_id: decision })
    expect(test.approval).toHaveBeenCalledTimes(2)
  } finally { await test.close() }
})

it('installs the default bundle entry only in a supported Desktop profile and honors explicit disablement', async () => {
  const patch = await readFile('cordis.patch.yml', 'utf8')
  expect(patch).toMatch(/insert:\s*\[\{\s*id: dsh-orchestra, name: dsh-orchestra, config: \{ local: \{ enabled: desktop \} \}/u)
  for (const options of [{ profile: 'web' }, { version: '0.2.2-rc.4' }, { enabled: false as const }]) {
    const test = await fixture(options)
    try {
      expect(test.routes).toEqual([])
      expect(test.registered().activation).toBeUndefined()
      expect(test.serve).not.toHaveBeenCalled()
    } finally { await test.close() }
  }
  const exposed = await fixture({ host: '192.168.5.1' })
  try {
    const owner = exposed.session('work', 'owner')
    expect(exposed.registered().prompt({ agent: owner.agent })).toBe('')
    await owner.admit(user('整理季度记录并交付报告'))
    await expect(owner.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    expect(exposed.serve).not.toHaveBeenCalled()
  } finally { await exposed.close() }
})

it('acknowledges once, keeps recoverable progress quiet, and reports a late blocker and the terminal result once', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const admission = await human.admit(user('整理办公记录，交付一份报告'))
    expect(admission).toMatchObject({ kind: 'enter', messages: [expect.anything(), {
      source: { kind: 'plugin:dsh-orchestra', form: 'notice', summary: expect.stringContaining('已接单') },
    }] })
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    const first = db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = 'draft'").get(runId)!.node_run_id
    const runScan = () => vi.advanceTimersByTimeAsync(2_000)
    const setNodeStatus = (status: string) => withTx(db, (tx) => {
      tx.run('UPDATE node_runs SET status = ? WHERE node_run_id = ?', [status, first])
    })

    withTx(db, (tx) => tx.run("UPDATE chat_task_receipts SET reported_key = 'progress:started'"))
    for (const stage of ['queued', 'started', 'verifying', 'waiting', 'startup_unknown', 'paused_bridge_missing', 'started']) {
      setNodeStatus(stage)
      await runScan()
      expect(test.notices).toHaveLength(0)
    }
    withTx(db, (tx) => tx.run("UPDATE runs SET status = 'paused' WHERE run_id = ?", [runId]))
    await runScan()
    expect(test.notices).toHaveLength(0)
    withTx(db, (tx) => tx.run("UPDATE runs SET status = 'running' WHERE run_id = ?", [runId]))

    const now = new Date().toISOString()
    const automatic = decisionId()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: automatic, runId, nodeRunId: String(first), kind: 'audit_result',
        approver: 'agent:fixture', payload: {}, createdAt: now })
      tx.run("UPDATE node_runs SET status = 'blocked_pre', blocked_decision_id = ? WHERE node_run_id = ?", [automatic, first])
    })
    await runScan()
    expect(test.notices).toHaveLength(0)
    await human.admit(user('这次任务当前进度如何？'))
    await expect(human.call({ action: 'status', run_id: runId })).resolves.toMatchObject({
      run_id: runId, terminal: false, status: 'running',
      blocking: [{ node_run_id: first, status: 'blocked_pre', action_required: false }],
    })
    expect(db.raw.prepare('SELECT reported_key FROM chat_task_receipts').get()).toMatchObject({ reported_key: 'progress:started' })

    const file = registerRunArtifact(db, { artifactId: uuidv7(), runId, fileName: 'interim.md', bytes: Buffer.from('interim report') })
    await human.admit(user('/orchestra 独立整理另一批记录并交付汇总报告'))
    const { run_id: otherRun } = await human.call()
    expect(otherRun).not.toBe(runId)
    const unrelated = registerRunArtifact(db, { artifactId: uuidv7(), runId: otherRun, fileName: 'other-run.md', bytes: Buffer.from('other run only') })
    withTx(db, (tx) => tx.run("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE run_id = ?", [now, otherRun]))
    reportChatRun(db, otherRun, 'terminal:cancelled')
    await runScan()
    expect(test.notices).toHaveLength(0)
    await human.admit(user('这个运行已经有哪些产物？'))
    await expect(human.call({ action: 'status', run_id: runId })).resolves.toMatchObject({
      run_id: runId, status: 'running', artifacts: [{ artifact_id: file.artifact_id, file_name: 'interim.md', bytes: 14 }],
    })
    await expect(human.call({ action: 'artifact', run_id: runId, artifact_id: file.artifact_id })).resolves.toMatchObject({
      kind: 'preview', text: 'interim report',
    })
    await expect(human.call({ action: 'artifact', run_id: runId, artifact_id: unrelated.artifact_id })).resolves.toMatchObject({
      state: 'error', code: 'NOT_FOUND',
    })

    const approval = decisionId()
    withTx(db, (tx) => openDecision(tx, {
      decisionId: approval, runId, nodeRunId: null, kind: 'pre_execution', approver: 'human',
      confirmRequired: true, payload: { target_summary: '并行分支需要审核' },
    }))
    await runScan()
    expect(test.notices).toHaveLength(1)
    const lateNode = uuidv7()
    withTx(db, (tx) => {
      for (let index = 0; index < 14; index++) {
        tx.run(`INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'agent', ?, ?, ?)`, [index === 13 ? lateNode : uuidv7(), runId, `extra-${index}`, index + 20,
          index === 13 ? 'started' : 'queued', now, now])
      }
      transitionNode(tx, test.secret, { nodeRunId: lateNode, from: 'started', to: 'blocked_post', attempt: 1, revision: 0,
        reason: 'verification_required', verifyHuman: { reason: '原始报告缺少复核证据', missing: [] }, now })
      for (let index = 0; index < 55; index++) appendNodeRunEvent(tx, test.secret, lateNode, 'tool_finished', { tool_seq: index })
    })
    await runScan()
    await runScan()
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]).toMatchObject({ sessionId: 'parent', message: {
      source: { summary: expect.stringContaining('等待人工处理') },
      content: [{ type: 'text', text: expect.stringContaining('原始报告缺少复核证据') }],
    } })
    const noticeText = test.notices[1]?.message.content[0]
    expect(noticeText).toMatchObject({ text: expect.stringContaining('interim.md') })
    expect(noticeText).not.toMatchObject({ text: expect.stringContaining('other-run.md') })
    await human.admit(user('查看任务的当前阻塞原因'))
    const status = await human.call({ action: 'status', run_id: runId })
    expect(status.nodes).toContainEqual(expect.objectContaining({ node_run_id: lateNode, status: 'blocked_post' }))
    expect(status.blocking).toContainEqual(expect.objectContaining({
      node_run_id: lateNode, reason: '原始报告缺少复核证据', action_required: true,
    }))
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status = 'done' WHERE node_run_id = ?", [lateNode]))
    await runScan()
    expect(test.notices).toHaveLength(2)

    withTx(db, (tx) => tx.run("UPDATE runs SET status = 'failed', ended_at = ? WHERE run_id = ?", [now, runId]))
    await runScan()
    await runScan()
    expect(test.notices).toHaveLength(3)
    expect(test.notices[2]?.message.source).toMatchObject({ summary: expect.stringContaining('运行失败') })
    expect(db.raw.prepare('SELECT reported_key FROM chat_task_receipts').all()).toEqual(expect.arrayContaining([
      { reported_key: 'terminal:failed' }, { reported_key: 'terminal:cancelled' },
    ]))
  } finally {
    await test.close()
    vi.useRealTimers()
  }
})

it('notifies the source conversation with a fixed delivery review and leaves the review to the operator', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const first = await human.call()
    const service = test.services.get('parent')!
    const { db } = service.orchestra
    const actor = String(db.raw.prepare('SELECT created_by FROM task_plans').get()?.created_by)
    const node = db.raw.prepare("SELECT node_run_id,revision FROM node_runs WHERE run_id=? AND node_id='draft'").get(first.run_id)!
    const nodeRunId = String(node.node_run_id)
    const now = new Date().toISOString()
    const reviewHost = createDeliveryReviewHost(db, test.secret, true)
    reviewHost.change({ operation_id: uuidv7(), action: 'hold', run_id: first.run_id, node_run_id: nodeRunId }, actor, now)
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(0)
    const artifact = registerRunArtifact(db, {
      artifactId: uuidv7(), runId: first.run_id, fileName: 'report.md', bytes: Buffer.from('需要核算的测试成果'), nodeRunId,
    })
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status='done',side_effect_policy='pure' WHERE node_run_id=?", [nodeRunId]))
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    const notice = test.notices[0]!
    expect(notice.sessionId).toBe('parent')
    const noticeText = notice.message.content.find((part) => part.type === 'text')?.text ?? ''
    expect(noticeText.split('\n').slice(1, 7).map(line => line.split('　')[0])).toEqual([
      '任务', '步骤', '待审成果', '审核原因', '审核标准', '处理方式',
    ])
    expect(noticeText).toContain('待审成果　report.md')
    expect(noticeText).not.toContain(artifact.sha256)
    await human.admit(notice.message, false)
    const action = { action: 'review_delivery' }
    const result = await human.invoke(action)
    expect(JSON.parse(result.text)).toEqual({ state: 'delivery_review', count: 1 })
    expect(JSON.stringify(await human.render(action))).not.toContain('需要核算的测试成果')
    const meta = test.registered().tool.output.presentationMeta?.(action, result)
    expect(meta).toMatchObject({ deliveryReview: {
      sessionId: 'parent', reviews: [expect.objectContaining({
        step: '整理报告', preview: '需要核算的测试成果',
        artifact: expect.objectContaining({ sha256: artifact.sha256 }),
      })],
    } })
    expect(test.approval).not.toHaveBeenCalled()
    const feedback = service.rework!.request({
      operation_id: uuidv7(), run_id: first.run_id, target_node_run_id: nodeRunId, expected_revision: Number(node.revision),
      source_artifact_id: artifact.artifact_id, source_artifact_hash: artifact.sha256,
      reason: '合计需复核', expected_result: '列出计算过程',
    }, actor, now)
    expect(feedback).toMatchObject({ target_node_run_id: nodeRunId, reason: '合计需复核' })
    await expect(human.call(action)).resolves.toMatchObject({ state: 'delivery_review', count: 0 })
    expect(feedback.status).toBe('scheduled')
    const revisedId = feedback.new_node_run_id!
    const revised = registerRunArtifact(db, {
      artifactId: uuidv7(), runId: first.run_id, fileName: 'report.bin', bytes: Buffer.from([0, 1, 2, 3]), nodeRunId: revisedId,
    })
    withTx(db, tx => tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?", [revisedId]))
    service.rework!.recover(now)
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(2)
    const nextNotice = test.notices[1]!.message
    expect(nextNotice.content.find(part => part.type === 'text')?.text).toContain('report.bin（第 1 轮修订）')
    await human.admit(nextNotice, false)
    const resultAfterRework = await human.invoke(action)
    const nextMeta = test.registered().tool.output.presentationMeta?.(action, resultAfterRework)
    expect(nextMeta).toMatchObject({ deliveryReview: { reviews: [expect.objectContaining({
      artifact: expect.objectContaining({ artifact_id: revised.artifact_id, sha256: revised.sha256 }),
      revised: expect.objectContaining({ requestId: feedback.request_id, round: 1 }),
      criteria: expect.arrayContaining(['列出计算过程']),
    })] } })
    expect(JSON.stringify(nextMeta)).not.toContain('"preview"')
    expect(test.approval).not.toHaveBeenCalled()
    const awaiting = service.rework!.list(actor, first.run_id).items[0]!
    expect(() => reviewHost.change({ action: 'accept', operation_id: uuidv7(), run_id: first.run_id, node_run_id: revisedId,
      artifact_id: revised.artifact_id, sha256: revised.sha256 }, actor, now)).toThrow(/正在返工/u)
    service.rework!.review({ operation_id: uuidv7(), request_id: awaiting.request_id, expected_revision: awaiting.revision,
      action: 'accept', note: '修订符合预期', artifact_id: revised.artifact_id, artifact_hash: revised.sha256 }, actor, now)
    expect(reviewHost.list(actor, first.run_id).items[0]).toMatchObject({ status: 'accepted', node_run_id: revisedId, artifact_id: revised.artifact_id })
    await expect(human.call(action)).resolves.toMatchObject({ state: 'delivery_review', count: 0 })
  } finally {
    await test.close()
    vi.useRealTimers()
  }
})

it('reports the blocked step and missing planned file separately from its three registered files', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture({ reportRequirements: ['collection-review.md', 'summary.md'] })
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('/orchestra 整理采集材料，生成审查报告并保留原 summary.md'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    const draft = db.raw.prepare("SELECT node_run_id, attempt, action_generation FROM node_runs WHERE run_id = ? AND node_id = 'draft'")
      .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
    const files = ['collection-review.md', 'a.txt', 'b.txt']
    const [published] = files.map((fileName) => registerRunArtifact(db, {
      artifactId: uuidv7(), runId, fileName, bytes: Buffer.from('file contents'), nodeRunId: draft.node_run_id,
    }))
    const now = new Date().toISOString()
    withTx(db, (tx) => {
      recordArtifactPublication(tx, test.secret, draft, { run_id: runId, node_id: 'draft' }, files[0]!, published!)
      tx.run("UPDATE node_runs SET status = 'started' WHERE node_run_id = ?", [draft.node_run_id])
      transitionNode(tx, test.secret, { nodeRunId: draft.node_run_id, from: 'started', to: 'blocked_post', attempt: draft.attempt, revision: 0,
        reason: 'evidence_missing', verifyHuman: { reason: 'evidence_missing', missing: [] }, now })
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    const notice = test.notices[0]!.message
    const blockedText = notice.content.find((part) => part.type === 'text')?.text
    expect(blockedText).toContain('「整理报告」执行结果待核验')
    expect(blockedText).toContain('现有记录缺少完成核验所需的执行证据')
    expect(blockedText).toContain('还缺「summary.md」的交付记录')
    expect(blockedText).toContain('如果原要求只是保留这些文件，请先核对计划')
    expect(blockedText).toMatch(/已登记文件：.*(?:a\.txt|b\.txt|collection-review\.md)/u)
    for (const file of files) expect(blockedText).toContain(file)
    expect(blockedText).toContain('交付验收尚无通过结论')
    expect(blockedText).not.toMatch(/待办|run_id|terminal|blocked_post|evidence_missing|action_required|sha256|bytes/u)
    expect(blockedText).not.toContain(runId)
    expect(blockedText).not.toContain(published!.sha256)
    await human.admit(notice, false)
    await expect(human.render({ action: 'status' })).resolves.toEqual([{ type: 'text', text: blockedText }])
    const { tool } = test.registered()
    const statusArgs = { action: 'status', run_id: runId }
    const storedContent = [{ type: 'text' as const, text: JSON.stringify({ run_id: runId, status: 'blocked_post' }) }]
    expect(tool.presentCall?.(statusArgs)).toEqual({ card: 'generic', title: '查看任务状态' })
    expect(tool.presentResult?.(statusArgs, { isError: false, content: storedContent, meta: { summary: blockedText! } }))
      .toEqual({ card: 'generic', content: [{ type: 'text', text: blockedText }] })
    expect(JSON.stringify(tool.presentResult?.(statusArgs, { isError: false, content: storedContent }))).not.toContain(runId)
    await expect(human.render({ action: 'artifact', file_name: 'collection-review.md' })).resolves.toEqual([
      { type: 'text', text: expect.stringContaining('「collection-review.md」的内容预览') }, { type: 'text', text: 'file contents' },
    ])
    await expect(human.call({ action: 'status', run_id: uuidv7() })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await expect(human.call({ action: 'status', task_title: '另一项任务' })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    const raw = await human.call({ action: 'status' })
    expect(raw.blocking).toContainEqual(expect.objectContaining({
      node_run_id: draft.node_run_id, status: 'blocked_post', reason: 'evidence_missing', outstanding_files: ['summary.md'],
    }))
    registerRunArtifact(db, { artifactId: uuidv7(), runId, fileName: 'summary.md', bytes: Buffer.from('summarized contents'), nodeRunId: draft.node_run_id })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'done' WHERE node_run_id = ?", [draft.node_run_id])
      tx.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE run_id = ?", [now, runId])
      applyRunAcceptance(tx, runId, now)
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(2)
    const finished = test.notices[1]?.message.content.find((part) => part.type === 'text')?.text
    expect(finished).toContain('本次执行已结束')
    expect(finished).toContain('交付验收已通过')
    const accepted = finished?.split('\n').find((line) => line.includes('已通过验收的文件'))
    expect(accepted).toContain('collection-review.md')
    expect(accepted).toContain('summary.md')
    expect(finished).not.toMatch(/sha256|terminal|succeeded|run_id/u)
    await human.admit(test.notices[1]!.message, false)
    const duplicate = registerRunArtifact(db, { artifactId: uuidv7(), runId, fileName: 'summary.md', bytes: Buffer.from('another version') })
    const duplicateStatus = await human.render({ action: 'status' })
    expect(duplicateStatus[0]).toMatchObject({ text: expect.stringContaining('已登记文件：') })
    const acceptedAfterDuplication = (duplicateStatus[0] as { text: string }).text.split('\n').find((line) => line.includes('已通过验收的文件'))
    expect(acceptedAfterDuplication).not.toContain('summary.md')
    await expect(human.call({ action: 'artifact', file_name: 'summary.md' })).resolves.toMatchObject({
      state: 'error', code: 'RESOLUTION_NOT_AVAILABLE',
    })
    await expect(human.call({ action: 'artifact', artifact_id: duplicate.artifact_id })).resolves.toMatchObject({ text: 'another version' })
    for (let index = 0; index < 51; index++) {
      registerRunArtifact(db, { artifactId: uuidv7(), runId, fileName: `extra-${index}.txt`, bytes: Buffer.from('extra contents') })
    }
    await expect(human.call({ action: 'artifact', file_name: 'collection-review.md' })).resolves.toMatchObject({ text: 'file contents' })
  } finally {
    await test.close()
    vi.useRealTimers()
  }
})

it('uses the exact title for an earlier task without falling back to the latest or guessing among same-name tasks', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const other = test.session('work', 'other')
    const firstGoal = '/orchestra 汇总第一批合同并交付核对清单'
    await human.admit(user(firstGoal))
    const first = await human.call()
    await human.admit(user('/orchestra 汇总第二批合同并交付核对清单'))
    const second = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    for (const [runId, text] of [[first.run_id, 'first batch'], [second.run_id, 'second batch']]) {
      registerRunArtifact(db, { artifactId: uuidv7(), runId, fileName: 'checklist.md', bytes: Buffer.from(text) })
    }
    await human.admit(user('以前第一批合同那项任务做得怎么样了？'))
    await expect(human.call({ action: 'status' })).resolves.toMatchObject({ run_id: second.run_id })
    await expect(human.call({ action: 'status', task_title: first.title })).resolves.toMatchObject({ run_id: first.run_id })
    await expect(human.call({ action: 'artifact', file_name: 'checklist.md' })).resolves.toMatchObject({ text: 'first batch' })
    await expect(human.call({ action: 'status', task_title: first.title, run_id: second.run_id })).resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID' })
    await expect(human.render({ action: 'status', task_title: '没有这项任务' })).resolves.toEqual([
      { type: 'text', text: expect.stringContaining('没有找到匹配的任务。请在 Orchestra 面板选择') },
    ])
    await expect(human.call({ action: 'artifact', file_name: 'checklist.md' })).resolves.toMatchObject({ state: 'error', code: 'NOT_FOUND' })
    await other.admit(user('查看之前的任务'))
    await expect(other.call({ action: 'status', task_title: first.title })).resolves.toMatchObject({ state: 'error', code: 'NOT_FOUND' })
    await human.admit(user(firstGoal))
    const third = await human.call()
    expect(third).toMatchObject({ state: 'started', title: first.title })
    expect(third.run_id).not.toBe(first.run_id)
    await human.admit(user('第一批合同的状态是什么？'))
    await expect(human.render({ action: 'status', task_title: first.title })).resolves.toEqual([
      { type: 'text', text: expect.stringContaining('多个同名任务。请在 Orchestra 面板选择') },
    ])
  } finally { await test.close() }
})

it('keeps coincident notices for different runs read-only without borrowing either run scope', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('/orchestra 整理第一套合同'))
    const first = await human.call()
    await human.admit(user('/orchestra 整理第二套合同'))
    const second = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    withTx(db, (tx) => tx.run("UPDATE runs SET status = 'failed', ended_at = ? WHERE run_id IN (?, ?)",
      [new Date().toISOString(), first.run_id, second.run_id]))
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(2)
    const [left, right] = test.notices.map(({ message }) => message)
    expect(left!.source).toMatchObject({ summary: expect.stringContaining(first.title) })
    expect(right!.source).toMatchObject({ summary: expect.stringContaining(second.title) })
    await human.admitMany([left!, right!], false)
    await expect(human.call({ action: 'status' })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await expect(human.call({ action: 'status', run_id: second.run_id })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    expect(human.checkTool('read')).toMatch(/Orchestra 接管/u)
  } finally {
    await test.close()
    vi.useRealTimers()
  }
})

it('keeps approval, planning failure and terminal results in the originating DSH session', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const other = test.session('work', 'other')
    test.plannerUnavailable(true)
    const failure = await human.admit(user('请整理这些记录并交付报告'))
    expect(failure).toMatchObject({ kind: 'enter', messages: [expect.anything(), {
      source: { kind: 'plugin:dsh-orchestra', form: 'notice' },
      content: [{ type: 'text', text: expect.stringContaining('服务恢复后，可重新发送原任务') }],
    }] })
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'SERVICE_UNAVAILABLE', retryable: true })
    test.plannerUnavailable(false)
    test.badPlan(true)
    await human.admit(user('请发送涉及风险的报告'))
    await expect(human.call()).resolves.toMatchObject({ state: 'quality_blocked', issues: [expect.stringContaining('高风险')] })
    const service = test.services.get('parent')!
    expect(count(service, 'runs')).toBe(0)
    expect(test.approval).not.toHaveBeenCalled()
    test.badPlan(false)
    await human.admit(user('汇总最近办公事项，并交付一份报告'))
    const prepared = await human.call()
    expect(prepared.state).toBe('started')
    const { db } = service.orchestra
    const decision = decisionId()
    withTx(db, (tx) => openDecision(tx, {
      decisionId: decision, runId: prepared.run_id, nodeRunId: null, kind: 'pre_execution', approver: 'human', confirmRequired: true,
      payload: { target_summary: '人工核对报告' }, createdAt: new Date().toISOString(),
    }))
    const findApproval = () => test.notices.find((entry) => entry.message.content.some((part) => part.type === 'text'
      && part.text.includes('人工核对报告')))
    await expect.poll(findApproval, { timeout: 5_000 }).toMatchObject({ sessionId: 'parent' })
    const notification = findApproval()!.message
    expect(notification.source).toEqual({ kind: 'plugin:dsh-orchestra', form: 'notice', summary: expect.any(String) })
    expect(JSON.stringify(notification.content)).not.toContain(decision)
    await other.admit(notification, false)
    await expect(other.call({ action: 'review', run_id: prepared.run_id, decision_id: decision }))
      .resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(notification, false)
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    test.deny(true)
    const review = { action: 'review', decision_title: '人工核对报告' }
    await expect(human.call(review)).resolves.toMatchObject({ state: 'approval_pending' })
    await expect(human.call(review)).resolves.toMatchObject({ state: 'approval_pending' })
    expect(test.approval).toHaveBeenCalledTimes(1)
    expect(db.raw.prepare('SELECT status, resolved_by FROM decisions WHERE decision_id = ?').get(decision))
      .toMatchObject({ status: 'pending', resolved_by: null })
    test.deny(false)
    await human.admit(user('请显示这次任务的审批卡'))
    await expect(human.call(review)).resolves.toMatchObject({ state: 'error', code: 'NOT_FOUND' })
    await expect(human.call({ action: 'status' })).resolves.toMatchObject({ run_id: prepared.run_id })
    const ambiguous = decisionId()
    withTx(db, (tx) => openDecision(tx, {
      decisionId: ambiguous, runId: prepared.run_id, nodeRunId: null, kind: 'audit_result', approver: 'human',
      payload: { target_summary: '人工核对报告' },
    }))
    await expect(human.call(review)).resolves.toMatchObject({ state: 'error', code: 'RESOLUTION_NOT_AVAILABLE' })
    expect(test.approval).toHaveBeenCalledTimes(1)
    await expect(human.call({ action: 'review', run_id: prepared.run_id, decision_id: decision })).resolves.toMatchObject({ state: 'approved' })
    expect(test.approval).toHaveBeenCalledTimes(3)
    expect(test.approval).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agent: human.agent, toolName: 'orchestra_task', reason: expect.stringContaining('人工核对报告'),
    }))
    expect(test.approval).toHaveBeenNthCalledWith(3, expect.objectContaining({
      agent: human.agent, toolName: 'orchestra_task', reason: expect.stringMatching(/二次确认\n[\s\S]*审批内容　批准「人工核对报告」[\s\S]*有效至　/u),
    }))
    expect(db.raw.prepare('SELECT status, resolved_by FROM decisions WHERE decision_id = ?').get(decision))
      .toMatchObject({ status: 'resolved', resolved_by: expect.stringMatching(/^local-dsh:/) })
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'failed', ended_at = ? WHERE run_id = ?", [new Date().toISOString(), prepared.run_id])
    })
    await expect.poll(() => test.notices.find((entry) => entry.message.content.some((part) => part.type === 'text'
      && part.text.includes('本次运行失败'))), { timeout: 5_000 }).toMatchObject({ sessionId: 'parent' })
    expect(test.notices.every((entry) => entry.sessionId === 'parent')).toBe(true)
    expect(count(service, 'runs')).toBe(1)
  } finally { await test.close() }
}, 16_000)

it.each([
  ['WORKFLOW_DEFINITION_INVALID', ['nodes.2.position'], 'layout', '生成流程的布局未通过校验'],
  ['WORKFLOW_DEFINITION_INVALID', ['nodes.2.position.y'], undefined, '规划模型生成的计划未通过校验'],
  ['WORKFLOW_VALIDATION_FAILED', [], undefined, '规划模型生成的计划未通过校验'],
] as const)('reports pre-launch %s (%j) without a nonexistent task or raw details', async (code, fields, issue, heading) => {
  const privateDetail = 'private provider failure with token=fixture-secret'
  const test = await fixture({ planningError: new OrchError(code, privateDetail, { fields, planning_issue: issue ?? privateDetail }) })
  try {
    const human = test.session('work', 'parent')
    const assigned = user('请整理这些记录并交付报告')
    const admission = await human.admit(assigned)
    expect(admission).toMatchObject({ kind: 'enter', messages: [assigned, {
      source: { kind: 'plugin:dsh-orchestra', form: 'notice', summary: `Orchestra ${heading}` },
      content: [{ type: 'text', text: expect.stringContaining('执行尚未开始') }],
    }] })
    const { text, summary } = await human.invoke()
    expect(JSON.parse(text)).toMatchObject({ state: 'error', code, message: expect.stringContaining('执行尚未开始') })
    const card = test.registered().tool.presentResult?.({ action: 'start' }, { isError: true, content: [] })
    expect(card).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('没有返回可显示的接单回执') }] })
    for (const output of [JSON.stringify(admission), text, summary, JSON.stringify(card)]) {
      expect(output).not.toMatch(/面板|\/orchestra|fixture-secret|nodes\.2|run_id|plan_id/u)
    }
    const service = test.services.get('parent')!
    expect(count(service, 'task_plans')).toBe(0)
    expect(count(service, 'runs')).toBe(0)
    expect(count(service, 'chat_task_receipts')).toBe(0)
  } finally { await test.close() }
})

it.each(['rejected', 'expired', 'changed'] as const)(
  'keeps a once-approved high-risk decision open when the second confirmation is %s',
  async (scenario) => {
    const test = await fixture()
    let clock: ReturnType<typeof vi.spyOn> | undefined
    const answer = Promise.withResolvers<'rejected' | 'allowed-once'>()
    try {
      const human = test.session('work', 'parent')
      await human.admit(user('把材料整理成办公会报告'))
      const started = await human.call()
      const { orchestra: { db, commands } } = test.services.get('parent')!
      const id = decisionId()
      const contentHash = 'b'.repeat(64)
      withTx(db, (tx) => openDecision(tx, {
        decisionId: id, runId: started.run_id, nodeRunId: null, kind: 'pre_execution', approver: 'human',
        confirmRequired: true, contentHash, payload: { target_summary: '运行前确认' },
      }))
      await human.admit(user('请显示执行审批'))
      test.approval.mockResolvedValueOnce('allowed-once').mockImplementationOnce(() => answer.promise)
      const reviewing = human.call({ action: 'review', run_id: started.run_id, decision_id: id })
      await expect.poll(() => test.approval.mock.calls.length).toBe(2)
      const second = test.approval.mock.calls[1]![0]
      expect(second.agent).toBe(human.agent)
      expect(second.reason.split('\n').slice(1, 5)).toEqual(test.approval.mock.calls[0]![0].reason.split('\n').slice(1, 5))
      expect(test.approval.mock.calls[0]![0].reason).toContain('确认后　还需在下一张卡片完成二次确认。')
      expect(second.reason).toContain('审批内容　批准「运行前确认」')
      expect(second.reason).not.toContain(contentHash)
      expect(second.reason).not.toContain(id)
      expect(second.reason).toMatch(/有效至　.*（UTC）$/u)
      expect(second.signal).not.toBe(test.approval.mock.calls[0]![0].signal)
      const decisionState = () => db.raw.prepare('SELECT status, revision, resolved_by FROM decisions WHERE decision_id = ?').get(id)
      expect(decisionState()).toMatchObject({ status: 'pending', revision: 1, resolved_by: null })
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'decision.resolved'").get()?.n).toBe(0)
      if (scenario === 'changed') {
        const actor = String(db.raw.prepare('SELECT created_by FROM task_plans').get()?.created_by)
        commands.acknowledgeDecision({ decisionId: id, revision: 1, operationId: uuidv7(),
          actor: { kind: 'human', id: actor }, now: new Date().toISOString() })
      }
      if (scenario === 'expired') {
        const afterExpiry = Date.now() + 121_000
        clock = vi.spyOn(Date, 'now').mockReturnValue(afterExpiry)
      }
      answer.resolve(scenario === 'rejected' ? 'rejected' : 'allowed-once')
      const expected = scenario === 'changed' ? { state: 'error', code: 'DECISION_REVISION_CONFLICT' }
        : scenario === 'expired' ? { state: 'error', code: 'CONFIRMATION_EXPIRED' } : { state: 'approval_pending' }
      await expect(reviewing).resolves.toMatchObject(expected)
      expect(decisionState()).toMatchObject({
        status: scenario === 'changed' ? 'acknowledged' : 'pending', revision: scenario === 'changed' ? 2 : 1, resolved_by: null,
      })
    } finally {
      answer.resolve('rejected')
      clock?.mockRestore()
      await test.close()
    }
  },
)

it('keeps brain-only notes out of native result and conversation export content', async () => {
  const test = await fixture({ routing: { enabled: false } })
  try {
    const human = test.session('a', 'brain')
    await human.admit(user('/orchestra 归纳会议事项，交付清单'))
    const launched = await human.call()
    expect(launched).toMatchObject({ state: 'started', run_id: expect.any(String) })
    const svc = test.services.get('brain')!
    const run = svc.orchestra.db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=?").get(launched.run_id)!
    svc.orchestra.db.raw.prepare("UPDATE node_runs SET status='started',executor_session_id='child',lease_expires_at='2099-01-01T00:00:00.000Z' WHERE node_run_id=?").run(String(run.node_run_id))
    const marker = 'AUDIT_SYNTHETIC_BRAIN_ONLY'
    const binding = { node_run_id: String(run.node_run_id), attempt: Number(run.attempt),
      action_generation: Number(run.action_generation), executor_session_id: 'child' }
    const shared = 'AUDIT_SYNTHETIC_SHARED'
    // Recreate a valid private record that could have been written by the previous version.
    const scope = 'brain'
    const author = 'draft'
    const bodyDigest = createHmac('sha256', test.secret).update('run-note-body\0')
      .update(JSON.stringify([launched.run_id, binding.node_run_id, 'node', author, scope,
        binding.attempt, binding.action_generation, marker])).digest('hex')
    withTx(svc.orchestra.db, (tx) => {
      const entry = appendEvent(tx, { type: 'run.note_created', runId: launched.run_id, nodeRunId: binding.node_run_id,
        payload: { actor_kind: 'node', attempt: binding.attempt, action_generation: binding.action_generation,
          scope, body_digest: bodyDigest, evidence_strength: 'none' } })
      tx.run('INSERT INTO run_note_bodies(event_seq,body,author) VALUES (?,?,?)', [entry.seq, marker, author])
    })
    svc.runNotes!.callNode(binding, { action: 'add', scope: 'run', body: shared }, 'shared-note', new Date().toISOString())
    await human.admit(user('查看这次运行的便条'))
    expect(await human.call({ action: 'status', run_id: launched.run_id })).toMatchObject({ blocking: expect.any(Array) })
    const args = { action: 'notes', run_id: launched.run_id }
    const result = await human.invoke(args)
    const savedHistory = { type: 'tool/result', content: await human.render(args) }
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(JSON.stringify(savedHistory)).not.toContain(marker)
    expect(JSON.stringify(savedHistory)).toContain(shared)
    expect(svc.orchestra.db.raw.prepare('SELECT COUNT(*) n FROM run_note_bodies WHERE body=?').get(marker)?.n).toBe(1)
  } finally { await test.close() }
})
