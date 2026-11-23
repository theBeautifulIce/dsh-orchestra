import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getTaskPlanRecommendation, serveOrchestra, type ModelRouting, type TaskPlanningOptions, type TaskPlanProposal } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import type { WorkflowDoc } from '../../src/core/workflow-doc.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import type { SpawnParams } from '../../src/executor/bridge.ts'
import { OrchError } from '../../src/core/errors.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { createTaskPlanningHost } from '../../src/service/task-planning.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { planningTimeoutDefaults } from '../../src/service/planning-settings.ts'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const now = '2026-11-18T01:00:00.000Z'
const descriptor = { name: 'ro.check', capability: 'read_only' as const, command: { bin: 'check', args: [] } }
const valid = (): TaskPlanProposal => ({
  title: '项目交付核对', workflow_id: 'review', workflow_version: '1',
  steps: [
    { node_id: 'collect', description: '收集交付附件', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '重复清点' },
    { node_id: 'verify', description: '使用系统工具核对', goal_ids: ['goal', 'R1'], depends_on: ['collect'],
      tools: ['ro.check'], complexity: 'complex', model_reason: '独立比对多个来源' },
  ],
  deliverables: [
    { title: '交付核对报告', node_id: 'verify', goal_ids: ['goal'], acceptance: { kind: 'artifact', file_name: '交付.md', minimum_bytes: 160 } },
    { title: '系统核验证据', node_id: 'verify', goal_ids: ['R1'], acceptance: { kind: 'tool_evidence', tool: 'ro.check', exit_code: 0 } },
  ],
  risks: [{ severity: 'medium', description: '缺少上游附件', mitigation: '在报告中列出缺口', node_id: 'collect' }],
})

const reviewDoc = {
  name: '交付复核',
  nodes: [
    { node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 } },
    { node_id: 'collect', type: 'agent', title: '收集', position: { x: 100, y: 0 } },
    { node_id: 'verify', type: 'agent', title: '核对', position: { x: 200, y: 0 }, config: { tools: { allow: ['ro.check'] } } },
  ],
  edges: [{ from: 'start', to: 'collect' }, { from: 'collect', to: 'verify' }],
}

async function boot(propose: TaskPlanningOptions['propose'], observeSpawn?: (input: SpawnParams) => void, options: {
  empty?: boolean
  workflowGenerator?: TaskPlanningOptions['workflowGenerator']
  modelRouting?: ModelRouting
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-task-plan-'))
  const secret = 'planning-contract-secret'
  const registry = new ToolRegistry()
  registry.register(descriptor)
  const bridge = new BridgeClient({
    async request(method, params) {
      if (method === 'executor.spawn') observeSpawn?.(params as SpawnParams)
      throw new OrchError('FORBIDDEN', '测试宿主不执行被派发的节点')
    },
    async *listen() {},
  })
  const service = await serveOrchestra({
    dbFile: join(directory, 'orchestra.db'), secret, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    planning: { propose },
    workflowGenerator: options.workflowGenerator,
    executor: { registry, bridge, modelRouting: options.modelRouting, runner: new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => { throw new Error('plan must not run a tool') },
    }, directory) },
  })
  closers.push(async () => {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const { commands, db, catalog } = service.orchestra
  function publish(workflowId: string, definition: WorkflowDoc = reviewDoc, timestamp = now) {
    commands.createWorkflow({ workflowId, name: definition.name, definition, actor: 'host', now: timestamp, operationId: uuidv7() })
    expect(commands.testWorkflowDraft({ workflowId, revision: 1, now: timestamp }).passed).toBe(true)
    return commands.publishWorkflow({
      workflowId, revision: 1, baseVersion: 0, note: '可复用', actor: 'host', now: timestamp, operationId: uuidv7(),
    })
  }
  if (!options.empty) publish('review')
  const client = createApiClient(service.endpoint, (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', secret)
    return fetch(input, { ...init, headers })
  })
  return { endpoint: service.endpoint, client, api: createResourcesApi(client), planCommands: createTaskCommands(client),
    planning: service.planning, db, catalog, commands, registry, publish }
}

it('配置走已认证 HTTP 写闸和回执，重开账本后仍生效，恢复默认保留宿主回退', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-planning-settings-'))
  const path = '/v1/settings/planning-timeouts'
  const open = () => serveOrchestra({
    dbFile: join(directory, 'orchestra.db'), phase: 'S6', secret: 'settings-fixture-secret',
    resolveHttpHuman: (request) => request.headers['x-bound-test-user'] === 'local' ? { id: 'local-fixture' } : null,
    planning: { timeoutMs: 75_000, propose: async () => {} },
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'off' }),
  })
  let service = await open()
  const call = (target: string, body?: unknown, identified = true) => fetch(service.endpoint + target, {
    headers: { 'x-orchestra-secret': 'settings-fixture-secret', 'content-type': 'application/json',
      ...(identified ? { 'x-bound-test-user': 'local' } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  try {
    expect((await call(path, undefined, false)).status).toBe(403)
    expect((await call(path, {}, false)).status).toBe(403)
    expect(await (await call(path)).json()).toMatchObject({ data: { revision: 0, overridden: false, legacy_timeout_ms: 75_000 } })
    expect(service.planningSettings?.snapshot()).toMatchObject({ task: 75_000, workflow: 45_000, request: 225_000 })
    const save = { operation_id: uuidv7(), expected_revision: 0, values: {
      ...planningTimeoutDefaults, task_seconds: 160, stage_seconds: 200, request_seconds: 250,
    } }
    const invalid = await call(path, { ...save, values: { ...save.values, idle_seconds: 230 } })
    expect(invalid.status).toBe(400)
    for (const _attempt of [1, 2]) expect(await (await call(path, save)).json()).toMatchObject({ ok: true, data: { revision: 1 } })
    expect((await call(path, { ...save, operation_id: uuidv7() })).status).toBe(409)
    expect(await (await call('/v1/operations/get?operation_id=' + save.operation_id)).json()).toMatchObject({
      data: { kind: 'planning_timeouts.save', status: 'applied' },
    })
    await service.close()
    service = await open()
    expect(await (await call(path)).json()).toMatchObject({ data: { revision: 1, overridden: true, values: save.values } })
    expect(service.planningSettings?.snapshot()).toMatchObject({ task: 160_000, stage: 200_000, request: 250_000 })
    const reset = await call(path, { operation_id: uuidv7(), expected_revision: 1, values: null })
    expect(await reset.json()).toMatchObject({ data: { revision: 2 } })
    expect(service.planningSettings?.snapshot()).toMatchObject({ task: 75_000, workflow: 45_000, request: 225_000 })
  } finally {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('HTTP 规划请求断开后取消流程生成且不创建任务或计划', async () => {
  let start!: (signal: AbortSignal) => void
  const started = new Promise<AbortSignal>((resolve) => { start = resolve })
  const { endpoint, db } = await boot(async () => {
    throw new Error('已取消请求不应进入第二阶段')
  }, undefined, { empty: true, workflowGenerator: async (_input, signal) => {
    start(signal)
    return new Promise(() => {})
  } })
  const client = new AbortController()
  const response = fetch(endpoint + '/v1/task-plans', {
    method: 'POST', signal: client.signal,
    headers: { 'x-orchestra-secret': 'planning-contract-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ goal: '生成试验计划' }),
  })
  const outcome = expect(response).rejects.toMatchObject({ name: 'AbortError' })
  const planningSignal = await started
  client.abort()
  await outcome
  await expect.poll(() => planningSignal.aborted).toBe(true)
  for (const table of ['tasks', 'workflows', 'task_plans']) {
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
  }
})

it('独立流程生成通过既有两参数回调并保留 45 秒默认时限', async () => {
  const generate = vi.fn(async () => reviewDoc)
  const { client } = await boot(async () => valid(), undefined, { empty: true, workflowGenerator: generate })
  const timers = vi.spyOn(globalThis, 'setTimeout')
  try {
    const result = await client.post<{ definition: WorkflowDoc }>('/v1/workflows/generate', { goal: '生成试验流程' })
    expect(result.data.definition).toEqual(reviewDoc)
    expect(generate.mock.calls[0]).toHaveLength(2)
    expect(timers.mock.calls.some(([, timeout]) => timeout === 45_000)).toBe(true)
    expect(timers.mock.calls.some(([, timeout]) => timeout === 30_000 || timeout === 120_000)).toBe(false)
  } finally { timers.mockRestore() }
})

it('规划、质量检查、人工确认与启动回执绑定同一份固定版本和模型建议', async () => {
  const { client, api, planCommands, db, endpoint } = await boot(async (input, signal) => {
    expect(signal.aborted).toBe(false)
    expect(input.requirements).toEqual([{ id: 'R1', text: '保留系统证据' }])
    expect(input.workflows).toEqual([expect.objectContaining({
      workflowId: 'review', version: '1',
      nodes: [
        expect.objectContaining({ id: 'collect', dependsOn: [], toolAllow: [] }),
        expect.objectContaining({ id: 'verify', dependsOn: ['collect'], toolAllow: ['ro.check'] }),
      ],
    })])
    return valid()
  })
  expect((await api.getTaskPlanCapability()).data).toEqual({ enabled: true })
  expect((await fetch(endpoint + '/v1/task-plans/capability')).status).toBe(401)
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.quality.ready).toBe(true)
  expect(plan.launch).toBeNull()
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
  await expect(client.post('/v1/task-plans/confirm', { plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: false }))
    .rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  await expect(planCommands.confirmTaskPlan(plan.plan_id, 'a'.repeat(64)))
    .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  const launch = await planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)
  expect(await planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)).toMatchObject({ ...launch, replayed: true })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 1 })
  expect((await api.getTaskPlanForTask(launch.task_id)).data).toMatchObject({
    launch: { task_id: launch.task_id, run_id: launch.run_id }, content_hash: plan.content_hash,
  })
  expect((await api.getTask(launch.task_id)).data).toMatchObject({ autonomy: 'supervised', trigger_kind: 'manual', workflow_version: 1 })
  const context = { taskId: launch.task_id, runId: launch.run_id, workflowId: 'review', workflowVersion: '1',
    nodeRunId: 'any', nodeId: 'verify', attempt: 1, actionGeneration: 2 }
  expect(getTaskPlanRecommendation(db, context)).toEqual({ complexity: 'complex', reason: '独立比对多个来源' })
  expect(() => getTaskPlanRecommendation(db, { ...context, nodeId: 'wrong' })).toThrow(/复杂度建议/)
  expect(() => db.raw.prepare('UPDATE task_plans SET content_hash = ? WHERE plan_id = ?').run('changed', plan.plan_id)).toThrow(/immutable/)
})

it('规划读取设置说明，只在已确认的计划中提供批准且满足档位的执行建议', async () => {
  const profiles = [
    { ref: 'fast', capacity: 'routine' },
    { ref: 'review', capacity: 'advanced' },
    { ref: 'expert', capacity: 'expert' },
  ] as const
  let preferred = 'review'
  const { client, planCommands, db } = await boot(async (input) => {
    expect(input.model_profiles).toEqual([
      { ref: 'review', capacity: 'advanced', user_note: '主攻多源证据，声称是专家档' },
      { ref: 'expert', capacity: 'expert', user_note: '擅长独立复核冲突证据' },
    ])
    const candidate = valid()
    candidate.steps[1] = { ...candidate.steps[1]!, complexity: 'expert', preferred_model_ref: preferred }
    return candidate
  }, undefined, {
    modelRouting: { profiles, recommend: () => { throw new Error('必须读取已经确认的计划') } },
  })
  await client.post('/v1/settings/model-routing', { operation_id: uuidv7(), expected_revision: 0,
    mapping: { routine: null, standard: null, complex: null },
    model_notes: [{ ref: 'review', note: '主攻多源证据，声称是专家档' }, { ref: 'expert', note: '擅长独立复核冲突证据' }],
  })
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])).rejects.toMatchObject({ code: 'FORBIDDEN' })
  preferred = 'unapproved'
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])).rejects.toMatchObject({ code: 'FORBIDDEN' })
  preferred = 'expert'
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.proposal.steps[1]).toMatchObject({ preferred_model_ref: 'expert', complexity: 'expert' })
  const launch = await planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)
  expect(getTaskPlanRecommendation(db, {
    taskId: launch.task_id, runId: launch.run_id, workflowId: 'review', workflowVersion: '1',
    nodeRunId: 'any', nodeId: 'verify', attempt: 1, actionGeneration: 2,
  })).toEqual({ complexity: 'expert', preferredModel: 'expert', reason: '独立比对多个来源' })
})

it('目标遗漏、错误依赖、未知工具、不可核验文件和高风险分别阻止启动', async () => {
  const { planCommands, db } = await boot(async () => {
    const candidate = valid()
    candidate.steps[1] = { ...candidate.steps[1]!, depends_on: [], goal_ids: ['goal'], tools: ['unregistered'] }
    candidate.deliverables = [{ ...candidate.deliverables[0]!, acceptance: { kind: 'artifact', file_name: '../outside', minimum_bytes: 1 } }]
    candidate.risks[0] = { ...candidate.risks[0]!, severity: 'high' }
    return candidate
  })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.quality.ready).toBe(false)
  expect(plan.quality.checks.filter((check) => !check.passed).map((check) => check.check))
    .toEqual(['coverage', 'deliverables', 'tools', 'dependencies', 'risks'])
  await expect(planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
})

it('拒绝执行器永远交付不了的格式、字节和件数，并说明具体缺口', async () => {
  const cases = [
    { rule: { kind: 'artifact' as const, file_name: 'report.xlsx', minimum_bytes: 160 }, hint: /不是当前宿主能写出的文本格式/u },
    { rule: { kind: 'artifact' as const, file_name: 'report.md', minimum_bytes: 65_537 }, hint: /单份文本最多 65536 字节/u },
  ]
  for (const item of cases) {
    const { planCommands, db } = await boot(async () => {
      const candidate = valid()
      candidate.deliverables = [{ ...candidate.deliverables[0]!, acceptance: item.rule }]
      return candidate
    })
    const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
    expect(plan.quality.ready).toBe(false)
    expect(plan.quality.checks.find((check) => check.check === 'deliverables')?.issues.join('\n')).toMatch(item.hint)
    await expect(planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
    await closers.splice(0).reduce(async (all: Promise<void>, close) => { await all; await close() }, Promise.resolve())
  }
})

it('同一节点超过 8 份文件时要求拆分到多个步骤', async () => {
  const { planCommands } = await boot(async () => {
    const candidate = valid()
    candidate.deliverables = Array.from({ length: 9 }, (_, index) => ({
      title: '报告 ' + String(index + 1), node_id: 'verify', goal_ids: ['goal'],
      acceptance: { kind: 'artifact' as const, file_name: 'report-' + String(index + 1) + '.md', minimum_bytes: 16 },
    }))
    return candidate
  })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.quality.ready).toBe(false)
  expect(plan.quality.checks.find((check) => check.check === 'deliverables')?.issues.join('\n')).toMatch(/同一节点最多交付 8 份/u)
})

it('人工确认之前重新校验工具；已撤销工具能力的计划不能创建运行', async () => {
  const { planCommands, registry } = await boot(async () => valid())
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.quality.ready).toBe(true)
  registry.register({ ...descriptor, capability: 'mutating' })
  await expect(planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
})

it('经过耐久批准的计划由生产扫描派发，带确认后的任务目标和固定工具范围', async () => {
  const spawned: SpawnParams[] = []
  const { planCommands, db } = await boot(async () => valid(), (input) => { spawned.push(input) })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(spawned).toHaveLength(0)
  const { run_id } = await planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)
  await expect.poll(() => spawned.length, { timeout: 5_000 }).toBe(1)
  const first = spawned[0]!
  expect(first).toMatchObject({
    inheritHistory: false,
    input: { task_goal: '核对项目交付', step: '收集交付附件' },
    toolPolicy: { allow: [] },
  })
  expect(db.raw.prepare('SELECT run_id, node_id FROM node_runs WHERE node_run_id = ?').get(first.nodeRunId))
    .toEqual({ run_id, node_id: 'collect' })
})

function proposalFor(input: Parameters<TaskPlanningOptions['propose']>[0]): TaskPlanProposal {
  const workflow = input.workflows[0]!
  return { ...valid(), workflow_id: workflow.workflowId, workflow_version: workflow.version }
}

const invalidWaitDoc = {
  ...reviewDoc,
  nodes: [...reviewDoc.nodes, { node_id: 'wait', type: 'wait', title: '等待', position: { x: 300, y: 0 },
    config: { wait_kind: 'timer', match: { type: 'task.timer' }, max_wait_ms: 8 * 24 * 60 * 60 * 1000 } }],
  edges: [...reviewDoc.edges, { from: 'verify', to: 'wait' }],
}

it('空库自动生成任务专属流程，真实测试、发布、并发确认及回执重放形成闭环', async () => {
  const signals: string[] = []
  const spawned: SpawnParams[] = []
  const { client, planCommands, api, db, catalog, registry } = await boot(async (input, signal) => {
    expect(signal.aborted).toBe(false)
    signals.push('plan')
    expect(input.workflows).toEqual([expect.objectContaining({
      workflowId: expect.stringMatching(/^tl_/), version: '1',
      nodes: [
        expect.objectContaining({ id: 'collect', dependsOn: [], toolAllow: [] }),
        expect.objectContaining({ id: 'verify', dependsOn: ['collect'], toolAllow: ['ro.check'] }),
      ],
    })])
    return proposalFor(input)
  }, (input) => { spawned.push(input) }, {
    empty: true,
    workflowGenerator: async ({ goal }, signal) => {
      expect(signal.aborted).toBe(false)
      expect(goal).toBe('核对项目交付；保留系统证据')
      signals.push('generate')
      return reviewDoc
    },
  })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  const { owner_task_id, auto_workflow_id } = plan
  expect(signals).toEqual(['generate', 'plan'])
  expect(plan).toMatchObject({ quality: { ready: true }, launch: null,
    auto_workflow_id: plan.proposal.workflow_id, owner_task_id: expect.any(String) })
  expect(spawned).toHaveLength(0)
  expect(db.raw.prepare('SELECT status, current_run_id FROM tasks WHERE task_id = ?').get(owner_task_id!))
    .toEqual({ status: 'reserved', current_run_id: null })
  expect(db.raw.prepare('SELECT scope, owner_task_id FROM workflows WHERE workflow_id = ?').get(auto_workflow_id!))
    .toEqual({ scope: 'task_local', owner_task_id })
  expect(db.raw.prepare('SELECT passed FROM workflow_draft_tests WHERE workflow_id = ?').all(auto_workflow_id!))
    .toEqual([{ passed: 1 }])
  expect(db.raw.prepare('SELECT v.version, v.published_by, v.content_hash, p.workflow_hash FROM workflow_versions v '
    + 'JOIN task_plans p ON p.auto_workflow_id = v.workflow_id WHERE p.plan_id = ?').get(plan.plan_id))
    .toEqual({ version: '1', published_by: expect.any(String), content_hash: catalog.definitionHash(auto_workflow_id!, '1'),
      workflow_hash: catalog.definitionHash(auto_workflow_id!, '1') })

  const confirm = { plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true } as const
  await expect(client.post('/v1/task-plans/confirm', { ...confirm, owner_task_id: 'fraud' }))
    .rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  await expect(client.post('/v1/runs/start', {
    task_id: owner_task_id, taskTitle: plan.proposal.title, workflowId: auto_workflow_id, workflowVersion: '1', operationId: uuidv7(),
  })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(planCommands.confirmTaskPlan(plan.plan_id, 'a'.repeat(64)))
    .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  const planning = createTaskPlanningHost(db, catalog, registry)
  expect(() => planning.confirm(confirm, 'another-actor', now)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 })

  const launches = await Promise.all(Array.from({ length: 3 }, async () => {
    const response = await client.post<{ task_id: string; run_id: string; replayed: boolean }>('/v1/task-plans/confirm', confirm)
    return response.data
  }))
  const first = launches.find((launch) => !launch.replayed)!
  expect(launches.filter((launch) => !launch.replayed)).toHaveLength(1)
  expect(first.task_id).toBe(owner_task_id)
  expect(launches.map((launch) => launch.run_id)).toEqual(Array(3).fill(first.run_id))
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 })
  expect(db.raw.prepare('SELECT o.task_id, o.run_id FROM task_plans p '
    + 'JOIN start_run_operations o ON p.launch_operation_id = o.operation_id WHERE p.plan_id = ?').all(plan.plan_id))
    .toEqual([{ task_id: first.task_id, run_id: first.run_id }])
  expect((await api.getTaskPlanForTask(first.task_id)).data?.launch).toEqual({ task_id: first.task_id, run_id: first.run_id })
  await expect.poll(() => spawned.length, { timeout: 5_000 }).toBe(1)
  expect(spawned[0]).toMatchObject({ input: { task_goal: '核对项目交付', step: '收集交付附件' } })
})

it('候选重排提拔较早发布的相关流程，模型拒绝候选时生成新的任务专属流程', async () => {
  const offered: string[][] = []
  const { planCommands, publish } = await boot(async (input) => {
    const ids = input.workflows.map((workflow) => workflow.workflowId)
    offered.push(ids)
    return ids[0]?.startsWith('tl_') ? proposalFor(input) : { kind: 'no_candidate', reason: '需要任务专属流程' }
  }, undefined, { empty: true, workflowGenerator: async () => reviewDoc })
  publish('old-relevant', { ...reviewDoc, name: '预算追踪' }, '2026-01-01T00:00:00.000Z')
  for (let index = 0; index < 24; index += 1) publish('filler-' + String(index).padStart(2, '0'))
  const first = await planCommands.proposeTaskPlan('预算追踪', ['保留系统证据'])
  const second = await planCommands.proposeTaskPlan('预算追踪', ['保留系统证据'])
  expect(offered[0]).toEqual(['old-relevant', ...Array.from({ length: 23 }, (_, index) => 'filler-' + String(index).padStart(2, '0'))])
  expect(offered[1]).toEqual([first.auto_workflow_id])
  expect(offered[2]).toEqual(offered[0])
  expect(offered[3]).toEqual([second.auto_workflow_id])
  expect(second.owner_task_id).not.toBe(first.owner_task_id)
})

it('标记整个坐标对象及坐标分量无效的流程布局错误', async () => {
  const { planning } = await boot(async (input) => proposalFor(input), undefined, {
    empty: true,
    workflowGenerator: async () => ({ ...reviewDoc, nodes: [
      { ...reviewDoc.nodes[0], position: null },
      { ...reviewDoc.nodes[1], position: { x: 'left', y: 0 } },
      { ...reviewDoc.nodes[2], position: { x: 0, y: 'top' } },
    ] }),
  })
  await expect(planning.propose({ goal: '核对项目交付', requirements: [] }, 'host', now)).rejects.toMatchObject({
    code: 'WORKFLOW_DEFINITION_INVALID',
    details: { planning_issue: 'layout', fields: ['nodes.0.position', 'nodes.1.position.x', 'nodes.2.position.y'] },
  })
})

it('诊断字段截断后仍区分第 13 项为结构错误的流程', async () => {
  const { planning } = await boot(async (input) => proposalFor(input), undefined, {
    empty: true,
    workflowGenerator: async () => ({ name: reviewDoc.name, nodes: [
      ...Array.from({ length: 6 }, (_, index) => ({ node_id: `draft_${index}`, position: { x: 'left', y: 'top' } })),
      { node_id: 'bad_type', type: 1 },
    ] }),
  })
  const error = await planning.propose({ goal: '核对项目交付', requirements: [] }, 'host', now).catch((error: unknown) => error)
  expect(error).toMatchObject({
    code: 'WORKFLOW_DEFINITION_INVALID',
    details: { fields: Array.from({ length: 6 }, (_, index) => [`nodes.${index}.position.x`, `nodes.${index}.position.y`]).flat() },
  })
  expect(error).not.toHaveProperty('details.planning_issue')
})

it('模型返回未提供的新生成流程版本时拒绝持久化计划', async () => {
  const { planCommands, db } = await boot(async (input) => ({ ...proposalFor(input), workflow_version: '2' }),
    undefined, { empty: true, workflowGenerator: async () => reviewDoc })
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据']))
    .rejects.toMatchObject({ code: 'WORKFLOW_DEFINITION_INVALID' })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM workflows').get()).toEqual({ n: 0 })
})

it('确认拒绝目标归属变化和停用；启动事务失败后可重试同一回执', async () => {
  const { client, planCommands, db, commands } = await boot(async (input) => proposalFor(input), undefined, {
    empty: true, workflowGenerator: async () => reviewDoc,
  })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  const { auto_workflow_id: workflowId, owner_task_id: taskId } = plan
  const confirm = async () => (await client.post('/v1/task-plans/confirm', {
    plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true,
  })).data
  const other = commands.reserveTask({ title: '另一任务', actor: 'host', now, operationId: uuidv7() }) as { task_id: string }
  const updateOwner = db.raw.prepare('UPDATE workflows SET owner_task_id = ? WHERE workflow_id = ?')
  updateOwner.run(other.task_id, workflowId!)
  await expect(confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  updateOwner.run(taskId!, workflowId!)
  commands.setWorkflowStatus({ workflowId: workflowId!, status: 'disabled', expectedStatus: 'active', actor: 'host', now, operationId: uuidv7() })
  await expect(confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  commands.setWorkflowStatus({ workflowId: workflowId!, status: 'active', expectedStatus: 'disabled', actor: 'host', now, operationId: uuidv7() })
  const archive = (archived: boolean, expected: string | null) => client.post<{ archived_at: string | null }>('/v1/tasks/archive', {
    task_id: taskId, archived, expected_archived_at: expected, operation_id: uuidv7(),
  })
  const { data: archived } = await archive(true, null)
  await expect(confirm()).rejects.toMatchObject({ code: 'STALE_GENERATION' })
  await archive(false, archived.archived_at)
  db.raw.exec("CREATE TRIGGER fail_plan_launch BEFORE INSERT ON start_run_operations BEGIN SELECT RAISE(ABORT, 'test launch failure'); END")
  await expect(confirm()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM start_run_operations').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId!)).toEqual({ status: 'reserved' })
  expect(db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(other.task_id)).toEqual({ status: 'reserved' })
  db.raw.exec('DROP TRIGGER fail_plan_launch')
  await expect(confirm()).resolves.toMatchObject({ task_id: taskId, replayed: false })
})

it('测试与发布后的计划插入失败会回滚自动生成的整个事务，重试可以成功', async () => {
  const { planCommands, db } = await boot(async (input) => proposalFor(input), undefined, {
    empty: true, workflowGenerator: async () => reviewDoc,
  })
  const ledgerSize = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()
  db.raw.exec("CREATE TRIGGER fail_plan_write BEFORE INSERT ON task_plans BEGIN SELECT RAISE(ABORT, 'test write failure'); END")
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据']))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  for (const table of ['tasks', 'workflows', 'workflow_drafts', 'workflow_draft_tests', 'workflow_versions', 'task_plans', 'inbox']) {
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get()).toEqual({ n: 0 })
  }
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(ledgerSize)
  db.raw.exec('DROP TRIGGER fail_plan_write')
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据']))
    .resolves.toMatchObject({ quality: { ready: true } })
})

it('运行定义不能装入目录时，自动生成不留下会导致重启失败的版本', async () => {
  const { planCommands, db, catalog } = await boot(async (input) => proposalFor(input), undefined, {
    empty: true, workflowGenerator: async () => invalidWaitDoc,
  })
  await expect(planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据']))
    .rejects.toMatchObject({ code: 'WORKFLOW_VALIDATION_FAILED' })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  expect(catalog.hydrate()).toBe(0)
})

it('普通发布也拒绝目录无法加载的运行定义，且草稿和回执均可继续重试', async () => {
  const { publish, db, catalog } = await boot(async () => valid(), undefined, { empty: true })
  expect(() => publish('invalid-wait', invalidWaitDoc)).toThrow(expect.objectContaining({ code: 'WORKFLOW_VALIDATION_FAILED' }))
  expect(db.raw.prepare('SELECT current_version FROM workflows WHERE workflow_id = ?').get('invalid-wait'))
    .toEqual({ current_version: null })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE kind = ?').get('workflow.publish')).toEqual({ n: 0 })
  expect(catalog.hydrate()).toBe(0)
  expect(publish('review')).toMatchObject({ workflow_id: 'review', version: '1' })
  expect(catalog.hydrate()).toBe(1)
})

it('S5 拒绝加载、发布和启动 wf_release_v1，普通流程仍可启动', async () => {
  const { commands, client, db, publish } = await boot(async () => valid(), undefined, { empty: true })
  const workflowId = 'wf_release_v1'
  const definition = { workflow_id: workflowId, workflow_version: '1', nodes: [{ node_id: 'release', type: 'agent' as const }] }
  const rejected = { code: 'FORBIDDEN', details: { current: 'S5', capability: 'release' } }
  expect(() => commands.loadWorkflow(definition)).toThrow(expect.objectContaining(rejected))
  expect(() => publish(workflowId)).toThrow(expect.objectContaining(rejected))
  const start = { taskTitle: '核对发布', workflowId, workflowVersion: '1', operationId: uuidv7() }
  await expect(client.post('/v1/runs/start', start)).rejects.toMatchObject(rejected)
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()).toEqual({ n: 0 })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM start_run_operations').get()).toEqual({ n: 0 })

  expect(new WorkflowCatalog('S6').load(definition)).toMatchObject({ workflow_id: workflowId, workflow_version: '1' })
  publish('review')
  await expect(client.post('/v1/runs/start', { ...start, workflowId: 'review' })).resolves.toMatchObject({
    data: { workflow_id: 'review', replayed: false },
  })
})


it('P02 用户指定流程时只在该流程里规划，指错流程给出明确原因', async () => {
  const { planCommands, db } = await boot(async () => valid())
  const pinned = await planCommands.proposeTaskPlan('核对项目交付', [], undefined,
    { workflow_id: 'review', workflow_version: '1' })
  expect(pinned.proposal.workflow_id).toBe('review')
  expect(pinned.proposal.workflow_version).toBe('1')
  // 指到不存在的流程：明确报错，不能悄悄换一个流程继续。
  await expect(planCommands.proposeTaskPlan('核对项目交付', [], undefined, { workflow_id: 'missing-flow' }))
    .rejects.toMatchObject({ code: 'WORKFLOW_NOT_PUBLISHED' })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
})
