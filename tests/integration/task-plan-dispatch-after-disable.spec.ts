import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { serveOrchestra } from '../../src/index.ts'
import type { NodeSpec } from '../../src/service/dispatcher.ts'
import { getTaskSummarySnapshot } from '../../src/service/queries/tasks.ts'
import {
  createTaskPlanningHost,
  resolveApprovedPlanNodeSpecs,
  type TaskPlanProposal,
} from '../../src/service/task-planning.ts'
import { createTriggerDispatchPump, type TriggerRunReady } from '../../src/service/task-trigger-dispatch.ts'

const SECRET = 'plan-disable-secret'
const NOW = '2026-11-18T02:00:00.000Z'
const workflowId = 'review'

const checkTool = { name: 'ro.check', capability: 'read_only' as const, command: { bin: 'check', args: [] as string[] } }

// 不声明工具的流程：草稿测试不需要执行器，服务也就不会自动派发，计划派发完全由测试自己驱动
const plainDefinition = {
  name: '交付复核',
  nodes: [
    { node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 }, config: {} },
    { node_id: 'collect', type: 'agent', title: '收集', position: { x: 100, y: 0 }, config: {} },
    { node_id: 'verify', type: 'agent', title: '核对', position: { x: 200, y: 0 }, config: {} },
  ],
  edges: [{ from: 'start', to: 'collect' }, { from: 'collect', to: 'verify' }],
}

// v2 改了节点名：已经启动的运行不该被后来的新版本改绑
const plainDefinitionV2 = {
  name: '交付复核',
  nodes: [
    { node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 }, config: {} },
    { node_id: 'gather', type: 'agent', title: '收集', position: { x: 100, y: 0 }, config: {} },
    { node_id: 'check', type: 'agent', title: '核对', position: { x: 200, y: 0 }, config: {} },
  ],
  edges: [{ from: 'start', to: 'gather' }, { from: 'gather', to: 'check' }],
}

// 声明了只读工具的流程：草稿测试要靠执行器提供 registry，所以这条要挂执行器
const toolDefinition = {
  name: '交付复核',
  nodes: [
    { node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 }, config: {} },
    { node_id: 'collect', type: 'agent', title: '收集', position: { x: 100, y: 0 }, config: {} },
    { node_id: 'verify', type: 'agent', title: '核对', position: { x: 200, y: 0 }, config: { tools: { allow: ['ro.check'] } } },
  ],
  edges: [{ from: 'start', to: 'collect' }, { from: 'collect', to: 'verify' }],
}

const plainProposal = (): TaskPlanProposal => ({
  title: '项目交付核对',
  workflow_id: workflowId,
  workflow_version: '1',
  steps: [
    { node_id: 'collect', description: '清点交付附件', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '重复清点' },
    { node_id: 'verify', description: '核对交付结论', goal_ids: ['goal', 'R1'], depends_on: ['collect'], tools: [], complexity: 'complex', model_reason: '独立比对多个来源' },
  ],
  deliverables: [
    { title: '交付核对报告', node_id: 'verify', goal_ids: ['goal'], acceptance: { kind: 'artifact', file_name: '交付.md', minimum_bytes: 160 } },
    { title: '核验结论记录', node_id: 'verify', goal_ids: ['R1'], acceptance: { kind: 'artifact', file_name: '核验.md', minimum_bytes: 160 } },
  ],
  risks: [{ severity: 'medium', description: '上游附件缺失', mitigation: '在报告里列出缺口', node_id: 'collect' }],
})

const toolProposal = (): TaskPlanProposal => ({
  title: '项目交付核对',
  workflow_id: workflowId,
  workflow_version: '1',
  steps: [
    { node_id: 'collect', description: '清点交付附件', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '重复清点' },
    { node_id: 'verify', description: '用系统工具核对', goal_ids: ['goal', 'R1'], depends_on: ['collect'], tools: ['ro.check'], complexity: 'complex', model_reason: '独立比对多个来源' },
  ],
  deliverables: [
    { title: '交付核对报告', node_id: 'verify', goal_ids: ['goal'], acceptance: { kind: 'artifact', file_name: '交付.md', minimum_bytes: 160 } },
    { title: '系统核验证据', node_id: 'verify', goal_ids: ['R1'], acceptance: { kind: 'tool_evidence', tool: 'ro.check', exit_code: 0 } },
  ],
  risks: [{ severity: 'medium', description: '上游附件缺失', mitigation: '在报告里列出缺口', node_id: 'collect' }],
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function boot(options: { tools?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-plan-disable-'))
  const registry = new ToolRegistry()
  registry.register(checkTool)
  const bridge = new BridgeClient({
    async request() { throw new OrchError('FORBIDDEN', '测试宿主不执行被派发的节点') },
    async *listen() {},
  })
  const service = await serveOrchestra({
    dbFile: join(dir, 'orchestra.sqlite'),
    secret: SECRET,
    phase: 'S5',
    asOfSeq: () => 0,
    listTasks: () => [],
    listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    ...(options.tools
      ? {
          executor: {
            registry,
            bridge,
            runner: new ReadOnlyToolRunner(registry, {
              readonlyAvailable: () => true,
              run: async () => { throw new Error('测试宿主不执行被派发的节点') },
            }, dir),
          },
        }
      : {}),
  })
  closers.push(async () => {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const { commands, db, catalog } = service.orchestra
  const definition = options.tools ? toolDefinition : plainDefinition
  commands.createWorkflow({
    workflowId, name: definition.name, scope: 'reusable', definition,
    actor: 'tester', now: NOW, operationId: uuidv7(),
  })
  expect(commands.testWorkflowDraft({ workflowId, revision: 1, now: NOW }).passed).toBe(true)
  commands.publishWorkflow({
    workflowId, revision: 1, baseVersion: 0, note: 'fixture', actor: 'tester', now: NOW, operationId: uuidv7(),
  })
  const planning = createTaskPlanningHost(db, catalog, registry, {
    propose: async () => (options.tools ? toolProposal() : plainProposal()),
  })
  return { db, catalog, commands, planning, registry }
}

function catchError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

it('流程停用后，已启动运行的排队节点仍按自己固定的版本派发', async () => {
  const { db, catalog, commands, planning, registry } = await boot()
  const plan = (await planning.propose({ goal: '核对项目交付', requirements: ['保留系统核验证据'] }, 'tester', NOW)).view
  expect(plan.quality.ready).toBe(true)
  const launch = planning.confirm({ plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'tester', NOW)
  commands.setWorkflowStatus({
    workflowId, status: 'disabled', expectedStatus: 'active', now: NOW, actor: 'tester', operationId: uuidv7(),
  })

  const dispatched: Array<{ run_id: string; specs: Record<string, NodeSpec> }> = []
  const errors: unknown[] = []
  const pump = createTriggerDispatchPump(
    db,
    undefined,
    async (run, specs) => { dispatched.push({ run_id: run.run_id, specs }) },
    (error) => { errors.push(error) },
    (run) => resolveApprovedPlanNodeSpecs(db, catalog, registry, run),
    { secret: SECRET },
  )
  pump.tick()
  await expect.poll(() => dispatched.length, { timeout: 5000 }).toBe(1)
  await pump.close()

  expect(errors).toEqual([])
  expect(dispatched[0]?.run_id).toBe(launch.run_id)
  expect(Object.keys(dispatched[0]?.specs ?? {}).sort()).toEqual(['collect', 'verify'])
})

it('流程停用后，新的根运行被拒绝，错误与版本不匹配分得开', async () => {
  const { db, commands, planning } = await boot()
  const plan = (await planning.propose({ goal: '核对项目交付', requirements: ['保留系统核验证据'] }, 'tester', NOW)).view
  commands.setWorkflowStatus({
    workflowId, status: 'disabled', expectedStatus: 'active', now: NOW, actor: 'tester', operationId: uuidv7(),
  })

  const error = catchError(() => planning.confirm(
    { plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'tester', NOW,
  ))
  expect(error).toBeInstanceOf(OrchError)
  expect((error as OrchError).code).toBe('FORBIDDEN')
  expect((error as OrchError).code).not.toBe('CONFIRMATION_MISMATCH')
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
})

it('已启动的运行继续绑定原固定版本，后来发布的新版本不改变绑定', async () => {
  const { db, catalog, commands, planning, registry } = await boot()
  const plan = (await planning.propose({ goal: '核对项目交付', requirements: ['保留系统核验证据'] }, 'tester', NOW)).view
  const launch = planning.confirm({ plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'tester', NOW)

  const draft = commands.openWorkflowDraft({ workflowId, baseVersion: 1, actor: 'tester', now: NOW, operationId: uuidv7() }) as { revision: number }
  const updated = commands.updateWorkflowDraft({
    workflowId, revision: draft.revision, definition: plainDefinitionV2, actor: 'tester', now: NOW, operationId: uuidv7(),
  }) as { revision: number }
  expect(commands.testWorkflowDraft({ workflowId, revision: updated.revision, now: NOW }).passed).toBe(true)
  commands.publishWorkflow({
    workflowId, revision: updated.revision, baseVersion: 1, note: 'v2', actor: 'tester', now: NOW, operationId: uuidv7(),
  })
  commands.setWorkflowStatus({
    workflowId, status: 'disabled', expectedStatus: 'active', now: NOW, actor: 'tester', operationId: uuidv7(),
  })

  const dispatched: Array<{ run_id: string; specs: Record<string, NodeSpec> }> = []
  const pump = createTriggerDispatchPump(
    db,
    undefined,
    async (run, specs) => { dispatched.push({ run_id: run.run_id, specs }) },
    () => {},
    (run) => resolveApprovedPlanNodeSpecs(db, catalog, registry, run),
    { secret: SECRET },
  )
  pump.tick()
  await expect.poll(() => dispatched.length, { timeout: 5000 }).toBe(1)
  await pump.close()

  expect(db.raw.prepare('SELECT workflow_version FROM runs WHERE run_id = ?').get(launch.run_id)).toMatchObject({ workflow_version: 1 })
  expect(Object.keys(dispatched[0]?.specs ?? {}).sort()).toEqual(['collect', 'verify'])
})

it('运行期工具权限被撤销给出可区分的阻断，并把运行推进到待处理', async () => {
  const { db, catalog, planning, registry } = await boot({ tools: true })
  const plan = (await planning.propose({ goal: '核对项目交付', requirements: ['保留系统核验证据'] }, 'tester', NOW)).view
  expect(plan.quality.ready).toBe(true)
  const launch = planning.confirm({ plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'tester', NOW)

  // 权限在确认之后被撤销：确认时是只读工具，运行期已经不算数了
  registry.register({ ...checkTool, capability: 'mutating' })
  const run = db.raw.prepare(
    "SELECT run_id, task_id, workflow_id, CAST(workflow_version AS TEXT) AS workflow_version FROM runs WHERE run_id = ?",
  ).get(launch.run_id) as TriggerRunReady

  const error = catchError(() => resolveApprovedPlanNodeSpecs(db, catalog, registry, run))
  expect(error).toBeInstanceOf(OrchError)
  expect((error as OrchError).code).toBe('TOOL_NOT_ALLOWED')
  expect((error as OrchError).code).not.toBe('CONFIRMATION_MISMATCH')
  expect((error as OrchError).details).toMatchObject({ violations: [{ node_id: 'verify', tool: 'ro.check' }] })

  // 派发泵里同样的阻断：节点收失败、运行收失败、任务进待处理车道
  const errors: unknown[] = []
  const pump = createTriggerDispatchPump(
    db,
    undefined,
    async () => { throw new Error('权限被撤销时不应派发') },
    (failure) => { errors.push(failure) },
    (ready) => resolveApprovedPlanNodeSpecs(db, catalog, registry, ready),
    { secret: SECRET },
  )
  pump.tick()
  await expect.poll(
    () => db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(launch.run_id),
    { timeout: 5000 },
  ).toMatchObject({ status: 'failed' })
  await pump.close()

  expect(errors).toHaveLength(1)
  expect(db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(launch.task_id)).toMatchObject({ status: 'failed' })
  const nodes = db.raw.prepare('SELECT node_id, status FROM node_runs WHERE run_id = ?').all(launch.run_id)
  expect(nodes.length).toBeGreaterThan(0)
  expect(nodes.every((node) => node.status === 'failed')).toBe(true)
  expect(nodes.map((node) => node.node_id)).toContain('verify')
  const events = db.raw.prepare(
    "SELECT type, payload FROM node_run_events WHERE node_run_id IN (SELECT node_run_id FROM node_runs WHERE run_id = ?)",
  ).all(launch.run_id)
  expect(events.map((event) => event.type)).toContain('dispatch.failed')
  const blocked = events.find((event) => event.type === 'dispatch.failed')
  expect(JSON.parse(String(blocked?.payload ?? '{}'))).toMatchObject({ error_code: 'TOOL_NOT_ALLOWED' })
  expect(getTaskSummarySnapshot(db, launch.task_id).item).toMatchObject({ lane: 'attention' })
})
