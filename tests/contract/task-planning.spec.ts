import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { getTaskPlanRecommendation, serveOrchestra, type TaskPlanningOptions, type TaskPlanProposal } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import type { SpawnParams } from '../../src/executor/bridge.ts'
import { OrchError } from '../../src/core/errors.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'

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

async function boot(propose: TaskPlanningOptions['propose'], observeSpawn?: (input: SpawnParams) => void) {
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
    executor: { registry, bridge, runner: new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => { throw new Error('plan must not run a tool') },
    }, directory) },
  })
  closers.push(async () => {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const { commands, db } = service.orchestra
  const definition = {
    name: '交付复核',
    nodes: [
      { node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 } },
      { node_id: 'collect', type: 'agent', title: '收集', position: { x: 100, y: 0 } },
      { node_id: 'verify', type: 'agent', title: '核对', position: { x: 200, y: 0 }, config: { tools: { allow: ['ro.check'] } } },
    ],
    edges: [{ from: 'start', to: 'collect' }, { from: 'collect', to: 'verify' }],
  }
  commands.createWorkflow({ workflowId: 'review', name: '交付复核', definition, actor: 'host', now, operationId: uuidv7() })
  commands.publishWorkflow({ workflowId: 'review', revision: 1, baseVersion: 0, note: '可复用', actor: 'host', now, operationId: uuidv7() })
  const client = createApiClient(service.endpoint, (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', secret)
    return fetch(input, { ...init, headers })
  })
  return { endpoint: service.endpoint, client, api: createResourcesApi(client), planCommands: createTaskCommands(client), db, registry }
}

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
