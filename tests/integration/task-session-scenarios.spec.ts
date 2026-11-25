import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { serveDshOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { installNativeChat } from '../../src/service/chat-native.ts'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { executionApprovalReceipts } from '../../src/service/execution-approval-receipts.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'
import { PROJECT_CONTEXT_FILE } from '../../src/service/project-shared-context.ts'
import type { CoordinationItem } from '../../src/service/run-coordination.ts'
import type { SemanticInput } from '../../src/service/semantic-admission.ts'
import type { TaskPlanningOptions } from '../../src/service/task-planning.ts'

type Message = Parameters<Agent['followup']>[0]
type Definition = Parameters<Context['tools']['register']>[0]
type ToolExecution = Parameters<Definition['execute']>[1]
type PreStep = (step: { agent: unknown; modelSelection: typeof model; signal: AbortSignal },
  next: () => Promise<{ kind: 'enter'; messages: Message[] }>) => Promise<{ kind: 'enter'; messages: Message[] }>
type Reference = { artifact_id: string; artifact_hash: string }
type TaskInput = { task_goal: string; deliverables: Array<{ deliverable_index: number }>; requirements_contract: unknown }
type Worker = {
  task: TaskInput
  prompt: string
  upstream: Reference[]
  node: string
  tool<T>(name: string, input: Record<string, unknown>): Promise<T>
}
type Outcome = { outcome: 'completed' | 'blocked'; reason?: string; next_action?: string }
type Scenario = {
  title: string
  goal: string
  chatQuote: string
  steps: Array<{ id: string; title: string; after?: string[] }>
  work(worker: Worker): Promise<Outcome | void>
  approval?: string
  held?: readonly string[]
}
type PlanRequest = Parameters<TaskPlanningOptions['propose']>[0]
type WorkflowRequest = Parameters<NonNullable<TaskPlanningOptions['workflowGenerator']>>[0]

const model = { provider: 'controlled', model: 'gpt-6.2-sol',
  reasoningEffort: 'medium' as NonNullable<NonNullable<ReturnType<Agent['model']['current']>>['reasoningEffort']> }
const modelProfile = { ref: model.provider + '/' + model.model, provider: model.provider, model: model.model,
  capacity: 'standard' as const, reasoning: { efforts: [{ id: model.reasoningEffort, name: 'Medium' }] } }
const owner = 'local-dsh:scenario-test-operator'
const inbox = <T>(worker: Worker, input: Record<string, unknown>) => worker.tool<T>('orchestra_coordination', input)
const publish = (worker: Worker, text: string) => worker.tool('orchestra_rework', {
  action: 'publish_text_result', deliverable_index: worker.task.deliverables[0]!.deliverable_index, text,
})

function readField<T>(prompt: string, prefix: string): T {
  const line = prompt.split('\n').find(text => text.startsWith(prefix))
  if (!line) throw new Error('Missing dispatch context ' + prefix)
  return JSON.parse(line.slice(prefix.length)) as T
}

function interpret(scenario: Scenario, { current, draft }: SemanticInput) {
  const admission = { kind: 'task', quote: current.text }
  if (scenario.held?.includes(current.text)) {
    return { ...admission, relation: draft ? 'continue' : 'new', timing: 'held', constraints: [],
      ...(draft && { draft_revision: draft.revision, continuation: 'supply' }) }
  }
  expect([...draft?.sources.map(source => source.text) ?? [], current.text].join('\n')).toBe(scenario.goal)
  const source = { source_message_id: current.message_id }
  const access = current.text.match(/不联网，不读写工作区文件/u)![0]
  return { ...admission, relation: draft ? 'continue' : 'new', timing: 'immediate',
    ...(draft && { draft_revision: draft.revision, continuation: 'resume' }), constraints: [
    { ...source, id: 'chat', kind: 'chat_only', quote: scenario.chatQuote },
    { ...source, id: 'network', kind: 'no_network', quote: access },
    { ...source, id: 'workspace-read', kind: 'no_workspace_read', quote: access },
    { ...source, id: 'workspace-write', kind: 'no_workspace_files', quote: access },
    ...(scenario.approval ? [{ ...source, id: 'approval', kind: 'approval_before', scope: 'steps', action: '计算',
      quote: '只有我批准该步骤后，才能计算预算剩余金额及支出比例', reviewer: { kind: 'operator' } }] : []),
  ] }
}

async function scenarioHarness({ projectContext = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'orchestra-conversation-scenarios-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const privateProjectText = '本次任务禁止读取的合成项目资料'
  if (projectContext) await writeFile(join(workspace, PROJECT_CONTEXT_FILE), privateProjectText)
  const projectRead = vi.fn(async (path: string) => ({ text: await readFile(join(workspace, path), 'utf8'), eof: true }))
  const projectList = vi.fn(async () => ({ entries: (await readdir(workspace, { withFileTypes: true }))
    .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: false }))
  const dispatchPrompts: string[] = []
  const host = new Context()
  const agents = new Map<string, Agent>()
  const parents = new Set<Agent>()
  const services = new Map<string, Awaited<ReturnType<typeof serveDshOrchestra>>>()
  const nativeApproval = vi.fn(async () => { throw new Error('Host approval popup should not open under never') })
  const outsideTool = vi.fn(async () => { throw new Error('Unexpected workspace or network tool') })
  const workerErrors: unknown[] = []
  const stop = new AbortController()
  const specs = new Map<string, Scenario>()
  let taskTool: Definition
  host.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
  host.provide('tools', { register(definition: Definition) { taskTool = definition }, guard() {} })
  host.provide('systemPrompt', { section() {} })
  host.provide('sessions', { flush: async () => true })
  host.provide('approval', { request: nativeApproval, overrideOf: () => 'never' })
  const native = host.plugin(context => installNativeChat(context, {
    operator: owner, signal: stop.signal,
    bindingFor(agent) {
      if (parents.has(agent)) return { identity: 'test/' + agent.session.id, workspaceId: 'test', sessionId: agent.session.id }
    },
    hasService: binding => services.has(binding.sessionId),
    async serviceFor(binding) { return services.get(binding.sessionId)! },
    async interpret(input, agent) { return interpret(specs.get(agent.session.id)!, input) },
  }))
  await native.await()

  async function session(id: string, scenario: Scenario, options: { hostPlanning?: boolean; approvalPrompt?: string } = {}) {
    const pendingNotices: Message[] = []
    const conversation: Message[] = []
    const events: Array<{ type: 'user/message'; data: Message }> = []
    const children: string[] = []
    const planningPrompts: Array<{ text: string; input: PlanRequest | WorkflowRequest }> = []
    specs.set(id, scenario)
    const secret = 'isolated-scenario-' + id
    const workflowGenerator: NonNullable<TaskPlanningOptions['workflowGenerator']> = async ({ requirements_contract }) => {
      const gate = requirements_contract?.constraints.find(item => item.kind === 'approval_before')?.gate_name
      const label = options.approvalPrompt ?? gate ?? scenario.approval
      return { name: scenario.title, nodes: [{ node_id: 'start', type: 'trigger' },
        ...(label ? [{ node_id: 'gate', type: 'approval', title: label,
          config: { prompt: label, on_timeout: 'fail' } }] : []),
        ...scenario.steps.map(step => ({ node_id: step.id, type: 'agent', title: step.title }))],
      edges: [...(label ? [{ from: 'start', to: 'gate' }] : []),
        ...scenario.steps.flatMap(step => (step.after ?? [label ? 'gate' : 'start']).map(from => ({ from, to: step.id })))],
      }
    }
    const propose: TaskPlanningOptions['propose'] = async ({ workflows, requirements_contract }) => {
      const workflow = workflows[0]!
      const approval = requirements_contract?.constraints.find(item => item.kind === 'approval_before')
      return { title: scenario.title, workflow_id: workflow.workflowId, workflow_version: workflow.version,
        steps: workflow.nodes.map(node => ({ node_id: node.id, description: node.title, goal_ids: ['goal'],
          tools: [], depends_on: node.dependsOn, complexity: 'routine', model_reason: '由受控测试执行者处理' })),
        deliverables: scenario.steps.map(step => ({ title: step.title, node_id: step.id, goal_ids: ['goal'],
          acceptance: { kind: 'chat/text_result' } })),
        risks: [], ...(approval ? { constraint_bindings: [{ constraint_id: approval.id, approval_node_id: 'gate',
          protected_node_ids: scenario.steps.map(step => step.id) }] } : {}),
      }
    }
    const childrenApi = {
      async create(options: {
        sessionId: string; agentOptions: typeof model & { maxTokens?: number }; meta: { parentSession: string };
        setup(ctx: unknown, agent: unknown): void;
      }) {
        expect(options.meta.parentSession).toBe(id)
        const events: unknown[] = []
        const hooks: PreStep[] = []
        const tools = new Map<string, Definition>()
        let guard: (input: unknown) => string | undefined
        let selection: typeof model = options.agentOptions
        let idle = Promise.resolve()
        const signal = new AbortController()
        const child = {
          status: 'idle',
          session: { id: options.sessionId, snapshotEvents: () => events,
            append(type: string, data: object) { events.push({ type, data }) } },
          model: { current: () => selection, select(next: typeof model) { selection = next } },
          followup(message: Message) {
            child.status = 'running'
            idle = (async () => {
              expect(selection).toMatchObject(model)
              const prompt = message.content.find(part => part.type === 'text')!.text
              const step = { agent: child, modelSelection: selection, signal: signal.signal }
              const enter = hooks.reduceRight<() => Promise<{ kind: 'enter'; messages: Message[] }>>(
                (next, hook) => () => hook(step, next), async () => ({ kind: 'enter', messages: [message] }))
              await enter()
              events.push({ type: 'request/header', data: { header: { config: selection } } })
              const respond = (value: unknown) => events.push({ type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: JSON.stringify(value) }] } } },
              { type: 'turn/end', data: { reason: { kind: 'completed' } } })
              if (options.agentOptions.maxTokens === 8192) {
                const input = JSON.parse(prompt.split('\n').at(-1)!) as PlanRequest | WorkflowRequest
                planningPrompts.push({ text: prompt, input })
                // Only the model response is simulated. The host builds and sends its actual prompt.
                respond(await ('workflows' in input ? propose(input, signal.signal) : workflowGenerator(input, signal.signal)))
                return
              }
              dispatchPrompts.push(prompt)
              const task = readField<TaskInput>(prompt, '节点输入：')
              const { inputs } = readField<{ inputs: Reference[] }>(prompt, '本次运行的成果与修订上下文：')
              expect(task.task_goal).toBe(scenario.goal)
              const node = String(service.orchestra.db.raw.prepare(
                'SELECT node_id FROM node_runs WHERE executor_session_id=?').get(options.sessionId)?.node_id)
              children.push(node)
              expect(guard({ agent: child, name: 'run_code', signal: signal.signal })).toContain('通用代码执行')
              let callNumber = 0
              const worker: Worker = { node, task, prompt, upstream: inputs, async tool<T>(name: string, input: Record<string, unknown>) {
                const tool = tools.get(name)
                if (!tool) throw new Error('Tool was not registered: ' + name)
                expect(guard({ agent: child, name, signal: signal.signal })).toBeUndefined()
                const result = await tool.execute(input, { agent: child, signal: signal.signal,
                  callId: options.sessionId + '-' + ++callNumber } as unknown as ToolExecution) as { text: string }
                return JSON.parse(result.text) as T
              } }
              const completion = await scenario.work(worker) ?? { outcome: 'completed' }
              respond({
                status: completion.outcome === 'completed' ? 'done' : 'failed',
                output: { summary: completion.reason ?? '已登记结果', completion },
              })
            })().catch(error => {
              workerErrors.push(error)
              events.push({ type: 'turn/end', data: { reason: { kind: 'blocked' } } })
            }).finally(() => { child.status = 'idle' })
          },
          whenIdle: () => idle,
          cancel() { signal.abort(); child.status = 'idle' },
        }
        agents.set(options.sessionId, child as unknown as Agent)
        options.setup({ tools: { restrict() {}, guard(handler: typeof guard) { guard = handler },
          register(tool: Definition) { tools.set(tool.name, tool) } },
          on(event: string, hook: PreStep) { if (event === 'agent/pre-step') hooks.push(hook) } }, child)
        return { agent: child, async dispose() { agents.delete(options.sessionId) } }
      },
    }
    const parent = {
      id, status: 'running', model: { current: () => model },
      session: { id, header: { cwd: workspace, origin: 'root' }, snapshotEvents: () => [...events] },
      ctx: { agents: childrenApi, get: (key: string) => key === 'approval' ? host.get('approval') : undefined },
      inbox: { nextTurn: pendingNotices, nextStep: [] },
      followup(message: Message) {
        pendingNotices.push(message)
        agentEvents(host, parent).emit('agent/inbox/inserted', { message })
      },
      steer(message: Message) { parent.followup(message) },
    } as unknown as Agent
    agents.set(id, parent)
    parents.add(parent)
    const registry = new ToolRegistry()
    const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, run: outsideTool }, workspace)
    const service = await serveDshOrchestra({
      dbFile: join(home, id + '.sqlite'), secret, phase: 'S6', tools: { registry, runner },
      asOfSeq: () => 0, listEvents: () => [], listTasks: () => [], appendLedgerEvent: () => { throw new Error('Unexpected ledger append') },
      scheduler: createExecutionScheduler({ concurrency: 2 }),
      ...(projectContext && { projectContext: { workspaceRoot: workspace, isAuthorized: () => true, read: projectRead, list: projectList } }),
      dsh: { context: { agents: { get: (session: string) => agents.get(session) },
        llm: { listModels: async () => [{ id: model.model }], resolveModelInfo: async () =>
          ({ reasoning: { efforts: [{ id: model.reasoningEffort }] } }) },
      } as unknown as Context, parentForNode: () => parent, executionPermissionMode: () => 'inherit',
      models: [modelProfile],
      recommend: () => ({ complexity: 'routine', reason: '独立核对会话内数据' }) },
      ...(options.hostPlanning ? { dshPlanner: { parent: () => parent, model } } : { planning: { workflowGenerator, propose } }),
    })
    services.set(id, service)
    createModelRoutingSettingsHost(service.orchestra.db, [modelProfile]).save({
      operation_id: uuidv7(), expected_revision: 0, mapping: { routine: null, standard: null, complex: null },
      model_reasoning_defaults: [{ ref: modelProfile.ref, effort: model.reasoningEffort }],
    }, owner, new Date().toISOString())
    const db = service.orchestra.db.raw
    let turn = 0
    const turnSignal = new AbortController()
    const dispatch = agentEvents(host, parent)
    async function enter(message: Message) {
      dispatch.emit('agent/inbox/claimed', { message, turn: ++turn })
      const result = await dispatch.waterfall('agent/pre-step', { messages: [message], turn, step: 0,
        signal: turnSignal.signal, modelSelection: model }, async () => ({ kind: 'enter', messages: [message] }))
      if (result.kind === 'enter') for (const accepted of result.messages) {
        events.push({ type: 'user/message', data: accepted })
      }
    }
    async function say(text: string) {
      const message = { id: uuidv7(), role: 'user', source: { kind: 'user', rpcId: uuidv7() },
        content: [{ type: 'text', text }] } as unknown as Message
      dispatch.emit('agent/inbox/inserted', { message })
      await enter(message)
      return await call({ action: 'start' })
    }
    async function submit(text = scenario.goal) {
      const receipt = await say(text)
      expect(receipt).toMatchObject({ state: 'started', run_id: expect.any(String), title: scenario.title })
      return String(receipt.run_id)
    }
    async function call(input: object) {
      const result = await taskTool.execute(input, { agent: parent, callId: uuidv7(),
        signal: turnSignal.signal } as ToolExecution) as { text: string }
      return JSON.parse(result.text)
    }
    async function readNotices() {
      for (const message of pendingNotices.splice(0)) {
        // Deliver via the native claim + pre-step path. Merely being queued is not delivery.
        await enter(message)
        if (events.some(event => event.data.id === message.id)) conversation.push(message)
      }
      return conversation.map(message => ({ id: message.id,
        text: message.content.map(part => part.type === 'text' ? part.text : '').join('\n') }))
    }
    return { service, db, secret, say, submit, call, children, planningPrompts,
      nodeStates: (run: string) => db.prepare('SELECT node_id,status FROM node_runs WHERE run_id=? ORDER BY seq').all(run),
      errors: workerErrors,
      readNotices,
      async noticeText() { return (await readNotices()).map(notice => notice.text).join('\n') },
    }
  }
  return { session, workerErrors, nativeApproval, outsideTool, projectRead, projectList, dispatchPrompts, privateProjectText, async close() {
    stop.abort()
    await native.dispose()
    await Promise.all([...services.values()].map(service => service.close()))
    try { expect(await readdir(workspace)).toEqual(projectContext ? [PROJECT_CONTEXT_FILE] : []) }
    finally { await rm(home, { recursive: true, force: true }) }
  } }
}

function sum(numbers: number[]) { return numbers.reduce((total, value) => total + value, 0) }

function registered(session: Awaited<ReturnType<Awaited<ReturnType<typeof scenarioHarness>>['session']>>, run: string) {
  return session.db.prepare(`SELECT n.node_id, c.bytes FROM artifacts a JOIN artifact_contents c USING (artifact_id)
    JOIN node_runs n ON n.node_run_id=c.node_run_id WHERE a.run_id=? ORDER BY n.seq`).all(run)
    .map(row => [row.node_id, Buffer.from(row.bytes as Uint8Array).toString('utf8')])
}

function acceptance(session: Awaited<ReturnType<Awaited<ReturnType<typeof scenarioHarness>>['session']>>, run: string) {
  return session.db.prepare('SELECT kind, outcome FROM run_acceptance_results WHERE run_id=? ORDER BY deliverable_key').all(run)
}

function status(session: Awaited<ReturnType<Awaited<ReturnType<typeof scenarioHarness>>['session']>>, run: string) {
  const result = session.db.prepare('SELECT status FROM runs WHERE run_id=?').get(run)?.status
  if (result === 'running') {
    const states = session.nodeStates(run)
    const trace = session.db.prepare("SELECT type,payload_redacted FROM events ORDER BY seq DESC LIMIT 9").all()
    return { states, errors: session.errors.map(String), trace }
  }
  return result
}

const approvalName = '批准预算分析'
const budgetScenario: Scenario = { title: 'T03-人工审批测试',
  goal: '创建并执行任务「T03-人工审批测试」。\n\n使用模拟数据：预算 10000 元，实际支出 7600 元。\n\n设置一个名为「批准预算分析」的人工审批步骤。只有我批准该步骤后，才能计算预算剩余金额及支出比例，并将完整结果返回当前会话。\n\n任务不联网，不读写工作区文件。',
  chatQuote: '并将完整结果返回当前会话', approval: approvalName, steps: [{ id: 'budget', title: '预算核算' }],
  async work(worker) {
    expect(worker.prompt).toContain('宿主已核验本次运行中当前步骤需要的人工批准')
    expect(readField<unknown>(worker.prompt, 'workflow_approvals=')).toMatchObject([{
      name: approvalName, decision_id: expect.any(String), revision: expect.any(Number), resolution: 'approved',
    }])
    const [, budget, spent] = /预算 (\d+) 元，实际支出 (\d+) 元/u.exec(worker.task.task_goal)!.map(Number)
    await publish(worker, `预算剩余 ${budget! - spent!} 元，支出比例 ${spent! / budget! * 100}%`)
  },
}

it('T01 registers a sales reconciliation table and delivers the totals to the conversation', async () => {
  const harness = await scenarioHarness()
  try {
    const session = await harness.session('T01', { title: 'T01-销售数据核对',
      goal: `请完成任务「T01-销售数据核对」。

原始数据：
A：销售额 1200 元，退款 100 元。
B：销售额 800 元，退款 50 元。
C：销售额 600 元，退款 0 元。

分别统计销售总额、退款总额及净销售额，核对计算过程，最终以表格和简短结论返回本会话。

仅使用上述数据，不联网，不读写工作区文件。允许 Orchestra 内部登记成果。直接执行，无需另行确认方案。`,
      chatQuote: '最终以表格和简短结论返回本会话', steps: [{ id: 'sales', title: '销售额核算' }],
      async work(worker) {
        const entries = Array.from(worker.task.task_goal.matchAll(/销售额 (\d+) 元，退款 (\d+) 元/gu),
          match => [Number(match[1]), Number(match[2])])
        const sales = sum(entries.map(entry => entry[0]!))
        const refunds = sum(entries.map(entry => entry[1]!))
        const net = sales - refunds
        await publish(worker, `| 销售总额 | 退款总额 | 净销售额 |\n|---:|---:|---:|\n| ${sales} | ${refunds} | ${net} |\n核对：${sales} - ${refunds} = ${net} 元。`)
      },
    })
    const run = await session.submit()
    await expect.poll(() => status(session, run), { timeout: 4_000 }).toBe('succeeded')
    expect(registered(session, run)).toMatchObject([['sales', expect.stringContaining('| 2600 | 150 | 2450 |')]])
    await expect.poll(session.noticeText, { timeout: 6_000 }).toContain('| 2600 | 150 | 2450 |\n核对：2600 - 150 = 2450 元。')
    expect(acceptance(session, run)).toEqual([{ kind: 'chat/text_result', outcome: 'passed' }])
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { await harness.close() }
}, 15_000)

it('T02 keeps both hold messages out of execution, then launches once with the original data and table request', async () => {
  const harness = await scenarioHarness()
  const held = [
    '我需要完成任务「T02-项目进度分析」，先不要执行，等我补充数据和要求',
    '补充数据：开发任务共 20 项，已完成 12 项，进行中 5 项，未开始 3 项。需要计算完成率，并用表格展示各项状态。仍然先不要执行。',
  ]
  const start = '现在开始执行刚才的任务。沿用全部已有要求，不联网，不读写工作区文件，结果返回本会话。'
  try {
    const session = await harness.session('T02', { title: 'T02-项目进度分析',
      goal: [...held, start].join('\n'), chatQuote: '结果返回本会话', held,
      steps: [{ id: 'progress', title: '项目进度核算' }],
      async work(worker) {
        const [, total, completed, active, pending] = /共 (\d+) 项，已完成 (\d+) 项，进行中 (\d+) 项，未开始 (\d+) 项/u
          .exec(worker.task.task_goal)!.map(Number)
        await publish(worker, `| 总计 | 已完成 | 进行中 | 未开始 |\n|---:|---:|---:|---:|\n| ${total} | ${completed} | ${active} | ${pending} |\n完成率 ${completed! / total! * 100}%`)
      },
    })
    for (const message of held) {
      expect(await session.say(message)).toMatchObject({ state: 'task_held' })
      expect(session.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0)
      expect(session.children).toEqual([])
    }
    const run = await session.submit(start)
    await expect.poll(() => status(session, run)).toBe('succeeded')
    expect(session.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1)
    expect(registered(session, run)).toMatchObject([['progress', expect.stringContaining('| 20 | 12 | 5 | 3 |')]])
    await expect.poll(session.noticeText, { timeout: 6_000 }).toContain('| 20 | 12 | 5 | 3 |\n完成率 60%')
    expect(acceptance(session, run)).toEqual([{ kind: 'chat/text_result', outcome: 'passed' }])
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { await harness.close() }
}, 15_000)

it('T03 keeps the approval gate closed under never while T03B runs independently, then delivers both results to their owner', async () => {
  const harness = await scenarioHarness()
  try {
    const gated = await harness.session('T03', budgetScenario, { hostPlanning: true })
    const independent = await harness.session('T03B', { title: 'T03B-并发隔离测试',
      goal: '执行独立任务「T03B-并发隔离测试」。\n\n计算 128、256、512、1024 的合计及平均值，并返回当前会话。直接执行，不联网，不读写工作区文件。',
      chatQuote: '并返回当前会话', steps: [{ id: 'independent', title: '合计与平均值' }],
      async work(worker) {
        const numbers = /计算 ([\d、]+)/u.exec(worker.task.task_goal)![1]!.split('、').map(Number)
        const total = sum(numbers)
        await publish(worker, `合计 ${total}，平均值 ${total / numbers.length}`)
      },
    })
    const run = await gated.submit()
    expect(gated.planningPrompts.map(({ input }) => 'workflows' in input)).toEqual([false, true])
    for (const { text, input } of gated.planningPrompts) {
      expect(input.requirements_contract?.constraints).toContainEqual(expect.objectContaining({
        kind: 'approval_before', gate_name: approvalName, action: '计算',
      }))
      expect.soft(text).not.toMatch(/10000|7600/u)
      expect.soft(JSON.stringify(input.requirements_contract?.sources ?? [])).not.toMatch(/10000|7600/u)
    }
    await expect.poll(() => gated.nodeStates(run)).toEqual([
      { node_id: 'gate', status: 'blocked_pre' }, { node_id: 'budget', status: 'queued' },
    ])
    await expect.poll(gated.noticeText, { timeout: 6_000 }).toContain(approvalName)
    expect(await gated.call({ action: 'review', decision_title: approvalName })).toMatchObject({ kind: 'panel_review' })
    expect(harness.nativeApproval).not.toHaveBeenCalled()
    expect(harness.dispatchPrompts).toEqual([])
    const independentRun = await independent.submit()
    await expect.poll(() => status(independent, independentRun), { timeout: 8_000 }).toBe('succeeded')
    await expect.poll(independent.noticeText, { timeout: 6_000 }).toContain('合计 1920，平均值 480')
    expect(gated.children).toEqual([])
    expect(independent.children).toEqual(['independent'])
    expect(await gated.noticeText()).not.toContain('1920')
    expect(gated.db.prepare('SELECT run_id FROM runs WHERE run_id=?').get(independentRun)).toBeUndefined()
    expect(independent.db.prepare('SELECT run_id FROM runs WHERE run_id=?').get(run)).toBeUndefined()

    const budgetNode = String(gated.db.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='budget'").get(run)?.node_run_id)
    const receipts = (secret = gated.secret) => executionApprovalReceipts(gated.service.orchestra.db, secret, budgetNode)
    expect(() => receipts()).toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
    const decision = gated.db.prepare("SELECT decision_id,revision,content_hash FROM decisions WHERE run_id=? AND status='pending'").get(run)!
    // This actor represents the test operator explicitly approving the existing workflow gate.
    gated.service.orchestra.commands.resolveDecision({ decisionId: String(decision.decision_id),
      revision: Number(decision.revision), contentHash: String(decision.content_hash), actor: { id: owner, kind: 'human' }, resolution: 'approved',
      operationId: uuidv7(), now: new Date().toISOString() })
    await expect.poll(() => status(gated, run), { timeout: 8_000 }).toBe('succeeded')
    await expect.poll(gated.noticeText, { timeout: 6_000 }).toContain('预算剩余 2400 元，支出比例 76%')
    const budgetPrompt = harness.dispatchPrompts.find(prompt => prompt.includes('预算 10000 元，实际支出 7600 元'))!
    expect(readField<unknown>(budgetPrompt, 'workflow_approvals=')).toMatchObject([{
      approval_node_id: 'gate', name: approvalName, decision_id: decision.decision_id, revision: Number(decision.revision) + 1,
      resolution: 'approved', decided_at: expect.any(String),
    }])
    expect(() => receipts('forged-signature')).toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
    expect(executionApprovalReceipts(independent.service.orchestra.db, independent.secret, budgetNode)).toEqual([])
    expect(await independent.noticeText()).not.toContain('2400')
    expect(registered(gated, run)).toEqual([['budget', '预算剩余 2400 元，支出比例 76%']])
    expect(registered(independent, independentRun)).toEqual([['independent', '合计 1920，平均值 480']])
    expect(acceptance(gated, run)).toEqual([{ kind: 'chat/text_result', outcome: 'passed' }])
    expect(acceptance(independent, independentRun)).toEqual([{ kind: 'chat/text_result', outcome: 'passed' }])
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { await harness.close() }
}, 30_000)

it('T03 blocks a real plan bound to an approval card with an invented label under never', async () => {
  const harness = await scenarioHarness()
  try {
    const session = await harness.session('T03-wrong-approval-name', budgetScenario,
      { hostPlanning: true, approvalPrompt: '请确认预算' })
    const result = await session.say(budgetScenario.goal)
    expect(result).toMatchObject({ state: 'quality_blocked', issues: [expect.stringContaining(approvalName)] })
    expect(session.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0)
    expect(session.children).toEqual([])
    expect(harness.nativeApproval).not.toHaveBeenCalled()
    expect(harness.workerErrors).toEqual([])
  } finally { await harness.close() }
}, 15_000)

type Inbox = { peers: Array<{ node_run_id: string; title: string }>; items: CoordinationItem[] }

it('T04 starts both branches in parallel, records a reply after the sender completes, and joins both registered results', async () => {
  const harness = await scenarioHarness()
  const requested = Promise.withResolvers<void>()
  const allowReply = Promise.withResolvers<void>()
  const refundReady = Promise.withResolvers<void>()
  try {
    const session = await harness.session('T04', { title: 'T04-多代理财务交叉核对',
      goal: `请创建并执行任务「T04-多代理财务交叉核对」，使用以下模拟数据：

收入：I01=320元，I02=480元，I03=200元。
退款：R01=80元，R02=20元。

安排三个步骤：

收入核对代理 A：独立统计收入笔数和金额。

退款核对代理 B：独立统计退款笔数和金额。

汇总代理 C：在 A、B 均完成后，读取两者登记的成果，计算净收入并复核。

A、B 必须并行执行。A 在核对过程中主动向 B 发出一次协作求助，核对退款统计口径。B 收到后在正常执行过程中回应。可以使用 Orchestra 的协作信箱 orchestra_coordination，通过 inbox 获取真实同行，使用 request 和 reply 完成沟通，不要猜测节点编号。

A、B 分别登记精简的中间文本成果。若收到协作信息，结合自身核对工作处理；不要轮询等待，不要额外启动代理。C 必须根据正式登记的成果独立计算，不能仅凭协作消息确认验收。

不联网，不读写工作区文件，允许插件内部登记成果及协作记录。最终完整结果返回本会话。`,
      chatQuote: '最终完整结果返回本会话',
      steps: [{ id: 'income', title: '收入核对代理 A' }, { id: 'refund', title: '退款核对代理 B' },
        { id: 'summary', title: '汇总代理 C', after: ['income', 'refund'] }],
      async work(worker) {
        if (worker.node === 'income') {
          const amounts = Array.from(worker.task.task_goal.matchAll(/I\d+=(\d+)元/gu), match => Number(match[1]))
          await refundReady.promise
          const box = await inbox<Inbox>(worker, { action: 'inbox' })
          expect(box.peers.map(peer => peer.title)).toEqual(['退款核对代理 B'])
          await inbox(worker, { action: 'send', kind: 'request', target_node_run_id: box.peers[0]!.node_run_id,
            body: '退款金额按两笔退款求和吗？' })
          requested.resolve()
          await publish(worker, `收入 ${amounts.length} 笔，合计 ${sum(amounts)} 元`)
        } else if (worker.node === 'refund') {
          refundReady.resolve()
          const amounts = Array.from(worker.task.task_goal.matchAll(/R\d+=(\d+)元/gu), match => Number(match[1]))
          await publish(worker, `退款 ${amounts.length} 笔，合计 ${sum(amounts)} 元`)
          await requested.promise
          await allowReply.promise
          const box = await inbox<Inbox>(worker, { action: 'inbox' })
          expect(box.peers).toEqual([])
          expect(box.items).toMatchObject([{ kind: 'request', source: '收入核对代理 A', state: 'pending' }])
          const { id, revision } = box.items[0]!
          await inbox(worker, { action: 'reply', id, revision, body: '对，范围包括 R01 和 R02。' })
        } else {
          expect(worker.upstream).toHaveLength(2)
          const snapshots = await Promise.all(worker.upstream.map(({ artifact_id, artifact_hash }) =>
            worker.tool<{ text: string }>('orchestra_rework', { action: 'read', artifact_id, artifact_hash })))
          const byKind = new Map(snapshots.map(({ text }) => [/^(收入|退款)/u.exec(text)![1], Number(/合计 (\d+) 元/u.exec(text)![1])]))
          await publish(worker, `收入合计 ${byKind.get('收入')} 元，退款合计 ${byKind.get('退款')} 元，净收入 ${byKind.get('收入')! - byKind.get('退款')!} 元`)
        }
      },
    })
    const run = await session.submit()
    await expect.poll(() => session.nodeStates(run), { timeout: 6_000 }).toEqual(expect.arrayContaining([
      { node_id: 'income', status: 'done' }, { node_id: 'refund', status: 'started' }, { node_id: 'summary', status: 'queued' },
    ]))
    allowReply.resolve()
    await expect.poll(() => status(session, run), { timeout: 8_000 }).toBe('succeeded')
    expect(session.children.slice(0, 2).sort()).toEqual(['income', 'refund'])
    expect(session.children.slice(2)).toEqual(['summary'])
    expect(session.service.coordination!.listHuman(run, owner).items).toMatchObject([
      { kind: 'request', source: '收入核对代理 A', target: '退款核对代理 B', reply: '对，范围包括 R01 和 R02。', state: 'answered', evidence_strength: 'none' },
    ])
    expect(registered(session, run)).toEqual(expect.arrayContaining([
      ['income', '收入 3 笔，合计 1000 元'], ['refund', '退款 2 笔，合计 100 元'],
      ['summary', '收入合计 1000 元，退款合计 100 元，净收入 900 元'],
    ]))
    expect(session.db.prepare('SELECT COUNT(*) AS n FROM artifact_consumptions').get()?.n).toBe(2)
    await expect.poll(session.noticeText, { timeout: 6_000 }).toContain('收入合计 1000 元，退款合计 100 元，净收入 900 元')
    const notice = await session.noticeText()
    expect(notice).toContain('「退款核对代理 B」已回应「收入核对代理 A」的协作请求。')
    expect(notice).not.toContain('对，范围包括 R01 和 R02。')
    expect(acceptance(session, run)).toEqual(Array(3).fill({ kind: 'chat/text_result', outcome: 'passed' }))
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { requested.resolve(); allowReply.resolve(); refundReady.resolve(); await harness.close() }
}, 25_000)

it('T05 records the missing price without turning the known subtotal into the full value or stopping the quantity worker', async () => {
  const harness = await scenarioHarness()
  const finishQuantity = Promise.withResolvers<void>()
  const missingPrice = /商品 B 单价缺失，已知小计 290 元，完整库存金额未定。补齐商品 B 单价后复核库存金额。/u
  const quantity = '库存数量合计 18 件。'
  try {
    const session = await harness.session('T05', { title: 'T05-库存数据异常核查',
      goal: `执行任务「T05-库存数据异常核查」。

原始数据：
商品 A：数量 10，单价 20 元。
商品 B：数量 5，单价缺失。
商品 C：数量 3，单价 30 元。

安排两个独立并行步骤：库存金额核算、库存数量核算。

金额核算代理发现必要数据缺失时，使用协作信箱的 blocker 类型主动上报具体问题、影响和下一步，并如实报告无法完成的内容。不得编造缺失单价，不得把已知金额小计当成完整库存金额。

数量核算代理正常完成数量统计。不要因为另一个代理上报问题而主动停下来等待。

无需向我补问缺失数据。本次就是要核查数据缺口的处理效果。最终在本会话明确说明已完成项、未完成项、具体原因及下一步。

不联网，不读写工作区文件，允许内部登记成果与协作记录。`,
      chatQuote: '最终在本会话明确说明已完成项、未完成项、具体原因及下一步',
      steps: [{ id: 'value', title: '库存金额核算' }, { id: 'quantity', title: '库存数量核算' }],
      async work(worker) {
        const rows = Array.from(worker.task.task_goal.matchAll(/商品 ([A-C])：数量 (\d+)，单价(?: (\d+) 元|缺失)/gu),
          ([, id, quantity, price]) => ({ id, quantity: Number(quantity), price: price === undefined ? null : Number(price) }))
        if (worker.node === 'quantity') {
          const total = sum(rows.map(row => row.quantity))
          // Keep the result ready while the fixture confirms the first notice was delivered.
          await finishQuantity.promise
          await publish(worker, `库存数量合计 ${total} 件。`)
          return
        }
        const missing = rows.find(row => row.price === null)!
        const subtotal = sum(rows.flatMap(row => row.price === null ? [] : row.quantity * row.price))
        const reason = `商品 ${missing.id} 单价缺失，已知小计 ${subtotal} 元，完整库存金额未定`
        const next_action = `补齐商品 ${missing.id} 单价后复核库存金额`
        await inbox(worker, { action: 'send', kind: 'blocker', body: reason + '。' + next_action + '。' })
        return { outcome: 'blocked', reason, next_action }
      },
    })
    const run = await session.submit()
    const reportKey = () => String(session.db.prepare('SELECT reported_key FROM chat_task_receipts').get()?.reported_key ?? '')
    const deliveredKey = async () => {
      await session.readNotices()
      return reportKey()
    }
    await expect.poll(() => session.nodeStates(run), { timeout: 8_000 }).toEqual(expect.arrayContaining([
      { node_id: 'value', status: 'blocked_post' }, { node_id: 'quantity', status: 'started' },
    ]))
    await expect.poll(session.noticeText, { timeout: 6_000 }).toMatch(missingPrice)
    await expect.poll(deliveredKey, { timeout: 6_000 }).toMatch(/^delivered:actions:v2:/u)
    const firstKey = reportKey()
    const first = await session.readNotices()
    expect(first.some(notice => notice.text.includes('执行受阻'))).toBe(true)
    expect(first.every(notice => !notice.text.includes(quantity))).toBe(true)
    expect(registered(session, run)).toEqual([])

    finishQuantity.resolve()
    await expect.poll(() => session.nodeStates(run), { timeout: 8_000 }).toEqual(expect.arrayContaining([
      { node_id: 'value', status: 'blocked_post' }, { node_id: 'quantity', status: 'done' },
    ]))
    expect(session.service.coordination!.listHuman(run, owner).items).toMatchObject([
      { kind: 'blocker', state: 'reported', source: '库存金额核算', target: null, evidence_strength: 'none',
        body: '商品 B 单价缺失，已知小计 290 元，完整库存金额未定。补齐商品 B 单价后复核库存金额。' },
    ])
    expect(registered(session, run)).toEqual([['quantity', quantity]])
    await expect.poll(session.noticeText, { timeout: 6_000 }).toContain(quantity)
    const second = await session.readNotices()
    expect(second).toHaveLength(first.length + 1)
    expect(second.slice(0, first.length)).toEqual(first)
    const update = second.at(-1)!
    expect(first.some(notice => notice.id === update.id)).toBe(false)
    expect(update.text).toMatch(missingPrice)
    expect(update.text).toContain(quantity)
    expect(update.text).toContain('整项任务仍在处理中')
    expect(session.db.prepare('SELECT status FROM runs WHERE run_id=?').get(run)?.status).toBe('running')
    expect(acceptance(session, run)).toEqual([])
    await expect.poll(deliveredKey, { timeout: 6_000 }).not.toBe(firstKey)
    const secondKey = reportKey()
    expect(secondKey).toMatch(/^delivered:actions:v2:/u)
    // The native reporter runs every two seconds. Let it inspect the unchanged facts twice.
    await delay(4_100)
    expect(await session.readNotices()).toEqual(second)
    expect(reportKey()).toBe(secondKey)
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { finishQuantity.resolve(); await harness.close() }
}, 35_000)

it('T06 deduplicates identical 30-second requests and lets both workers finish with the other worker silent', async () => {
  const harness = await scenarioHarness()
  const peerReady = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<void>()
  try {
    const session = await harness.session('T06', { title: 'T06-协作失联与去重测试',
      goal: `执行任务「T06-协作失联与去重测试」。

安排两个独立并行的只读代理：

代理 A 负责计算 12、24、36、48 的合计与平均值。
代理 B 负责计算 15、25、35、45 的合计与平均值。

在双方同时可用时，A 通过真实协作信箱向 B 发出一个参考性核对请求，期限设置为30秒。若对方仍然可用，立即使用完全相同的参数重发一次，检验重复请求是否去重。

B 本次故意不回应这项非必要协作请求，但正常完成自身计算并退出。

A 不得等待 B 的回应，不得循环查询或重新派发代理，继续完成自己的计算。

所有操作必须实际通过插件执行，不要模拟工具回执。结果和发生的协作异常返回本会话。不联网，不读写工作区文件。`,
      chatQuote: '结果和发生的协作异常返回本会话',
      steps: [{ id: 'first', title: '代理 A' }, { id: 'second', title: '代理 B' }],
      async work(worker) {
        const isFirst = worker.node === 'first'
        const name = isFirst ? 'A' : 'B'
        if (isFirst) {
          await peerReady.promise
          const box = await inbox<Inbox>(worker, { action: 'inbox' })
          expect(box.peers.map(peer => peer.title)).toEqual(['代理 B'])
          const request = { action: 'send', kind: 'request', target_node_run_id: box.peers[0]!.node_run_id,
            ttl_seconds: 30, body: '请参考核对求平均值的口径。' }
          const first = await inbox<CoordinationItem>(worker, request)
          const duplicate = await inbox<CoordinationItem>(worker, request)
          expect(duplicate).toEqual(first)
          sent.resolve()
        } else {
          peerReady.resolve()
          await sent.promise
        }
        const values = new RegExp(`代理 ${name} 负责计算 ([\\d、]+)`, 'u').exec(worker.task.task_goal)![1]!.split('、').map(Number)
        const total = sum(values)
        await publish(worker, `代理 ${name} 合计 ${total}，平均值 ${total / values.length}`)
      },
    })
    const run = await session.submit()
    await expect.poll(() => status(session, run), { timeout: 8_000 }).toBe('succeeded')
    expect(session.children.sort()).toEqual(['first', 'second'])
    expect(registered(session, run)).toEqual(expect.arrayContaining([
      ['first', '代理 A 合计 120，平均值 30'], ['second', '代理 B 合计 120，平均值 30'],
    ]))
    const { items } = session.service.coordination!.listHuman(run, owner)
    expect(items).toMatchObject([{ kind: 'request', source: '代理 A', target: '代理 B', state: 'unavailable', reply: null }])
    expect(items[0]!.expires_ms - items[0]!.created_ms).toBe(30_000)
    await expect.poll(() => session.db.prepare('SELECT id,state,reply FROM run_coordination WHERE run_id=?').all(run),
      { timeout: 6_000 }).toEqual([{ id: items[0]!.id, state: 'unavailable', reply: null }])
    await expect.poll(async () => {
      const text = await session.noticeText()
      return ['代理 A 合计 120，平均值 30', '代理 B 合计 120，平均值 30', '协作未得到回应']
        .filter(result => !text.includes(result))
    }, { timeout: 6_000 }).toEqual([])
    expect(acceptance(session, run)).toEqual(Array(2).fill({ kind: 'chat/text_result', outcome: 'passed' }))
    expect(harness.workerErrors).toEqual([])
    expect(harness.outsideTool).not.toHaveBeenCalled()
  } finally { peerReady.resolve(); sent.resolve(); await harness.close() }
}, 25_000)

it('keeps a no-workspace task away from a configured Desktop project context', async () => {
  const harness = await scenarioHarness({ projectContext: true })
  try {
    const session = await harness.session('project-context-boundary', {
      title: '项目资料隔离',
      goal: '计算 4 + 5，结果返回本会话。不联网，不读写工作区文件。',
      chatQuote: '结果返回本会话',
      steps: [{ id: 'calculate', title: '会话内计算' }],
      async work(worker) {
        const [, left, right] = /计算 (\d+) \+ (\d+)/u.exec(worker.task.task_goal)!.map(Number)
        await publish(worker, String(left! + right!))
      },
    })
    const run = await session.submit()
    await expect.poll(() => status(session, run), { timeout: 6_000 }).toBe('succeeded')
    expect.soft(harness.projectRead).not.toHaveBeenCalled()
    expect.soft(harness.projectList).not.toHaveBeenCalled()
    expect.soft(harness.dispatchPrompts.join('\n')).not.toContain(harness.privateProjectText)
  } finally { await harness.close() }
}, 15_000)
