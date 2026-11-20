import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { serveOrchestra, type serveDshOrchestra } from '../../src/index.ts'
import { decisionId, uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { installConfiguredLocalDshHost, localDshHostConfig } from '../../src/service/local-dsh-host.ts'
import { planningTimeoutDefaults } from '../../src/service/planning-settings.ts'

type Message = Parameters<Agent['followup']>[0]
type Definition = Parameters<Context['tools']['register']>[0]
type Activation = NonNullable<Parameters<Context['tools']['register']>[1]>
type Service = Awaited<ReturnType<typeof serveDshOrchestra>>

async function fixture(options: { profile?: string; version?: string; enabled?: false | 'desktop'; host?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-native-chat-'))
  const ctx = new Context()
  const agents = new Map<string, Agent>()
  const conversations = new Map<string, string[]>()
  const routes: string[] = []
  const notices: Array<{ sessionId: string; message: Message }> = []
  let tool: Definition | undefined
  let activation: Activation | undefined
  let prompt: ((context: { agent: Agent }) => string) | undefined
  let deny = false
  let badPlan = false
  let plannerUnavailable = false
  const secret = 'fixture-ledger-secret'
  const approval = vi.fn(async (_request: { agent: Agent; toolName: string; callId: string; reason: string; signal: AbortSignal }) =>
    deny ? 'rejected' : 'allowed-once')
  const services = new Map<string, Service>()
  const planner = vi.fn(async ({ goal, workflows }: Parameters<NonNullable<Parameters<typeof serveOrchestra>[0]['planning']>['propose']>[0]) => {
    if (plannerUnavailable) throw new Error('fake unavailable host')
    const workflow = workflows[0]!
    return {
      title: goal.slice(0, 40), workflow_id: workflow.workflowId, workflow_version: workflow.version,
      steps: [{ node_id: 'draft', description: '整理报告', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '整理文字' }],
      deliverables: [{ title: '报告', node_id: 'draft', goal_ids: ['goal'],
        acceptance: { kind: 'artifact', file_name: 'report.md', minimum_bytes: 8 } }],
      risks: badPlan ? [{ severity: 'high', description: '涉及影响', mitigation: '需要调整', node_id: 'draft' }] : [],
    }
  })
  const workflowGenerator = vi.fn(async () => ({
    name: '整理报告', nodes: [{ node_id: 'start', type: 'trigger' }, { node_id: 'draft', type: 'agent' }],
    edges: [{ from: 'start', to: 'draft' }],
  }))
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
  const controllerPackage = join(directory, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller')
  await mkdir(controllerPackage, { recursive: true })
  await writeFile(join(controllerPackage, 'package.json'), JSON.stringify({ version: options.version ?? '0.2.2-rc.5' }))
  ctx.provide('profileContext', { name: options.profile ?? 'desktop', installAnchor: join(directory, 'package.json') })
  ctx.provide('webServer', { host: options.host ?? '127.0.0.1' })
  ctx.provide('llm', {})
  ctx.provide('tools', { register(definition: Definition, options: Activation) { tool = definition; activation = options } })
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
  const serve = vi.fn< typeof serveDshOrchestra >(async ({ dbFile, dsh, asOfSeq, listEvents, listTasks, appendLedgerEvent }) => {
    const agent = dsh.parentForNode('fixture')!
    const service = await serveOrchestra({
      dbFile, secret, phase: 'S6', asOfSeq, listTasks, listEvents, appendLedgerEvent,
      planning: { propose: planner, workflowGenerator },
    })
    services.set(agent.session.id, service)
    return service
  })
  const plugin = ctx.plugin((host) => installConfiguredLocalDshHost(host, localDshHostConfig.parse({
    local: { enabled: options.enabled ?? 'desktop', dataDirectory: directory },
  }).local, serve))
  await plugin.await()
  if ((options.profile ?? 'desktop') === 'desktop' && options.version === undefined && options.enabled !== false) {
    await expect.poll(() => Boolean(tool)).toBe(true)
  }

  function session(workspace: string, sessionId: string, header: Record<string, unknown> = {}) {
    const events: Array<{ type: string; data: unknown }> = []
    const signal = new AbortController()
    let turn = 0
    const agent = {
      id: sessionId, status: 'running', model: { current: () => ({ provider: 'fixture', model: 'model' }) },
      session: { id: sessionId, header: { cwd: directory, ...header }, snapshotEvents: () => [...events] },
      followup(message: Message) {
        const recorded = structuredClone(message)
        events.push({ type: 'agent/inbox/spliced', data: { inserted: [recorded] } })
        notices.push({ sessionId, message: recorded })
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message: recorded })
      },
    } as unknown as Agent
    agents.set(sessionId, agent)
    conversations.set(workspace, [...conversations.get(workspace) ?? [], sessionId])
    async function admit(message: Message, newInbox = true, advance = true) {
      const dispatch = agentEvents(ctx, agent)
      if (newInbox) dispatch.emit('agent/inbox/inserted', { message })
      if (advance) turn++
      const claimed = structuredClone(message)
      await dispatch.waterfall('agent/pre-step', { messages: [claimed], turn, step: advance ? 0 : 1,
        signal: signal.signal, modelSelection: { provider: 'fixture', model: 'model' } },
      async () => ({ kind: 'enter', messages: [claimed] }))
      events.push({ type: 'user/message', data: claimed })
    }
    async function call(input: object = { action: 'start' }) {
      const execution = { agent, callId: 'call', signal: signal.signal } as Parameters<Definition['execute']>[1]
      return JSON.parse((await tool!.execute(input, execution) as { text: string }).text)
    }
    return { agent, admit, call, signal }
  }
  return { session, serve, services, planner, workflowGenerator, routes, approval, notices, registered: () => ({ activation: activation!, prompt: prompt! }),
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
    await human.admit(user('整理第二份办公室事项报告'))
    const oldRequest = human.call()
    await started
    settings.save({ operation_id: uuidv7(), expected_revision: 0, values: {
      ...planningTimeoutDefaults, task_seconds: 160, stage_seconds: 180, request_seconds: 200,
    } }, 'settings-owner', new Date().toISOString())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await oldRequest).toMatchObject({ state: 'error', code: 'OPERATION_TIMEOUT' })

    started = new Promise<void>((resolve) => { entered = resolve })
    test.planner.mockImplementationOnce(async (input) => {
      entered()
      await delay(135_000)
      return originalPlan(input)
    })
    await human.admit(user('整理第三份办公室事项报告'))
    const extendedRequest = human.call()
    await started
    await vi.advanceTimersByTimeAsync(135_000)
    expect(await extendedRequest).toMatchObject({ state: 'started' })

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
    await human.admit(user('整理第四份办公室事项报告'))
    const aggregate = human.call()
    await started
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await aggregate).toMatchObject({ state: 'error', code: 'OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(21_000)
    for (const table of ['tasks', 'workflows', 'task_plans', 'runs', 'chat_task_receipts'] as const) {
      expect(count(service, table)).toBe(2)
    }
  } finally {
    vi.useRealTimers()
    await test.close()
  }
})

it('binds ordinary native conversation, live owner input and one durable run per message', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const child = test.session('work', 'child', { origin: 'subagent', parentSession: 'parent' })
    const other = test.session('other', 'other')
    expect(test.routes).toHaveLength(1)
    expect(test.registered().prompt({ agent: human.agent })).toContain('orchestra_task')
    expect(test.registered().prompt({ agent: child.agent })).toBe('')
    const eligible = (agent: Agent) => test.registered().activation.when!({ agent, modelSelection: { provider: 'fixture', model: 'model' },
      signal: new AbortController().signal })
    expect(eligible(human.agent)).toBe(true)
    expect(eligible(child.agent)).toBe(false)
    await human.admit(user('你好'))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    await human.admit(user('什么是并发调度？'))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'CONFIRMATION_REQUIRED' })
    const assigned = user('整理一份办公室事项并交付 Markdown 报告')
    await human.admit(assigned, false)
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('把事项整理成报告', { source: { kind: 'user', rpcId: uuidv7(), principal: { kind: 'guest' } } }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(user('把事项整理成报告', { source: { kind: 'retry', rpcId: uuidv7() } }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await child.admit(assigned)
    await expect(child.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    expect(test.serve).not.toHaveBeenCalled()
    await human.admit(assigned)
    await expect(human.call({ action: 'start', goal: '替换原文', session_id: 'other' }))
      .resolves.toMatchObject({ state: 'error', code: 'PAYLOAD_SCHEMA_INVALID' })
    const [first, concurrent] = await Promise.all([human.call(), human.call()])
    expect(first).toMatchObject({ state: 'started', replayed: false })
    expect(concurrent).toEqual(first)
    expect(test.planner.mock.calls[0]?.[0].goal).toBe('整理一份办公室事项并交付 Markdown 报告')
    expect(test.approval).not.toHaveBeenCalled()
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: true })
    await human.admit(assigned)
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: true })
    await human.admit(user('整理一份办公室事项并交付 Markdown 报告', { source: assigned.source }))
    await expect(human.call()).resolves.toMatchObject({ run_id: first.run_id, replayed: true })
    await human.admit(user('换一个目标', { id: assigned.id }))
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'OPERATION_ID_CONFLICT' })
    await other.admit(user('查这个任务进度'))
    await expect(other.call({ action: 'status', run_id: first.run_id })).resolves.toMatchObject({ state: 'error', code: 'NOT_FOUND' })
    const service = test.services.get('parent')!
    expect(count(service, 'runs')).toBe(1)
    expect(count(service, 'task_plans')).toBe(1)
    expect(count(service, 'chat_task_receipts')).toBe(1)
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

it('keeps approval, planning failure and terminal results in the originating DSH session', async () => {
  const test = await fixture()
  try {
    const human = test.session('work', 'parent')
    const other = test.session('work', 'other')
    test.plannerUnavailable(true)
    await human.admit(user('请整理这些记录并交付报告'))
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
    await expect.poll(() => test.notices.find((entry) => entry.message.content.some((part) => part.type === 'text'
      && part.text.includes(decision))), { timeout: 5_000 }).toMatchObject({ sessionId: 'parent' })
    const notification = test.notices.find((entry) => entry.message.content.some((part) => part.type === 'text'
      && part.text.includes(decision)))!.message
    await other.admit(notification, false)
    await expect(other.call({ action: 'review', run_id: prepared.run_id, decision_id: decision }))
      .resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    await human.admit(notification, false)
    await expect(human.call()).resolves.toMatchObject({ state: 'error', code: 'FORBIDDEN' })
    test.deny(true)
    const review = { action: 'review', run_id: prepared.run_id, decision_id: decision }
    await expect(human.call(review)).resolves.toMatchObject({ state: 'approval_pending' })
    await expect(human.call(review)).resolves.toMatchObject({ state: 'approval_pending' })
    expect(test.approval).toHaveBeenCalledTimes(1)
    expect(db.raw.prepare('SELECT status, resolved_by FROM decisions WHERE decision_id = ?').get(decision))
      .toMatchObject({ status: 'pending', resolved_by: null })
    test.deny(false)
    await human.admit(user('请显示这次任务的审批卡'))
    await expect(human.call(review)).resolves.toMatchObject({ state: 'approved' })
    expect(test.approval).toHaveBeenCalledTimes(3)
    expect(test.approval).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agent: human.agent, toolName: 'orchestra_task', reason: expect.stringContaining('人工核对报告'),
    }))
    expect(test.approval).toHaveBeenNthCalledWith(3, expect.objectContaining({
      agent: human.agent, toolName: 'orchestra_task', reason: expect.stringMatching(/二次确认。.*人工核对报告.*有效至/u),
    }))
    expect(db.raw.prepare('SELECT status, resolved_by FROM decisions WHERE decision_id = ?').get(decision))
      .toMatchObject({ status: 'resolved', resolved_by: expect.stringMatching(/^local-dsh:/) })
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'failed', ended_at = ? WHERE run_id = ?", [new Date().toISOString(), prepared.run_id])
    })
    await expect.poll(() => test.notices.find((entry) => entry.message.content.some((part) => part.type === 'text'
      && part.text.includes('"terminal":true'))), { timeout: 5_000 }).toMatchObject({ sessionId: 'parent' })
    expect(test.notices.every((entry) => entry.sessionId === 'parent')).toBe(true)
    expect(count(service, 'runs')).toBe(1)
  } finally { await test.close() }
}, 16_000)

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
      expect(second.reason).toContain(`修订 1 内容指纹 ${contentHash}。`)
      expect(second.reason).toMatch(/有效至 .*Z。/u)
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
