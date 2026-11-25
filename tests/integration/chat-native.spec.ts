import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { serveOrchestra, type serveDshOrchestra, type TaskPlanProposal } from '../../src/index.ts'
import { OrchError } from '../../src/core/errors.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
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
import { textTarget } from '../../src/service/text-result.ts'
import type { ChatArtifactLink } from '../../src/core/receipt-location.ts'
import { createDeliveryReviewHost } from '../../src/service/delivery-review.ts'
import { recordArtifactPublication } from '../../src/service/artifact-completion.ts'
import { applyRunAcceptance } from '../../src/service/commands/run-acceptance.ts'
import { formatChatApproval } from '../../src/core/chat-approval-text.ts'
import { chatSemanticFixture } from '../fixtures/chat-semantic-model.ts'
import type { SemanticDraftCheckpoints, SemanticInput } from '../../src/service/semantic-admission.ts'
import { createSemanticDraftCheckpoints } from '../../src/service/semantic-draft-checkpoints.ts'
import { reportChatRun } from '../../src/service/chat-task-receipts.ts'
import { installNativeChat } from '../../src/service/chat-native.ts'
import { createNativeCommandSettings } from '../../src/service/native-command-settings.ts'

type Message = Parameters<Agent['followup']>[0]
type Definition = Parameters<Context['tools']['register']>[0]
type Activation = NonNullable<Parameters<Context['tools']['register']>[1]>
type Guard = Parameters<Context['tools']['guard']>[0]
type Service = Awaited<ReturnType<typeof serveDshOrchestra>>

async function fixture(options: { profile?: string; version?: string; enabled?: false | 'desktop'; host?: string;
  interpret?: (input: SemanticInput) => unknown | Promise<unknown>;
  routing?: { enabled: boolean }; reportRequirements?: string[]; planningError?: OrchError; dispatchPlans?: boolean; approvalPolicy?: 'ask' | 'never';
  draftCheckpoints?: (profileDir: string) => SemanticDraftCheckpoints } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-native-chat-'))
  const draftCheckpoints = options.draftCheckpoints?.(directory)
  const ctx = new Context()
  const commandNames: string[] = []
  ctx.provide('commands', { list: () => commandNames.map(name => ({ name, description: '已有命令' })) })
  ctx.provide('skills', { list: async () => [] })
  const agents = new Map<string, Agent>()
  const conversations = new Map<string, string[]>()
  const routes: string[] = []
  const notices: Array<{ sessionId: string; message: Message; target: 'nextTurn' | 'nextStep' }> = []
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
  const serviceDbFiles = new Map<string, string>()
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
  const interpret = vi.fn(options.interpret ?? chatSemanticFixture)
  ctx.provide('llm', { async prepareCall(config: object) {
    return { config, async *stream(request: { messages: Array<{ content: Array<{ text: string }> }>; tools: unknown[] }) {
      expect(request.tools).toEqual([])
      const raw = await interpret(JSON.parse(request.messages[0]!.content[0]!.text))
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(raw) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } })
  ctx.provide('tools', {
    register(definition: Definition, options: Activation) { tool = definition; activation = options },
    guard(check: Guard) { guard = check },
  })
  ctx.provide('systemPrompt', { section(section: { text: typeof prompt }) { prompt = section.text } })
  const flush = vi.fn(async () => true)
  ctx.provide('sessions', { flush })
  ctx.provide('approval', { request: approval, overrideOf: () => options.approvalPolicy })
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
    const core = await serveOrchestra({
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
    const service: Service = { ...core, pendingNativeApprovals: () => [] }
    services.set(sessionId, service)
    serviceDbFiles.set(sessionId, dbFile)
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
        ...(draftCheckpoints && { draftCheckpoints }),
        bindingFor(agent) {
          const sessionId = agent.session.id
          if (agents.get(sessionId) !== agent || agent.session.header.origin === 'subagent') return
          const workspaceId = [...conversations].find(([, ids]) => ids.includes(sessionId))?.[0]
          if (workspaceId) return { identity: workspaceId + '/' + sessionId, workspaceId, sessionId }
        },
        hasService: ({ sessionId }) => services.has(sessionId),
        async serviceFor({ sessionId }) { return services.get(sessionId) ?? openService(sessionId, join(directory, sessionId + '.sqlite')) },
        autoRouteEnabled: () => options.routing!.enabled,
        interpret: async input => interpret(input),
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
    const nextStep: Message[] = []
    const signal = new AbortController()
    let turn = 0
    const agent = {
      id: sessionId, status: 'running', model: { current: () => ({ provider: 'fixture', model: 'model' }) },
      inbox: { nextTurn, nextStep },
      session: { id: sessionId, header: { cwd: directory, ...header }, snapshotEvents: () => [...events] },
      followup(message: Message) {
        const recorded = structuredClone(message)
        nextTurn.push(recorded)
        events.push({ type: 'agent/inbox/spliced', data: { target: 'nextTurn', inserted: [recorded] } })
        notices.push({ sessionId, message: recorded, target: 'nextTurn' })
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message: recorded })
      },
      steer(message: Message) {
        const recorded = structuredClone(message)
        nextStep.push(recorded)
        events.push({ type: 'agent/inbox/spliced', data: { target: 'nextStep', inserted: [recorded] } })
        notices.push({ sessionId, message: recorded, target: 'nextStep' })
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
          for (const queue of [nextTurn, nextStep]) {
            const queued = queue.findIndex(({ id }) => id === message.id)
            if (queued !== -1) queue.splice(queued, 1)
          }
        }
        dispatch.emit('agent/inbox/claimed', { message, turn: advance ? turn + 1 : turn })
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
    return { agent, admit, admitMany, invoke, call, render, signal, checkTool, nextTurn, nextStep, events, dispatch: agentEvents(ctx, agent) }
  }
  return { session, serve, services, planner, workflowGenerator, routes, approval, notices, spawn, interpret, flush, directory, commandNames,
    async restart(sessionId: string) {
      const prior = services.get(sessionId)
      if (!prior) throw new Error('No service to restart for session ' + sessionId)
      await prior.close()
      return await openService(sessionId, serviceDbFiles.get(sessionId)!)
    },
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

it.each(['quality', 'provider'] as const)('启动前失败后，补充条件沿用原任务，不要求用户重述或重复确认（%s）', async failure => {
  const test = await fixture({ interpret: input => ({
    kind: 'task', relation: input.draft ? 'continue' : 'new', timing: 'immediate', quote: input.current.text,
    ...(input.draft ? { draft_revision: input.draft.revision, continuation: 'supply' } : {}),
    constraints: input.draft ? [] : [{ id: 'chat', kind: 'chat_only', source_message_id: input.current.message_id,
      quote: '输出到聊天里' }], missing: [],
  }) })
  const plan = test.planner.getMockImplementation()!
  test.planner.mockImplementation(async input => ({ ...await plan(input), deliverables: [
    { title: 'AI 热点清单', node_id: 'draft', goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' } },
  ] }))
  try {
    const human = test.session('work', 'continuous-admission')
    const original = '帮我查找今天AI热点新闻，来源AIHOT和B站，15条内，输出到聊天里'
    if (failure === 'quality') test.badPlan(true)
    else test.plannerUnavailable(true)
    await human.admit(user(original))
    expect(await human.call()).toMatchObject({ state: failure === 'quality' ? 'quality_blocked' : 'error' })
    expect(count(test.services.get('continuous-admission')!, 'runs')).toBe(0)
    test.badPlan(false)
    test.plannerUnavailable(false)
    const supplement = '合计，重复信息合并，时间最近24小时'
    await human.admit(user(supplement))
    expect(await human.call()).toMatchObject({ state: 'started' })
    expect(test.planner.mock.calls.at(-1)?.[0]).toMatchObject({ goal: original + '\n' + supplement,
      requirements_contract: { start_policy: 'immediate', constraints: [{ kind: 'chat_only' }],
        sources: [{ text: original }, { text: supplement }] } })
    expect(count(test.services.get('continuous-admission')!, 'runs')).toBe(1)
    expect(test.approval).not.toHaveBeenCalled()
  } finally { await test.close() }
})

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
    const progressService=test.services.get('parent')!
    const inProgress=progressService.orchestra.db.raw.prepare('SELECT actor,stage,title FROM chat_planning_progress').get()!
    expect(inProgress.stage).toBe('planning')
    expect(inProgress.title).toContain('待取消')
    expect(progressService.planning.progress(String(inProgress.actor)).items).toHaveLength(1)
    expect(progressService.planning.progress('another-operator').items).toEqual([])
    human.signal.abort(new DOMException('operator cancelled', 'AbortError'))
    await expect(admission).rejects.toMatchObject({ name: 'AbortError' })
    const service = test.services.get('parent')!
    expect(service.orchestra.db.raw.prepare('SELECT stage FROM chat_planning_progress').get()?.stage).toBe('cancelled')
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
      content: [expect.objectContaining({ text: expect.stringContaining('交付目标') })],
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
    expect(await human.checkTool('read')).toBeUndefined()
    expect(test.planner).not.toHaveBeenCalled()

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

it.each(['approval', 'wait', 'no files', 'declined', 'never'] as const)('enforces named approval and delivery constraints in chat planning (%s)', async (scenario) => {
  const test = await fixture({ routing: { enabled: true }, dispatchPlans: true, approvalPolicy: scenario === 'never' ? 'never' : 'ask', interpret: input => ({
    kind: 'task', relation: 'new', timing: 'immediate', quote: input.current.text, constraints: [
      { id: 'review', kind: 'approval_before', scope: 'steps', action: '计算', reviewer: { kind: 'operator' },
        source_message_id: input.current.message_id, quote: '在我批准前，计算步骤必须等待' },
      ...(scenario === 'no files' ? [{ id: 'no-file', kind: 'no_workspace_files', source_message_id: input.current.message_id, quote: '不要读写文件' }] : []),
    ],
  }) })
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
    return { ...plan, title: 'F8 演练', constraint_bindings: [{ constraint_id: 'c1', approval_node_id: 'gate', protected_node_ids: ['draft'] }], steps: [
      { ...draftStep, node_id: 'gate', description: approvalName },
      { ...draftStep, depends_on: ['gate'] },
    ], risks: gateType === 'wait' ? [{ severity: 'low', description: '事件可能延迟', mitigation: '等待到期', node_id: 'gate' }] : [] }
  })
  try {
    const human = test.session('work', 'parent')
    // 启动审批发生在 pre-step 里，拒绝要在派单之前设好（C06）。
    if (scenario === 'declined') test.deny(true)
    const delivery = scenario === 'no files' ? '在会话中给出结果。不要读写文件。' : '交付 report.md。'
    await human.admit(user('新建一次性测试任务「F8 演练」。为本次测试单独生成流程，设置人工审批步骤「批准合成数据核对」。在我批准前，计算步骤必须等待。批准后，使用模拟数据计算净额并' + delivery))
    const service = test.services.get('parent')!
    if (scenario === 'declined') {
      // 拒绝启动：不创建运行，也不留下指向空审批中心的入口（C06）。
      await expect(human.call()).resolves.toMatchObject({ state: 'launch_declined', title: 'F8 演练' })
      expect(count(service, 'runs')).toBe(0)
      expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toMatchObject({ n: 0 })
      expect(JSON.stringify(await human.render())).toContain('继续未启动的计划')
      return
    }
    const receipt = await human.call()
    if (scenario !== 'approval' && scenario !== 'never') {
      expect(receipt).toMatchObject({ state: 'quality_blocked', issues: [expect.stringContaining(scenario === 'wait' ? '审批' : '文件')] })
      expect(count(service, 'runs')).toBe(0)
      expect(test.approval).not.toHaveBeenCalled()
      return
    }
    expect(receipt).toMatchObject({ state: 'started', title: 'F8 演练' })
    if (scenario === 'never') expect(test.approval).not.toHaveBeenCalled()
    else expect(test.approval.mock.calls[0]?.[0].reason.split('\n')).toEqual([
      'Orchestra 审批', '任务　F8 演练', '步骤　启动前确认（整项任务）',
      '审批原因　计划包含人工审批步骤，启动前需要你确认这份计划。',
      '审批内容　批准启动这份计划，共 2 个步骤。',
      '确认后　按计划启动，流程里的人工审批仍须单独处理。',
      '计划步骤　共 2 步', '1. 批准合成数据核对', '2. 整理报告', '将交付　report.md',
      expect.stringMatching(/^计划版本　[0-9a-f-]{36} \/ [0-9a-f]{64}$/u),
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
    if (scenario === 'never') {
      await expect(human.call({ action: 'review', decision_title: approvalName })).resolves.toMatchObject({ kind: 'panel_review', location: { decisionId: list.data.items[0].decision_id } })
      expect(test.approval).not.toHaveBeenCalled()
      expect(test.spawn).not.toHaveBeenCalled()
      expect(steps()[0]).toEqual({ node_id: 'gate', status: 'blocked_pre' })
      return
    }
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
      content: [{ type: 'text', text: expect.stringContaining('当前的「任务命令」') }],
    }] })
    expect(test.services.size).toBe(0)
    await human.admit(user(`/orchestra ${goal}`))
    await expect(human.call()).resolves.toMatchObject({ state: 'started' })
    expect(readRouting).toHaveBeenCalledOnce()
    expect(test.registered().prompt({ agent: human.agent })).toContain('Never assume its name')
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
    reportChatRun(db, otherRun, 'delivered:terminal:cancelled')
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
    await human.admit(test.notices[2]!.message, false)
    await runScan()
    expect(db.raw.prepare('SELECT reported_key FROM chat_task_receipts').all()).toEqual(expect.arrayContaining([
      { reported_key: 'delivered:terminal:failed' }, { reported_key: 'delivered:terminal:cancelled' },
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
    const displayed=reviewHost.list(actor,first.run_id).items[0]!
    expect(() => reviewHost.change({ action: 'accept', operation_id: uuidv7(), run_id: first.run_id, node_run_id: revisedId,
      hold_id:displayed.hold_id!,expected_revision:displayed.revision,artifact_id: revised.artifact_id, sha256: revised.sha256 }, actor, now)).toThrow(/正在返工/u)
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
    await expect(human.render({ action: 'status' })).resolves.toEqual([
      { type: 'text', text: blockedText }, { type: 'text', text: expect.stringContaining(published!.artifact_id) },
    ])
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
    await expect(human.call()).resolves.toMatchObject({ state: 'quality_blocked',
      issues: [expect.stringMatching(/涉及影响.*需要调整/u)] })
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
    expect(notification.source).toMatchObject({ kind: 'plugin:dsh-orchestra', form: 'notice', summary: expect.any(String),
      attentionLinks: [{ location: { kind: 'decision', sessionId: 'parent', runId: prepared.run_id, decisionId: decision } }] })
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

it('C03 澄清后的补充答复续接草稿，不重新分类成聊天', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('帮我整理一下'))
    expect(await human.call()).toMatchObject({ state: 'clarification_required' })
    await human.admit(user('用 office-sample.csv，按天分组，只读不修改原表'))
    await expect(human.call()).resolves.toMatchObject({ state: 'started' })
    const goal = String(test.planner.mock.calls.at(-1)?.[0].goal ?? '')
    expect(goal).toContain('帮我整理一下')
    expect(goal).toContain('office-sample.csv')
  } finally { await test.close() }
})

function attachmentOnlyMessage(): Message {
  type ImagePart = Extract<Message['content'][number], { type: 'image' }>
  const attachmentId = uuidv7() as ImagePart['attachment']['attachmentId']
  return { ...user(''), content: [{ type: 'image', attachment: {
    attachmentId, mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'sample.png',
  } }] }
}

it('入口回归 C03 drops a cancelled clarification before the following message', async () => {
 const t=await fixture()
 try {
  const h=t.session('work','audit-clarify')
  await h.admit(user('帮我整理一下'))
  expect(await h.call()).toMatchObject({state:'clarification_required'})
  await h.admit(user('算了'))
  expect(t.planner).toHaveBeenCalledTimes(0)
  await h.admit(user('这次按负责人分组'))
  await h.call()
  expect(t.planner).not.toHaveBeenCalled()
 } finally {await t.close()}
})
it('入口回归 C10 preserves the outcome of a previously successful task', async () => {
 const t=await fixture()
 try {
  const h=t.session('work','audit-stop')
  await h.admit(user('/orchestra 归纳会议事项，交付清单'))
  const r=await h.call()
  expect(r.state).toBe('started')
  const db=t.services.get('audit-stop')!.orchestra.db
  db.raw.prepare("UPDATE node_runs SET status='done' WHERE run_id=?").run(r.run_id)
  db.raw.prepare("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?").run(new Date().toISOString(),r.run_id)
  await h.admit(user('请停止刚才的任务'))
  const outcome=await h.invoke({action:'stop',run_id:r.run_id})
  expect(JSON.parse(outcome.text).status).toBe('succeeded')
  expect(outcome.summary).toContain('此前已完成')
 } finally {await t.close()}
})
it('入口回归 C10 waits for execution confirmation before reporting an active task stopped', async () => {
 const t=await fixture()
 try {
  const h=t.session('work','audit-active')
  await h.admit(user('/orchestra 归纳会议事项，交付清单'))
  const r=await h.call()
  expect(r.state).toBe('started')
  const db=t.services.get('audit-active')!.orchestra.db
  db.raw.prepare("UPDATE node_runs SET status='started',executor_session_id='fixture-child' WHERE run_id=?").run(r.run_id)
  await h.admit(user('请停止刚才的任务'))
  t.approval.mockResolvedValueOnce('allowed-once')
  const outcome=await h.call({action:'stop',run_id:r.run_id})
  const attempt=db.raw.prepare("SELECT status,fence_state FROM node_runs WHERE run_id=?").get(r.run_id)
  expect(outcome.state).toBe('stop_requested')
  expect(outcome.status).toBe('running')
  expect(attempt).toMatchObject({status:'stopping'})
 } finally {await t.close()}
})
it('入口回归 C04 leaves ordinary image attachments with the host', async () => {
 const t=await fixture()
 try {
  const h=t.session('work','audit-file')
  const msg = attachmentOnlyMessage()
  await h.admit(msg)
  await h.call()
  expect(await h.checkTool('read')).toBeUndefined()
 } finally {await t.close()}
})

it('入口回归 C05 defers the task even when the user separately protects the source file',async()=>{
 const t=await fixture()
 try {const h=t.session('work','audit-delay')
 const input='请生成审计报告。先不要执行这项任务。不要修改原文件。'
 await h.admit(user(input));await h.call()
 expect(t.planner).not.toHaveBeenCalled()
 }finally{await t.close()}
})
it('入口回归 C04 keeps native read available after a standalone file',async()=>{
 const t=await fixture()
 try {const h=t.session('work','audit-read')
 const msg = attachmentOnlyMessage()
 await h.admit(msg)
 expect(await h.checkTool('read')).toBeUndefined()
 }finally{await t.close()}
})

it('入口回归 C07 shows every approved step, deliverables and plan version', ()=>{
const final = '核对后发送完整审核结果与最新修订明细；将清单与摘要交给负责本次项目验收的客户甲'
const text = formatChatApproval({step:'启动', reason:'核对范围', operation:'启动', consequence:'开始运行',
planSteps:[...Array.from({length:8}, (_, i) => '阶段' + (i + 1)), final],
deliverables:['核对清单'], planVersion:'plan-9 / hash-9'})
expect(text).toContain('9. ' + final);expect(text).toContain('核对清单');expect(text).toContain('plan-9 / hash-9')
})

it('C10 stops the task explicitly named by the human instead of the last status target', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'named-stop')
    await human.admit(user('/orchestra 整理第一批合同'))
    const first = await human.call()
    await human.admit(user('/orchestra 整理第二批合同'))
    const second = await human.call()
    await human.admit(user('查看第一批合同，然后停止第二批合同'))
    await expect(human.call({ action: 'status', task_title: first.title })).resolves.toMatchObject({ run_id: first.run_id })
    await expect(human.call({ action: 'stop', task_title: second.title, run_id: first.run_id }))
      .resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID' })
    await expect(human.call({ action: 'stop', task_title: second.title }))
      .resolves.toMatchObject({ state: 'stop_requested', run_id: second.run_id })
    const { db } = test.services.get('named-stop')!.orchestra
    expect(db.raw.prepare('SELECT cancel_requested_at FROM runs WHERE run_id=?').get(first.run_id)?.cancel_requested_at).toBeNull()
    expect(db.raw.prepare('SELECT cancel_requested_at FROM runs WHERE run_id=?').get(second.run_id)?.cancel_requested_at).not.toBeNull()
    expect(test.approval).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining(second.title) }))
  } finally { await test.close() }
})

it('keeps a new material revision unstarted when an older native approval completes', async () => {
  const test = await fixture({ routing: { enabled: true } })
  const approvalEntered = Promise.withResolvers<void>()
  const approvalResult = Promise.withResolvers<'rejected' | 'allowed-once'>()
  test.approval.mockImplementationOnce(async () => { approvalEntered.resolve(); return approvalResult.promise })
  const definition = {
    name: '材料复核', nodes: [{ node_id: 'start', type: 'trigger' },
      { node_id: 'gate', type: 'approval', title: '确认材料范围', config: { prompt: '确认材料范围', on_timeout: 'fail' } },
      { node_id: 'draft', type: 'agent' }],
    edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'draft' }],
  }
  test.workflowGenerator.mockResolvedValue(definition)
  const original = test.planner.getMockImplementation()!
  test.planner.mockImplementation(async input => {
    const result = await original(input)
    const step = result.steps[0]!
    return { ...result, steps: [{ ...step, node_id: 'gate', description: '确认材料范围' }, { ...step, depends_on: ['gate'] }] }
  })
  try {
    const human = test.session('work', 'revision-approval')
    const pending = human.admit(user('/orchestra 整理材料并交付复核报告'))
    await approvalEntered.promise
    const service = test.services.get('revision-approval')!
    const old = service.planning.listDrafts('local-dsh:fixture').items[0]!
    const updated = service.planning.grantMaterials({ operation_id: uuidv7(), plan_id: old.plan_id,
      content_hash: old.content_hash, nodes: ['draft'], items: [{ name: '材料.txt', body: '只授权整理步骤读取' }] },
      'local-dsh:fixture', new Date().toISOString())
    approvalResult.resolve('allowed-once')
    await pending
    expect(await human.call()).toMatchObject({ state: 'error', code: 'CONFIRMATION_MISMATCH', reason: 'plan_updated' })
    expect(JSON.stringify(await human.render())).toContain('取回最新计划')
    expect(count(service, 'runs')).toBe(0)
    expect(service.planning.progress('local-dsh:fixture').items).toMatchObject([{ plan_id: updated.plan_id, stage: 'approval' }])
  } finally { approvalResult.resolve('rejected'); await test.close() }
})

it('uses the production semantic transport for previously unseen task wording and persists its source-bound contract', async () => {
  const test = await fixture({ interpret: input => ({ kind: 'task', relation: 'new', timing: 'immediate',
    quote: input.current.text, constraints: [] }) })
  try {
    const human = test.session('work', 'semantic-production')
    const request = user('请出一份周报。')
    await human.admit(request)
    expect(await human.call()).toMatchObject({ state: 'started' })
    expect(test.interpret).toHaveBeenCalledTimes(1)
    expect(test.planner.mock.calls[0]?.[0].requirements_contract).toMatchObject({ version: 1,
      start_policy: 'immediate', sources: [{ message_id: request.id, text: '请出一份周报。' }] })
  } finally { await test.close() }
})

it('keeps a human-named task title inside the approved plan hash and scopes status to its signed source', async () => {
  const test = await fixture({ interpret: input => ({ kind: 'task', relation: 'new', timing: 'immediate',
    quote: input.current.text, constraints: [] }) })
  try {
    const human = test.session('work', 'semantic-named-title')
    const title = '周报-定稿'
    await human.admit(user(`/orchestra 请创建任务「${title}」并整理这批记录`))
    const accepted = await human.call()
    expect(accepted).toMatchObject({ state: 'started', title })

    const { db } = test.services.get('semantic-named-title')!.orchestra
    const taskId = db.raw.prepare('SELECT task_id FROM runs WHERE run_id=?').get(accepted.run_id)?.task_id as string
    const plan = db.raw.prepare('SELECT proposal_json FROM task_plans WHERE owner_task_id=?').get(taskId) as { proposal_json: string }
    expect(JSON.parse(plan.proposal_json)).toMatchObject({ title })

    // Simulate an older approved plan whose generated title expanded the human's exact name.
    db.raw.prepare('UPDATE tasks SET title=? WHERE task_id=?').run('旧版本扩写标题', taskId)
    await expect(human.call({ action: 'status', task_title: title })).resolves.toMatchObject({ run_id: accepted.run_id })
    await expect(human.call({ action: 'status', task_title: '另一个任务' })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await expect(human.call({ action: 'status', run_id: taskId })).resolves.toMatchObject({ run_id: accepted.run_id })
    await expect(human.call({ action: 'status', run_id: 'tsk_unrelated_task' })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
  } finally { await test.close() }
})

it('replays a durable admission after the live Agent is recreated even when the model becomes unavailable', async () => {
  const test = await fixture()
  try {
    const original = test.session('work', 'semantic-replay')
    const request = user('/orchestra 整理一份周报')
    await original.admit(request)
    const accepted = await original.call()
    expect(accepted).toMatchObject({ state: 'started' })
    const before = test.interpret.mock.calls.length
    test.interpret.mockImplementation(() => { throw Error('model unavailable after restart') })
    const reopened = test.session('work', 'semantic-replay')
    await reopened.admit({ ...request, id: uuidv7() as Message['id'] })
    expect(await reopened.call()).toMatchObject({ state: 'started', run_id: accepted.run_id })
    expect(test.interpret).toHaveBeenCalledTimes(before)
    expect(test.planner).toHaveBeenCalledTimes(1)
    expect(count(test.services.get('semantic-replay')!, 'runs')).toBe(1)
  } finally { await test.close() }
})

it('returns a durable plan-only preview with no execution and no native approval popup', async () => {
  const test = await fixture({ interpret: input => ({ kind: 'task', relation: 'new', timing: 'plan_only',
    quote: input.current.text, constraints: [] }) })
  try {
    const human = test.session('work', 'semantic-plan')
    const message = user('/orchestra 先给我一份周报计划，确认后再执行')
    await human.admit(message)
    expect(await human.call()).toMatchObject({ state: 'plan_ready', plan_id: expect.any(String) })
    expect(test.planner).toHaveBeenCalledTimes(1)
    expect(test.approval).not.toHaveBeenCalled()
    const service = test.services.get('semantic-plan')!
    expect(count(service, 'runs')).toBe(0)
    const plan = service.orchestra.db.raw.prepare('SELECT plan_id,content_hash,created_by FROM task_plans').get()!
    service.planning.discard({ plan_id: String(plan.plan_id), content_hash: String(plan.content_hash) }, String(plan.created_by), new Date().toISOString())
    await human.admit(message)
    expect(await human.call()).toMatchObject({ state: 'draft_discarded' })
    expect(test.interpret).toHaveBeenCalledTimes(1)
  } finally { await test.close() }
})

it('holds without creating a plan, ignores acknowledgments, and rejects a fabricated note capability', async () => {
  const test = await fixture({ interpret: input => input.current.text === '查看摘要'
    ? { kind: 'brain_notes', quote: '查看摘要' }
    : { kind: 'task', relation: 'new', timing: 'held', quote: input.current.text, constraints: [] } })
  try {
    const human = test.session('work', 'semantic-held')
    await human.admit(user('请整理周报，先别执行，也别改原件'))
    expect(await human.call()).toMatchObject({ state: 'task_held' })
    await human.admit(user('收到'))
    expect(test.interpret).toHaveBeenCalledTimes(1)
    expect(test.serve).not.toHaveBeenCalled()
    await human.admit(user('查看摘要'))
    expect(await human.call({ action: 'review_brain_notes' })).toMatchObject({ state: 'error' })
    expect(test.planner).not.toHaveBeenCalled()
  } finally { await test.close() }
})

it('keeps ordinary image questions and long explanations with host tools and skips interpretation when disabled', async () => {
  const routing = { enabled: true }
  const test = await fixture({ routing })
  try {
    const human = test.session('work', 'semantic-ordinary')
    const withImage = { ...attachmentOnlyMessage(), content: [
      { type: 'text', text: '这张图讲什么？' }, ...attachmentOnlyMessage().content,
    ] } as Message
    await human.admit(withImage)
    expect(human.checkTool('read')).toBeUndefined()
    await human.admit(user('请解释以下文字：' + '示例'.repeat(1100)))
    expect(human.checkTool('read')).toBeUndefined()
    routing.enabled = false
    await human.admit(user('请出一份周报'))
    expect(test.interpret).not.toHaveBeenCalled()
    expect(test.planner).not.toHaveBeenCalled()
  } finally { await test.close() }
})

it('discards a semantic result after automatic routing is disabled while the model is running', async () => {
  const routing = { enabled: true }
  const blocked = Promise.withResolvers<unknown>()
  const test = await fixture({ routing, interpret: async () => blocked.promise })
  try {
    const human = test.session('work', 'semantic-setting')
    const pending = human.admit(user('请出周报'))
    await expect.poll(() => test.interpret.mock.calls.length).toBe(1)
    routing.enabled = false
    blocked.resolve({ kind: 'task', relation: 'new', timing: 'immediate', quote: '请出周报', constraints: [] })
    await pending
    expect(test.planner).not.toHaveBeenCalled()
    expect(human.checkTool('read')).toBeUndefined()
  } finally { await test.close() }
})

it('两次原生工具拒绝后仍进入最终说明步骤，并且提示只注入一次', async () => {
  const test = await fixture()
  try {
    const human = test.session('workspace', 'report-after-denial')
    await human.admit(user('整理办公室事项，交付一份报告'))
    expect(human.checkTool('skill')).toContain('Orchestra 接管')
    expect(human.checkTool('bili_hot')).toContain('Orchestra 接管')
    const recovery = await human.admitMany([], false, false)
    expect(recovery).toMatchObject({ kind: 'enter', messages: [expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringContaining('现在用已有通知给出最终回复') })],
    })] })
    expect(human.checkTool('orchestra_task')).toBeUndefined()
    const next = await human.admitMany([], false, false)
    expect(next).toEqual({ kind: 'enter', messages: [] })
    await expect(human.call({ action: 'status' })).resolves.toHaveProperty('run_id')
    expect(count(test.services.get('report-after-denial')!, 'runs')).toBe(1)
  } finally { await test.close() }
})

it.each(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'cancelled', 'orphaned'])
('重新检查旧版 %s 入队回执，丢弃后重投同一通知，只在来源会话落盘后确认', async status => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    withTx(db, tx => tx.run('UPDATE runs SET status=?,ended_at=? WHERE run_id=?', [status, new Date().toISOString(), runId]))
    // The old version acknowledged durable insertion before any visible user/message.
    reportChatRun(db, runId, 'terminal:' + status)
    const readKey = () => db.raw.prepare('SELECT reported_key FROM chat_task_receipts').get()?.reported_key
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    const first = test.notices[0]!.message
    expect(first.source).toMatchObject({ final: true })
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    expect(readKey()).toBe('terminal:' + status)
    human.nextStep.splice(human.nextStep.findIndex(message => message.id === first.id), 1)
    human.events.push({ type: 'agent/inbox/spliced', data: { target: 'nextStep', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
    human.dispatch.emit('agent/inbox/discarded', { message: first })
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]!.message.id).toBe(first.id)
    await human.admit(test.notices[1]!.message, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(readKey()).toBe('delivered:terminal:' + status)
    expect(test.notices).toHaveLength(2)
    expect(count(test.services.get('parent')!, 'runs')).toBe(1)
  } finally { await test.close(); vi.useRealTimers() }
})

it('claimed 后的 pre-step 拒绝会恢复通知，在途 claim 与失败 flush 都不会假确认或重复入队', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    withTx(db, tx => tx.run("UPDATE runs SET status='failed',ended_at=? WHERE run_id=?", [new Date().toISOString(), runId]))
    const readKey = () => db.raw.prepare('SELECT reported_key FROM chat_task_receipts').get()?.reported_key
    test.flush.mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(2000)
    const first = test.notices[0]!.message
    expect(readKey()).toBeNull()
    human.nextStep.splice(human.nextStep.findIndex(message => message.id === first.id), 1)
    human.dispatch.emit('agent/inbox/claimed', { message: first, turn: 50 })
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    human.events.push({ type: 'turn/end', data: { turn: 50, reason: { kind: 'blocked' } } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]!.message.id).toBe(first.id)
    await human.admit(test.notices[1]!.message, false)
    test.flush.mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(readKey()).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(readKey()).toBe('delivered:terminal:failed')
    expect(test.notices).toHaveLength(2)
  } finally { await test.close(); vi.useRealTimers() }
})

it.each(['applied', 'replayed', 'rejected', 'old-attempt', 'old-generation'] as const)
('终态会话只显示本次已采纳失败回报的原因与下一步（%s）', async mode => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    const now = new Date().toISOString()
    const completion = { outcome: 'blocked', reason: '执行时限已到，资料尚未整理完成。',
      next_action: '缩小整理范围后重试。', missing: ['完整分类清单'] }
    withTx(db, tx => {
      const node = tx.get<{ node_run_id: string; attempt: number; action_generation: number }>(
        "SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_type='agent'", [runId])!
      tx.run("UPDATE node_runs SET status='failed' WHERE node_run_id=?", [node.node_run_id])
      tx.run("UPDATE runs SET status='failed',ended_at=? WHERE run_id=?", [now, runId])
      tx.run('INSERT INTO report_registry(report_id,node_run_id,attempt,report_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        ['failed-report', node.node_run_id, node.attempt, 1, mode === 'rejected' ? 'rejected' : mode === 'replayed' ? 'replayed' : 'applied', now, now])
      appendNodeRunEvent(tx, test.secret, node.node_run_id, 'report_applied', { report_id: 'failed-report', report_seq: 1,
        next_status: 'failed', attempt: node.attempt + (mode === 'old-attempt' ? 1 : 0),
        action_generation: node.action_generation + (mode === 'old-generation' ? 1 : 0), completion })
    })
    const result = await human.invoke({ action: 'status' })
    const valid = mode === 'applied' || mode === 'replayed'
    expect(JSON.parse(result.text).failure_details).toHaveLength(valid ? 1 : 0)
    if (valid) {
      expect(result.summary).toContain(completion.reason)
      expect(result.summary).toContain('下一步：' + completion.next_action)
      expect(result.summary).toContain('完整分类清单')
    } else expect(result.summary).not.toContain(completion.reason)
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    const text = test.notices[0]!.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(text.includes(completion.reason)).toBe(valid)
  } finally { await test.close(); vi.useRealTimers() }
})

it.each(['new', 'actions', 'decision', 'blocked'] as const)
('当前回合收到可跳转待办，旧版 %s 通知仅补送一次，不猜测批准或重试参数', async legacy => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId, task_id: taskId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    const id = decisionId()
    withTx(db, tx => openDecision(tx, { decisionId: id, runId, nodeRunId: null, kind: 'startup_unknown',
      approver: 'human', payload: { target_summary: '这次执行的启动状态有待确认。' } }))
    if (legacy !== 'new') {
      const before = await human.call({ action: 'status' })
      const pair = [id, before.decisions[0].revision]
      const oldKey = legacy === 'actions' ? 'actions:' + sha256Hex(JSON.stringify(pair))
        : legacy === 'decision' ? 'decision:' + sha256Hex(JSON.stringify([pair]))
          : 'blocked:' + sha256Hex(JSON.stringify([]))
      reportChatRun(db, runId, 'delivered:' + oldKey)
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    const notification = test.notices[0]!
    expect(notification.target).toBe('nextStep')
    expect(human.nextTurn).toHaveLength(0)
    expect(human.nextStep).toHaveLength(1)
    expect(notification.message.source).toMatchObject({ attentionLinks: [{ location: {
      kind: 'decision', workspaceId: 'work', sessionId: 'parent', taskId, runId, decisionId: id,
    } }] })
    // This is another step of the active originating turn, not a follow-up turn.
    await human.admit(notification.message, false, false)
    expect(await human.call({ action: 'status' })).toMatchObject({ decisions: [{ kind: 'startup_unknown',
      explanation: { title: '启动情况待核实' } }], attention_links: [{ location: { decisionId: id } }] })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await human.invoke({ action: 'review', decision_title: '启动状态待确认' })
      expect(JSON.parse(result.text)).toMatchObject({ kind: 'panel_review', location: { decisionId: id, runId } })
      expect(result.summary).toContain('前往审批中心')
      expect(test.registered().tool.output.presentationMeta?.({}, result)).toMatchObject({ location: { decisionId: id } })
    }
    expect(test.approval).not.toHaveBeenCalled()
    expect(db.raw.prepare('SELECT status,resolved_by FROM decisions WHERE decision_id=?').get(id))
      .toMatchObject({ status: 'pending', resolved_by: null })
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    expect(db.raw.prepare('SELECT reported_key FROM chat_task_receipts').get()?.reported_key)
      .toMatch(/^delivered:actions:v2:/u)
    expect(count(test.services.get('parent')!, 'runs')).toBe(1)
  } finally { await test.close(); vi.useRealTimers() }
})

it('原生工具审批在来源会话通知，持续等待不重复，新审批会再次通知', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const service = test.services.get('parent')!
    let pending: ReturnType<NonNullable<Service['pendingNativeApprovals']>> = [{ requestId: 'approval-1', nodeRunId: 'step-1',
      executorSessionId: 'execution-session', tool: 'bili_hot', mode: 'user' }]
    service.pendingNativeApprovals = id => id === runId ? pending : []
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    expect(test.notices[0]).toMatchObject({ sessionId: 'parent', message: {
      source: { summary: expect.stringContaining('等待工具授权') },
      content: [{ type: 'text', text: expect.stringContaining('bili_hot') }],
    } })
    expect(test.notices[0]!.message.content[0]).toMatchObject({ text: expect.stringContaining('执行会话：execution-session') })
    await human.admit(test.notices[0]!.message, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.notices).toHaveLength(1)
    pending = []
    await vi.advanceTimersByTimeAsync(2000)
    pending = [{ requestId: 'approval-2', nodeRunId: 'step-1', executorSessionId: 'execution-session', tool: 'read', mode: 'brain' }]
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]!.message.content[0]).toMatchObject({ text: expect.stringContaining('主脑判断或你的授权') })
  } finally { await test.close(); vi.useRealTimers() }
})

it('flush期间才消费的通知留到下一次耐久检查再确认', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    withTx(db, tx => tx.run("UPDATE runs SET status='cancelled',ended_at=? WHERE run_id=?", [new Date().toISOString(), runId]))
    const readKey = () => db.raw.prepare('SELECT reported_key FROM chat_task_receipts').get()?.reported_key
    test.flush.mockImplementationOnce(async () => {
      // This event lands after the flush checkpoint; it was not covered by that flush.
      await human.admit(test.notices[0]!.message, false)
      return true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    expect(readKey()).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(readKey()).toBe('delivered:terminal:cancelled')
    expect(test.notices).toHaveLength(1)
  } finally { await test.close(); vi.useRealTimers() }
})

it('同一 SQLite 重开后由真实通知泵送达取消回执且重复轮询不重复发送', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture({ routing: { enabled: false } })
  try {
    const sessionId = 'restart-cancel-notice'
    const human = test.session('work', sessionId)
    await human.admit(user('/orchestra 整理办公材料并交付审核报告'))
    const { run_id: runId } = await human.call()
    const serviceId = [...test.services.keys()][0]!
    const prior = test.services.get(serviceId)!
    const oldNodeRuns = prior.orchestra.db.raw.prepare('SELECT node_run_id FROM node_runs WHERE run_id=? ORDER BY seq').all(runId)
    const cancelled = prior.orchestra.commands.cancelRun({ runId, cancelResult: 'unknown', graceMs: 30_000,
      now: new Date().toISOString() })
    expect(cancelled.terminalStatus).toBe('cancelled')

    const restarted = await test.restart(serviceId)
    expect(restarted.orchestra.db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status).toBe('cancelled')
    expect(restarted.orchestra.db.raw.prepare('SELECT node_run_id FROM node_runs WHERE run_id=? ORDER BY seq').all(runId)).toEqual(oldNodeRuns)
    const readReceipt = () => restarted.orchestra.db.raw.prepare(`SELECT reported_key FROM chat_task_receipts WHERE plan_id IN
      (SELECT p.plan_id FROM task_plans p JOIN start_run_operations o ON p.launch_operation_id=o.operation_id WHERE o.run_id=?)`).get(runId)
    expect(readReceipt()?.reported_key).toBeNull()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.notices).toHaveLength(1)
    const notice = test.notices[0]!.message
    expect(notice.source).toMatchObject({ kind: 'plugin:dsh-orchestra', form: 'notice', final: true,
      summary: expect.stringContaining('已停止') })
    expect(notice.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')).toContain('已停止')
    await human.admit(notice, false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readReceipt()?.reported_key).toBe('delivered:terminal:cancelled')

    await vi.advanceTimersByTimeAsync(4_000)
    expect(test.notices).toHaveLength(1)
    expect(test.notices[0]!.message.id).toBe(notice.id)
    expect(readReceipt()?.reported_key).toBe('delivered:terminal:cancelled')
  } finally { await test.close(); vi.useRealTimers() }
})

it('exposes exact artifact read arguments to the model and persists every original result link beside its summary', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  const original = test.planner.getMockImplementation()!
  const names = ['AIHOT 原始事实表', 'B站 原始事实表', '最终完整简报']
  const bodies = names.map((name, index) => '# ' + name + '\n\n' + ('逐条核验资料' + index + '。\n').repeat(1500) + '\n原始成果末尾-' + index)
  test.planner.mockImplementation(async input => ({ ...await original(input), deliverables: names.map(title => ({
    title, node_id: 'draft', goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' as const },
  })) }))
  try {
    const human = test.session('work', 'results-parent')
    await human.admit(user('/orchestra 汇总最近24小时新闻并输出简报'))
    const { run_id: runId } = await human.call()
    const { db } = test.services.get('results-parent')!.orchestra
    const node = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='draft'")
      .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
    const plan = db.raw.prepare('SELECT plan_id,content_hash FROM task_plans LIMIT 1').get() as { plan_id: string; content_hash: string }
    const published = bodies.map((body, index) => registerRunArtifact(db, {
      ...textTarget(plan.plan_id, plan.content_hash, index, node), runId, nodeRunId: node.node_run_id, bytes: Buffer.from(body),
    }))
    const now = new Date().toISOString()
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET status='done' WHERE run_id=?", [runId])
      tx.run("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?", [now, runId])
      applyRunAcceptance(tx, runId, now)
    })
    await vi.advanceTimersByTimeAsync(4000)
    const notice = test.notices[0]!.message
    const links = (notice.source as unknown as { artifacts: ChatArtifactLink[] }).artifacts
    expect(links.map(item => item.title)).toEqual(names)
    expect(links.map(item => item.fileName)).toEqual(['会话正文-1.md', '会话正文-2.md', '会话正文-3.md'])
    expect(links.every(item => item.location.sessionId === 'results-parent' && item.location.runId === runId)).toBe(true)
    expect(JSON.stringify(links)).not.toMatch(/http:|token|secret/u)
    expect(JSON.stringify(notice.content)).not.toContain('原始成果末尾-2')
    await human.admit(notice, false)
    const modelContent = await human.render({ action: 'status' })
    const reference = JSON.parse((modelContent.at(-1) as { text: string }).text) as { run_id: string; artifacts: Array<{
      artifact_id: string; truncated: boolean; read: { action: string; run_id: string; artifact_id: string }
    }> }
    expect(reference.run_id).toBe(runId)
    for (const [index, item] of published.entries()) {
      const exact = reference.artifacts.find(file => file.artifact_id === item.artifact_id)!
      expect(exact.read).toEqual({ action: 'artifact', run_id: runId, artifact_id: item.artifact_id })
      expect(exact.truncated).toBe(true)
      const full = await human.render(exact.read)
      expect((full[1] as { text: string }).text).toBe(bodies[index])
      expect((full[1] as { text: string }).text.endsWith('原始成果末尾-' + index)).toBe(true)
    }
    const status = await human.call({ action: 'status' })
    expect(status.artifact_links).toEqual(links)
    await expect(human.call({ action: 'artifact', task_title: '另一个任务', file_name: '会话正文-1.md' }))
      .resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await expect(human.call({ action: 'artifact', task_title: status.title, file_name: '会话正文-1.md' }))
      .resolves.toMatchObject({ text: bodies[0], truncated: false })
    await expect(human.call({ action: 'artifact', run_id: runId, task_title: status.title, artifact_id: published[0]!.artifact_id }))
      .resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID' })
  } finally { await test.close(); vi.useRealTimers() }
})

it('T07: a later request reads only the named third original and starts no second task', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture({ routing: { enabled: true }, interpret: input => input.current.text.includes('系统风险检查报告')
    ? { kind: 'task', relation: 'new', timing: 'immediate', quote: input.current.text,
      constraints: [
        { id: 'offline', kind: 'no_network', source_message_id: input.current.message_id, quote: '不得联网' },
        { id: 'no-read', kind: 'no_workspace_read', source_message_id: input.current.message_id, quote: '不得读取工作区文件' },
        { id: 'no-write', kind: 'no_workspace_files', source_message_id: input.current.message_id, quote: '不得写入工作区文件' },
        { id: 'chat-only', kind: 'chat_only', source_message_id: input.current.message_id,
          quote: '只给我简短总结和以报告标题为文字的完整原件链接，不要贴出正文' },
      ], missing: [] }
    : { kind: 'conversation' } })
  const originalPlan = test.planner.getMockImplementation()!
  const names = ['系统风险检查报告', '执行可靠性检查报告', '用户体验检查报告']
  const endings = ['风险检查结束标记-甲', '可靠性检查结束标记-乙', '用户体验检查结束标记-丙']
  const bodies = names.map((name, index) => '# ' + name + '\n\n'
    + Array.from({ length: 70 }, (_, item) => '第' + (item + 1) + '项检查：核对完整内容与原始证据，确认没有遗漏。').join('\n')
    + '\n' + endings[index])
  expect(bodies.every(body => body.length >= 1500)).toBe(true)
  let restoreReadSpy = () => {}
  const originalPrepare = DatabaseSync.prototype.prepare
  const contentReadIds: string[] = []
  test.planner.mockImplementation(async input => ({ ...await originalPlan(input), deliverables: names.map(title => ({
    title, node_id: 'draft', goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' as const },
  })) }))
  try {
    const human = test.session('work', 't07-originals')
    const taskCountBefore = test.planner.mock.calls.length
    await human.admit(user('请生成以下三份新报告：\n1.《系统风险检查报告》\n2.《执行可靠性检查报告》\n3.《用户体验检查报告》\n'
      + '不得联网，不得读取工作区文件，不得写入工作区文件；允许内部登记原件。'
      + '只给我简短总结和以报告标题为文字的完整原件链接，不要贴出正文。'))
    const started = await human.call()
    expect(started).toMatchObject({ state: 'started' })
    expect(test.planner.mock.calls[0]?.[0].requirements_contract).toMatchObject({ start_policy: 'immediate', constraints: [
      { kind: 'no_network' }, { kind: 'no_workspace_read' }, { kind: 'no_workspace_files' }, { kind: 'chat_only' },
    ] })
    const { run_id: runId } = started
    const { db } = test.services.get('t07-originals')!.orchestra
    const node = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='draft'")
      .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
    const plan = db.raw.prepare('SELECT plan_id,content_hash FROM task_plans LIMIT 1').get() as { plan_id: string; content_hash: string }
    const published = bodies.map((body, index) => registerRunArtifact(db, {
      ...textTarget(plan.plan_id, plan.content_hash, index, node), runId, nodeRunId: node.node_run_id, bytes: Buffer.from(body),
    }))
    const now = new Date().toISOString()
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET status='done' WHERE run_id=?", [runId])
      tx.run("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?", [now, runId])
      applyRunAcceptance(tx, runId, now)
    })
    const readSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(originalPrepare, this, [sql])
      if (sql === 'SELECT bytes FROM artifact_contents WHERE artifact_id = ?') {
        const originalGet = statement.get.bind(statement)
        Object.defineProperty(statement, 'get', { configurable: true, value: (...parameters: unknown[]) => {
          contentReadIds.push(String(parameters[0]))
          return Reflect.apply(originalGet, statement, parameters)
        } })
      }
      return statement
    })
    restoreReadSpy = () => readSpy.mockRestore()
    await vi.advanceTimersByTimeAsync(4000)
    const notice = test.notices[0]!.message
    const links = (notice.source as unknown as { artifacts: ChatArtifactLink[] }).artifacts
    expect(contentReadIds).toEqual([])
    expect(links.map(item => item.title)).toEqual(names)
    expect(links.every(item => item.location.runId === runId && item.location.sessionId === 't07-originals')).toBe(true)
    expect(JSON.stringify(notice.content)).not.toContain(endings[2])
    await human.admit(notice, false)
    expect(links.map(item => item.fileName)).toEqual(['会话正文-1.md', '会话正文-2.md', '会话正文-3.md'])
    const explanationOnly = '只解释这三份报告名称代表什么，不要创建任务。'
    const discussion = user(explanationOnly)
    expect(await human.admit(discussion)).toEqual({ kind: 'enter', messages: [discussion] })
    expect(test.planner.mock.calls.length - taskCountBefore).toBe(1)
    expect(count(test.services.get('t07-originals')!, 'runs')).toBe(1)
    // The follow-up cites only the third original. It must not be reclassified as work.
    const followup = '请读取刚才第三份报告的完整原件，告诉我最后一条检查事项和末尾标记。不要重新生成报告，也不需要重新读取其他两份报告。'
    const taskPlansBefore = count(test.services.get('t07-originals')!, 'task_plans')
    const runsBefore = count(test.services.get('t07-originals')!, 'runs')
    const toolCalls = vi.spyOn(human, 'call')
    const turn = await human.admit(user(followup))
    if (turn.kind !== 'enter') throw new Error('Expected the original follow-up to enter the native chat turn')
    const instruction = turn.messages.find(message => (message.source as { form?: string }).form === 'report_instruction')
    expect(instruction).toBeDefined()
    const instructionText = instruction!.content.find(block => block.type === 'text')!.text
    const payload = JSON.parse(instructionText.slice(instructionText.indexOf('{'), instructionText.lastIndexOf('}') + 1))
    expect(payload).toEqual({ action: 'artifact', run_id: runId, artifact_id: links[2]!.location.artifactId })
    expect(links.find(link => link.location.artifactId === payload.artifact_id)?.title).toBe('用户体验检查报告')
    const onlyRequestedOriginal = await human.call(payload)
    expect(contentReadIds).toEqual([links[2]!.location.artifactId])
    expect(onlyRequestedOriginal.text).toBe(bodies[2])
    expect(onlyRequestedOriginal.text).toContain('第70项检查')
    expect(onlyRequestedOriginal.text.endsWith(endings[2])).toBe(true)
    const artifactToolCalls = toolCalls.mock.calls.flatMap(([call]) => call && 'action' in call && call.action === 'artifact' ? [call] : [])
    expect(artifactToolCalls).toHaveLength(1)
    expect(artifactToolCalls[0]).toEqual({
      action: 'artifact', run_id: runId, artifact_id: links[2]!.location.artifactId,
    })
    expect(await human.call({ action: 'artifact', run_id: runId, artifact_id: links[0]!.location.artifactId }))
      .toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await expect(human.call(payload)).resolves.toMatchObject({ state: 'error', code: 'RESOLUTION_NOT_AVAILABLE' })
    expect(contentReadIds).toEqual([links[2]!.location.artifactId])
    expect(count(test.services.get('t07-originals')!, 'task_plans')).toBe(taskPlansBefore)
    expect(count(test.services.get('t07-originals')!, 'runs')).toBe(runsBefore)
    expect(test.planner.mock.calls.length - taskCountBefore).toBe(1)
  } finally { restoreReadSpy(); await test.close(); vi.useRealTimers() }
})

it('T07: reads each explicitly named result once and leaves ambiguous or missing selections unread', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const names = ['系统风险检查报告', '执行可靠性检查报告', '用户体验检查报告']
  const endings = ['末尾风险标记', '末尾可靠性标记', '末尾体验标记']
  const bodies = names.map((name, index) => '# ' + name + '\n\n'
    + Array.from({ length: 50 }, (_, item) => '第' + (item + 1) + '项核验：读取已登记的样例事实并核对限制。').join('\n')
    + '\n' + endings[index])
  const test = await fixture({ routing: { enabled: true }, interpret: input => input.current.text.includes('T07 三份报告')
    ? { kind: 'task', relation: 'new', timing: 'immediate', quote: input.current.text, constraints: [], missing: [] }
    : { kind: 'conversation' } })
  const originalPlan = test.planner.getMockImplementation()!
  test.planner.mockImplementation(async input => ({ ...await originalPlan(input), deliverables: names.map(title => ({
    title, node_id: 'draft', goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' as const },
  })) }))
  let restoreReadSpy = () => {}
  try {
    const human = test.session('work', 't07-multi-read')
    const initialRuns = 0
    await human.admit(user('请完成 T07 三份报告，并只给我简短总结和每份报告标题的原件链接，不要贴出正文。'))
    const started = await human.call()
    expect(started).toMatchObject({ state: 'started' })
    const runId = started.run_id
    const { db } = test.services.get('t07-multi-read')!.orchestra
    const node = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='draft'")
      .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
    const plan = db.raw.prepare('SELECT plan_id,content_hash FROM task_plans LIMIT 1').get() as { plan_id: string; content_hash: string }
    const published = bodies.map((body, index) => registerRunArtifact(db, {
      ...textTarget(plan.plan_id, plan.content_hash, index, node), runId, nodeRunId: node.node_run_id, bytes: Buffer.from(body),
    }))
    const now = new Date().toISOString()
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET status='done' WHERE run_id=?", [runId])
      tx.run("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?", [now, runId])
      applyRunAcceptance(tx, runId, now)
    })
    const originalPrepare = DatabaseSync.prototype.prepare
    const contentReadIds: string[] = []
    const readSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(originalPrepare, this, [sql])
      if (sql === 'SELECT bytes FROM artifact_contents WHERE artifact_id = ?') {
        const originalGet = statement.get.bind(statement)
        Object.defineProperty(statement, 'get', { configurable: true, value: (...parameters: unknown[]) => {
          contentReadIds.push(String(parameters[0]))
          return Reflect.apply(originalGet, statement, parameters)
        } })
      }
      return statement
    })
    restoreReadSpy = () => readSpy.mockRestore()
    await vi.advanceTimersByTimeAsync(4000)
    const notice = test.notices[0]!.message
    const links = (notice.source as unknown as { artifacts: ChatArtifactLink[] }).artifacts
    expect(links.map(link => link.title)).toEqual(names)
    expect(contentReadIds).toEqual([])
    await human.admit(notice, false)

    const explicit = '请读取刚才《执行可靠性检查报告》和《用户体验检查报告》的完整原件。'
    const toolCalls = vi.spyOn(human, 'call')
    const multiTurn = await human.admit(user(explicit))
    if (multiTurn.kind !== 'enter') throw new Error('Expected an explicit multi-result read turn')
    const instruction = multiTurn.messages.find(message => (message.source as { form?: string }).form === 'report_instruction')!
    const instructionText = instruction.content.find(block => block.type === 'text')!.text
    const requests = instructionText.split('\n').flatMap(line => line.startsWith('{') ? [JSON.parse(line)] : [])
    expect(requests).toEqual([
      { action: 'artifact', run_id: runId, artifact_id: links[1]!.location.artifactId },
      { action: 'artifact', run_id: runId, artifact_id: links[2]!.location.artifactId },
    ])
    for (const [index, request] of requests.entries()) {
      const outcome = await human.call(request)
      expect(outcome.text).toBe(bodies[index + 1])
      expect(outcome.text.endsWith(endings[index + 1]!)).toBe(true)
    }
    expect(contentReadIds).toEqual([links[1]!.location.artifactId, links[2]!.location.artifactId])
    expect(toolCalls.mock.calls.filter(([call]) => call && 'action' in call && call.action === 'artifact')).toHaveLength(2)

    for (const ambiguous of ['请读取刚才那份报告的完整原件。', '请读取刚才第4份报告的完整原件。']) {
      const turn = await human.admit(user(ambiguous))
      if (turn.kind !== 'enter') throw new Error('Expected an unresolved read request to stay in chat')
      const fallback = turn.messages.find(message => (message.source as { form?: string }).form === 'report_instruction')
      expect(fallback).toBeDefined()
      expect(fallback!.content[0]).toMatchObject({ type: 'text', text: expect.not.stringContaining('"action":"artifact"') })
      await expect(human.call({ action: 'start' })).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    }
    expect(contentReadIds).toEqual([links[1]!.location.artifactId, links[2]!.location.artifactId])
    expect(count(test.services.get('t07-multi-read')!, 'runs')).toBe(initialRuns + 1)
    expect(test.planner).toHaveBeenCalledTimes(1)
  } finally { restoreReadSpy(); await test.close(); vi.useRealTimers() }
})

it('T07: restores legacy file-artifact titles and order, selects the third deliverable, and rejects a stale evidence hash', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture({ routing: { enabled: true } })
  const originalPlan = test.planner.getMockImplementation()!
  const names = ['系统风险检查报告', '执行可靠性检查报告', '用户体验检查报告']
  const fileNames = ['risk-audit-v1.md', 'reliability-data-v2.txt', 'experience-review-final.csv']
  const bodies = names.map((name, index) => `正式交付：${name}\n文件内容第 ${index + 1} 份。`)
  test.planner.mockImplementation(async input => ({ ...await originalPlan(input), deliverables: names.map((title, index) => ({
    title, node_id: 'draft', goal_ids: ['goal'],
    acceptance: { kind: 'artifact' as const, file_name: fileNames[index]!, minimum_bytes: 8 },
  })) }))
  try {
    const human = test.session('work', 'legacy-file-results')
    await human.admit(user('/orchestra 按顺序交付三份文件成果：1.《系统风险检查报告》；2.《执行可靠性检查报告》；3.《用户体验检查报告》。文件名与正式交付名不同。只给简短总结和以正式名称为文字的原件链接，不要贴正文。'))
    const started = await human.call()
    expect(started, JSON.stringify(started)).toMatchObject({ state: 'started' })
    const runId = started.run_id
    const { db } = test.services.get('legacy-file-results')!.orchestra
    const node = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='draft'")
      .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
    const plan = db.raw.prepare('SELECT plan_id,content_hash FROM task_plans LIMIT 1').get() as { plan_id: string; content_hash: string }
    const artifacts = bodies.map((body, index) => registerRunArtifact(db, { artifactId: uuidv7(), runId,
      fileName: fileNames[index]!, bytes: Buffer.from(body), nodeRunId: node.node_run_id }))
    const now = new Date().toISOString()
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET status='done' WHERE run_id=?", [runId])
      tx.run("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?", [now, runId])
      applyRunAcceptance(tx, runId, now)
      for (let index = 0; index < names.length; index++) {
        const key = `draft|${names[index]}`
        const row = tx.get<{ evidence_json: string }>(`SELECT evidence_json FROM run_acceptance_results
          WHERE run_id=? AND plan_id=? AND content_hash=? AND deliverable_key=?`, [runId, plan.plan_id, plan.content_hash, key])!
        const saved = JSON.parse(row.evidence_json) as { evidence: Record<string, unknown>; history: unknown[] }
        const legacyEvidence = { summary: 'passed', file_name: fileNames[index], minimum_bytes: 8, matches: 1, owned: 1,
          artifact_id: artifacts[index]!.artifact_id, sha256: index === 0 ? '0'.repeat(64) : artifacts[index]!.sha256,
          bytes: bodies[index]!.length, node_run_id: node.node_run_id, node_id: 'draft', retain_until: null, expired: false,
          native_text_format: null, capability_scope: 'artifact_registered_only' }
        expect(legacyEvidence).not.toHaveProperty('title')
        expect(legacyEvidence).not.toHaveProperty('item_index')
        tx.run('UPDATE run_acceptance_results SET evidence_json=? WHERE run_id=? AND plan_id=? AND content_hash=? AND deliverable_key=?',
          [JSON.stringify({ ...saved, evidence: legacyEvidence }), runId, plan.plan_id, plan.content_hash, key])
      }
    })
    await vi.advanceTimersByTimeAsync(4000)
    const notice = test.notices[0]!.message
    const links = (notice.source as unknown as { artifacts: ChatArtifactLink[] }).artifacts
    expect(links.map(link => link.title)).toEqual(names.slice(1))
    expect(links.map(link => link.fileName)).toEqual(fileNames.slice(1))
    expect(links.map(link => link.location.sha256)).toEqual(artifacts.slice(1).map(item => item.sha256))
    expect(links.some(link => link.location.artifactId === artifacts[0]!.artifact_id)).toBe(false)
    await human.admit(notice, false)

    const followup = user('请读取刚才第三份报告的完整原件，告诉我里面的正式交付名。')
    const turn = await human.admit(followup)
    if (turn.kind !== 'enter') throw new Error('Expected third-file read request to remain in the native chat turn')
    const instruction = turn.messages.find(message => (message.source as { form?: string }).form === 'report_instruction')
    expect(instruction).toBeDefined()
    const instructionText = instruction!.content.find(block => block.type === 'text')!.text
    const payload = JSON.parse(instructionText.slice(instructionText.indexOf('{'), instructionText.lastIndexOf('}') + 1))
    expect(payload).toEqual({ action: 'artifact', run_id: runId, artifact_id: artifacts[2]!.artifact_id })
    const result = await human.call(payload)
    expect(result.text).toBe(bodies[2])
  } finally { await test.close(); vi.useRealTimers() }
})

it.each([false, true])('普通工作区文件读取仍交给宿主；即使有同名历史原件也不误选（历史原件：%s）', async hasPriorArtifact => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const routing = { enabled: true }
  const test = await fixture({ routing, ...(hasPriorArtifact ? { reportRequirements: ['README.md'] } : {}) })
  try {
    const human = test.session('work', 'workspace-readme-' + hasPriorArtifact)
    if (hasPriorArtifact) {
      await human.admit(user('/orchestra 整理 README.md 并交付同名原件'))
      const { run_id: runId } = await human.call()
      const { db } = test.services.get('workspace-readme-true')!.orchestra
      const node = db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='draft'")
        .get(runId) as { node_run_id: string; attempt: number; action_generation: number }
      const artifact = registerRunArtifact(db, { artifactId: 'orchestra-readme', runId, fileName: 'README.md',
        bytes: Buffer.from('ORCHESTRA-REGISTERED-README'), nodeRunId: node.node_run_id })
      const now = new Date().toISOString()
      withTx(db, tx => {
        recordArtifactPublication(tx, test.secret, node, { run_id: runId, node_id: 'draft' }, 'README.md', artifact)
        tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?", [node.node_run_id])
        tx.run("UPDATE runs SET status='succeeded',ended_at=? WHERE run_id=?", [now, runId])
        applyRunAcceptance(tx, runId, now)
      })
      await vi.advanceTimersByTimeAsync(4000)
      const notice = test.notices.find(item => item.message.source &&
        (item.message.source as { summary?: string }).summary?.includes('README.md'))
      expect(notice).toBeDefined()
      await human.admit(notice!.message, false)
      expect((await human.call({ action: 'status' })).run_id).toBe(runId)
      expect((await human.call({ action: 'artifact', run_id: runId, artifact_id: artifact.artifact_id })).text)
        .toBe('ORCHESTRA-REGISTERED-README')
    }

    routing.enabled = false
    await writeFile(join(test.directory, 'README.md'), 'HOST-WORKSPACE-README-CONTENT')
    const message = user('请读取上次提到的工作区文件 README.md')
    const beforePlans = test.planner.mock.calls.length
    const beforeRuns = hasPriorArtifact ? count(test.services.get('workspace-readme-true')!, 'runs') : 0
    const turn = await human.admit(message)
    expect(turn).toEqual({ kind: 'enter', messages: [message] })
    if (turn.kind !== 'enter') throw new Error('Host workspace read should remain in the current turn')
    expect(turn.messages.some(item => (item.source as { form?: string }).form === 'report_instruction')).toBe(false)
    expect(human.checkTool('read')).toBeUndefined()
    expect(test.planner).toHaveBeenCalledTimes(beforePlans)
    expect(test.services.size).toBe(hasPriorArtifact ? 1 : 0)
    if (hasPriorArtifact) expect(count(test.services.get('workspace-readme-true')!, 'runs')).toBe(beforeRuns)
  } finally { await test.close(); vi.useRealTimers() }
})

it('自动接管开启时，明确读取本地 README.md 的普通请求由宿主继续处理', async () => {
  const text = '请读取上次提到的工作区文件 README.md'
  const interpret = vi.fn((input: SemanticInput) => {
    expect(input.current.text).toBe(text)
    return { kind: 'conversation' }
  })
  const test = await fixture({ routing: { enabled: true }, interpret })
  try {
    const human = test.session('work', 'workspace-readme-auto-on')
    await writeFile(join(test.directory, 'README.md'), 'HOST-WORKSPACE-README-CONTENT')
    const message = user(text)
    const turn = await human.admit(message)
    expect(turn).toEqual({ kind: 'enter', messages: [message] })
    if (turn.kind !== 'enter') throw new Error('Host workspace read should remain in the current turn')
    expect(turn.messages.some(item => (item.source as { form?: string }).form === 'report_instruction')).toBe(false)
    expect(human.checkTool('read')).toBeUndefined()
    expect(test.interpret).not.toHaveBeenCalled()
    expect(test.planner).not.toHaveBeenCalled()
    expect(test.serve).not.toHaveBeenCalled()
  } finally { await test.close() }
})

it('原生入口在规划失败且 Agent 退出后，用同一 SQLite 草稿恢复原始限制', async () => {
  const interpreted: SemanticInput[] = []
  const interpret = vi.fn((input: SemanticInput) => {
    interpreted.push(structuredClone(input))
    if (input.current.text.includes('先别执行')) return { kind: 'task', relation: input.draft ? 'continue' : 'new',
      timing: 'held', quote: input.current.text, constraints: [{ id: 'offline', kind: 'no_network',
        source_message_id: input.current.message_id, quote: '不联网' }], missing: [],
      ...(input.draft && { draft_revision: input.draft.revision, continuation: 'supply' as const }) }
    if (input.draft) return { kind: 'task', relation: 'continue', timing: 'immediate', quote: input.current.text,
      constraints: input.draft.constraints, missing: [], draft_revision: input.draft.revision, continuation: 'resume' }
    return { kind: 'conversation' }
  })
  const test = await fixture({ routing: { enabled: true }, interpret,
    draftCheckpoints: profile => createSemanticDraftCheckpoints(profile, async identity => 'fixture-checkpoint-key:' + identity) })
  const sessionId = 'held-planning-restart'
  try {
    const originalSession = test.session('work', sessionId)
    await originalSession.admit(user('请整理月报，不联网，先别执行'))
    await expect(originalSession.call()).resolves.toMatchObject({ state: 'task_held' })
    expect(test.services.size).toBe(0)

    test.plannerUnavailable(true)
    await originalSession.admit(user('现在开始执行月报'))
    await expect(originalSession.call()).resolves.toMatchObject({ state: 'error' })
    const failedService = test.services.get(sessionId)!
    expect(count(failedService, 'task_plans')).toBe(0)
    expect(count(failedService, 'runs')).toBe(0)
    expect(interpreted[1]).toMatchObject({ draft: { sources: [{ text: '请整理月报，不联网，先别执行' }],
      constraints: [{ kind: 'no_network', quote: '不联网' }] } })

    await test.restart(sessionId)
    test.plannerUnavailable(false)
    // A new Agent instance with the same authenticated workspace/session simulates restart.
    const restartedSession = test.session('work', sessionId)
    await restartedSession.admit(user('请继续刚才的月报'))
    const launched = await restartedSession.call()
    expect(launched).toMatchObject({ state: 'started' })
    expect(interpreted[2]).toMatchObject({ draft: { sources: [
      { text: '请整理月报，不联网，先别执行' }, { text: '现在开始执行月报' },
    ], constraints: [{ kind: 'no_network', quote: '不联网' }] } })
    const restartedService = test.services.get(sessionId)!
    expect(count(restartedService, 'task_plans')).toBe(1)
    expect(count(restartedService, 'runs')).toBe(1)
    expect(test.planner).toHaveBeenCalledTimes(2)
  } finally { await test.close() }
})

it('丢失已写计划的回执后，新 Agent 续接只返回原计划与运行', async () => {
  let loseLaunchReceipt = true
  let launchAcknowledgements = 0
  const test = await fixture({ routing: { enabled: true }, interpret: input => {
    if (input.current.text.includes('先别执行')) return { kind: 'task', relation: 'new', timing: 'held', quote: input.current.text,
      constraints: [{ id: 'offline', kind: 'no_network', source_message_id: input.current.message_id, quote: '不联网' }], missing: [] }
    if (input.draft) return { kind: 'task', relation: 'continue', timing: 'immediate', quote: input.current.text,
      constraints: input.draft.constraints, missing: [], draft_revision: input.draft.revision, continuation: 'resume' }
    return { kind: 'conversation' }
  }, draftCheckpoints: profile => {
    const checkpoints = createSemanticDraftCheckpoints(profile, async identity => 'fixture-checkpoint-key:' + identity)
    return { read: identity => checkpoints.read(identity), write: async (identity, next, previous, assertCurrent) => {
      if (!next && previous?.launchOrigin) {
        launchAcknowledgements++
        if (loseLaunchReceipt) {
          loseLaunchReceipt = false
          throw new Error('synthetic lost launch acknowledgement')
        }
      }
      await checkpoints.write(identity, next, previous, assertCurrent)
    } }
  } })
  const sessionId = 'held-plan-receipt-replay'
  try {
    const originalSession = test.session('work', sessionId)
    await originalSession.admit(user('请整理月报，不联网，先别执行'))
    await expect(originalSession.call()).resolves.toMatchObject({ state: 'task_held' })
    await originalSession.admit(user('现在开始执行月报'))
    // The plan/run are durable even though checkpoint cleanup fails. Drop the
    // returned receipt as if the host reply was lost, then recover after restart.
    const firstReceipt = await originalSession.call()
    expect(firstReceipt).toMatchObject({ state: 'started' })
    const service = test.services.get(sessionId)!
    const planCount = count(service, 'task_plans')
    const runCount = count(service, 'runs')
    expect(planCount).toBe(1)
    expect(runCount).toBe(1)
    expect(launchAcknowledgements).toBe(1)
    const firstRun = service.orchestra.db.raw.prepare('SELECT run_id FROM runs LIMIT 1').get()?.run_id
    expect(firstRun).toBeDefined()

    await test.restart(sessionId)
    test.plannerUnavailable(true)
    const restartedSession = test.session('work', sessionId)
    await restartedSession.admit(user('请继续刚才的月报'))
    const replay = await restartedSession.call()
    expect(replay).toMatchObject({ state: 'started', run_id: firstRun })
    expect(test.interpret).toHaveBeenLastCalledWith(expect.objectContaining({ current: expect.objectContaining({
      text: '请继续刚才的月报',
    }), draft: expect.objectContaining({
      sources: expect.arrayContaining([
        expect.objectContaining({ text: '请整理月报，不联网，先别执行' }),
        expect.objectContaining({ text: '现在开始执行月报' }),
      ]),
      constraints: expect.arrayContaining([expect.objectContaining({ kind: 'no_network', quote: '不联网' })]),
    }) }))
    const restartedService = test.services.get(sessionId)!
    expect(count(restartedService, 'task_plans')).toBe(planCount)
    expect(count(restartedService, 'runs')).toBe(runCount)
    expect(test.planner).toHaveBeenCalledTimes(1)
  } finally { await test.close() }
})


it('uses the configured command only, preserves typed admission and blocks a late host command collision', async () => {
  const test = await fixture()
  try {
    const settings = createNativeCommandSettings(test.directory)
    settings.save({ name: 'go', expected_revision: 0 })
    const human = test.session('work', 'custom-command')
    const old = user('/orchestra 整理报告')
    expect(await human.admit(old)).toEqual({ kind: 'enter', messages: [old] })
    expect(test.interpret).not.toHaveBeenCalled()
    expect(test.services.size).toBe(0)
    const usage = await human.admit(user('/go'))
    expect(JSON.stringify(usage)).toContain('/go 任务内容')
    expect(JSON.stringify(usage)).not.toContain('/orchestra 任务内容')
    test.commandNames.push('go')
    const blocked = await human.admit(user('/go 整理会议事项并交付清单'))
    expect(JSON.stringify(blocked)).toContain('与已有命令或技能冲突')
    expect(test.services.size).toBe(0)
    test.commandNames.length = 0
    await human.admit(user('/go 整理会议事项并交付清单'))
    expect(test.interpret).toHaveBeenCalledWith(expect.objectContaining({ explicit: true, current: expect.objectContaining({ text: '整理会议事项并交付清单' }) }))
    expect(await human.call()).toMatchObject({ state: 'started' })
  } finally { await test.close() }
})

it('a failed source notice cannot starve another run in the same conversation', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    await human.admit(user('/orchestra 整理第一批合同'))
    const first = await human.call()
    await human.admit(user('/orchestra 整理第二批合同'))
    const second = await human.call()
    const { db } = test.services.get('parent')!.orchestra
    withTx(db, tx => tx.run("UPDATE runs SET status='failed',ended_at=? WHERE run_id IN (?,?)", [new Date().toISOString(), first.run_id, second.run_id]))
    const original = human.agent.steer.bind(human.agent)
    const spy = vi.spyOn(human.agent, 'steer').mockImplementationOnce(() => { throw new Error('first notice unavailable') })
    spy.mockImplementation(original)
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(1)
    expect(test.notices[0]!.message.source).toMatchObject({ summary: expect.stringContaining(second.title) })
    await human.admit(test.notices[0]!.message, false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]!.message.source).toMatchObject({ summary: expect.stringContaining(first.title) })
    await human.admit(test.notices[1]!.message, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(db.raw.prepare('SELECT reported_key FROM chat_task_receipts').all()).toEqual([
      { reported_key: 'delivered:terminal:failed' }, { reported_key: 'delivered:terminal:failed' },
    ])
    expect(test.notices).toHaveLength(2)
  } finally { await test.close(); vi.useRealTimers() }
})

it('reports the actual pre-admission failure immediately and bounds tool retries without launching a run', async () => {
  const test = await fixture({ interpret: () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD') } })
  try {
    const human = test.session('work', 'failed-admission')
    const request = user('/orchestra 整理办公事项并交付报告')
    const admission = await human.admit(request)
    expect(admission).toMatchObject({ kind: 'enter', messages: [request, expect.objectContaining({
      source: { kind: 'plugin:dsh-orchestra', form: 'notice', final: true, summary: expect.stringContaining('响应中断') },
      content: [{ type: 'text', text: expect.stringContaining('本次未启动新任务') }],
    })] })
    const status = await human.invoke({ action: 'status', task_title: '这次任务' })
    const failed = JSON.parse(status.text)
    expect(failed).toMatchObject({ state: 'error', code: 'SERVICE_UNAVAILABLE', reason: 'semantic_stream_failed' })
    expect(failed).not.toHaveProperty('run_id')
    expect(status.summary).toContain('不要调用任何工具')
    expect(status.summary).not.toContain('SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD')
    expect(human.checkTool('read')).toContain('尚未启动任何新运行')
    const report = await human.admitMany([], false, false)
    expect(report).toMatchObject({ kind: 'enter', messages: [expect.objectContaining({
      content: [{ type: 'text', text: expect.stringContaining('只有新的真人消息才能重试') }],
    })] })
    // Wrong arguments cannot start a task, query an old run, or obscure the real failure.
    expect(await human.call({ action: 'start', task_title: '新标题', goal: '不要执行' })).toEqual(failed)
    expect(await human.call({ action: 'status', run_id: 'unrelated-run' })).toEqual(failed)
    expect(await human.admitMany([], false, false)).toEqual({ kind: 'reject' })
    expect(test.interpret).toHaveBeenCalledTimes(1)
    expect(test.planner).not.toHaveBeenCalled()
    expect(test.serve).not.toHaveBeenCalled()
    // A new real human message is still allowed to retry, under the original contract.
    test.interpret.mockImplementation(chatSemanticFixture)
    await human.admit(user('/orchestra 整理办公事项并交付报告'))
    expect(await human.call()).toMatchObject({ state: 'started' })
    expect(count(test.services.get('failed-admission')!, 'runs')).toBe(1)
  } finally { await test.close() }
})

it('a failed-admission tool loop does not discard a new owner message queued in the same turn', async () => {
  const test = await fixture({ interpret: () => { throw new Error('synthetic unavailable') } })
  try {
    const human = test.session('work', 'failure-queue')
    await human.admit(user('/orchestra 整理一份办公事项报告'))
    await human.call({ action: 'status' })
    await human.admitMany([], false, false)
    await human.call({ action: 'status' })
    const fresh = user('/orchestra 整理另一份办公事项报告')
    const deferred = await human.admit(fresh, true, false)
    expect(deferred).toMatchObject({ kind: 'enter' })
    expect(human.nextTurn).toContainEqual(fresh)
    expect(test.planner).not.toHaveBeenCalled()
    test.interpret.mockImplementation(chatSemanticFixture)
    await human.admit(fresh, false)
    expect(await human.call()).toMatchObject({ state: 'started' })
    expect(count(test.services.get('failure-queue')!, 'runs')).toBe(1)
  } finally { await test.close() }
})
