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
import { createTaskPlanningHost, readApprovedTaskPlanForRun, resolveApprovedPlanNodeSpecs } from '../../src/service/task-planning.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { discardDraft } from '../../src/service/task-plan-drafts.ts'
import { expireMaterials } from '../../src/service/plan-materials.ts'
import { planningTimeoutDefaults } from '../../src/service/planning-settings.ts'
import { callDshRework, readPublicationTargets } from '../../src/service/dsh-rework.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'
import { mergeRequirementsContracts, requirementsContractSchema, type RequirementsContract, type TaskRequirement } from '../../src/core/task-requirements.ts'
import { requirementIssues, type RequirementNode } from '../../src/service/task-requirement-checks.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { loadNodeRun } from '../../src/service/commands/lease.ts'
import { verifyArtifactCompletion } from '../../src/service/artifact-completion.ts'
import { createDeliveryReviewHost } from '../../src/service/delivery-review.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { readNativeExecutionPolicy } from '../../src/service/native-execution-policy.ts'

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
  interpret?: TaskPlanningOptions['interpret']
  timeoutMs?: number
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
    planning: { propose, interpret: options.interpret, timeoutMs: options.timeoutMs },
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

it('规划允许的八份文件和一段正文可以全部实际发布，普通文件第九份仍被拒绝',async()=>{
  const {planCommands,db}=await boot(async()=>{
    const candidate=valid()
    candidate.deliverables=[...Array.from({length:8},(_,i)=>({title:'文件'+i,node_id:'verify',goal_ids:['goal','R1'],
      acceptance:{kind:'artifact' as const,file_name:'file-'+i+'.md',minimum_bytes:1}})),
    {title:'会话总结',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'chat/text_result'}}]
    return candidate
  })
  const plan=await planCommands.proposeTaskPlan('核对项目交付',['保留系统证据'])
  expect(plan.quality.ready).toBe(true)
  const {run_id}=await planCommands.confirmTaskPlan(plan.plan_id,plan.content_hash)
  const node=db.raw.prepare("SELECT node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND node_id='verify'").get(run_id) as {node_run_id:string;attempt:number;action_generation:number}
  const at=new Date().toISOString()
  withTx(db,tx=>tx.run("UPDATE node_runs SET status='started',lease_id='count-test',lease_expires_at=? WHERE node_run_id=?",[new Date(Date.now()+60_000).toISOString(),node.node_run_id]))
  const host=createReworkHost(db,'planning-contract-secret')
  for(let i=0;i<8;i++)callDshRework(db,host,node,{action:'publish',operation_id:uuidv7(),file_name:'file-'+i+'.md',text:'complete file'},at)
  expect(()=>callDshRework(db,host,node,{action:'publish_text_result',operation_id:uuidv7(),deliverable_index:8,text:'全部文件已核对'},at)).not.toThrow()
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM artifact_contents WHERE node_run_id=?').get(node.node_run_id)).toMatchObject({n:9})
  expect(()=>callDshRework(db,host,node,{action:'publish',operation_id:uuidv7(),file_name:'file-9.md',text:'over limit'},at)).toThrow(/八份文本文件/)
})

it('普通文件不能与本步骤生成的会话正文使用同一文件名',async()=>{
  const {planCommands}=await boot(async()=>{
    const candidate=valid()
    candidate.deliverables=[{title:'文件',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'artifact',file_name:'会话正文-2.md',minimum_bytes:1}},
      {title:'总结',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'chat/text_result'}}]
    return candidate
  })
  const plan=await planCommands.proposeTaskPlan('核对项目交付',['保留系统证据'])
  expect(plan.quality.ready).toBe(false)
  expect(plan.quality.checks.find(check=>check.check==='deliverables')?.issues.join('\n')).toMatch(/会话正文.*另取名称/)
})

it('多文件返工复制保留的文件和会话正文，并为新尝试生成可验证的纯成果完成证据',async()=>{
  const {planCommands,db}=await boot(async()=>{
    const candidate=valid()
    candidate.steps[1]!.tools=[]
    candidate.deliverables=[
      {title:'报告',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'artifact',file_name:'report.md',minimum_bytes:1}},
      {title:'原始数据',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'artifact',file_name:'data.csv',minimum_bytes:1}},
      {title:'会话总结',node_id:'verify',goal_ids:['goal','R1'],acceptance:{kind:'chat/text_result'}},
    ]
    return candidate
  })
  const plan=await planCommands.proposeTaskPlan('核对项目交付',['保留系统证据'])
  expect(plan.quality.ready).toBe(true)
  const {run_id}=await planCommands.confirmTaskPlan(plan.plan_id,plan.content_hash)
  const nodeId=String(db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='verify'").get(run_id)!.node_run_id)
  const secret='planning-contract-secret',at=new Date().toISOString()
  const host=createReworkHost(db,secret)
  const start=(id:string)=>withTx(db,tx=>{
    tx.run("UPDATE node_runs SET status='started',side_effect_policy='pure',lease_id='manifest-test',lease_expires_at=? WHERE node_run_id=?",[new Date(Date.now()+60_000).toISOString(),id])
    const row=loadNodeRun(tx,id)
    return {node_run_id:id,attempt:row.attempt,action_generation:row.action_generation}
  })
  const old=start(nodeId)
  expect(readPublicationTargets(db,old)).toEqual({files:['report.md','data.csv'],
    texts:[{index:2,title:'会话总结',fileName:'会话正文-3.md'}]})
  expect(readPublicationTargets(db,{...old,action_generation:old.action_generation+1})).toBeNull()
  for(const file_name of ['report.md','data.csv'])callDshRework(db,host,old,{action:'publish',operation_id:uuidv7(),file_name,text:'original bytes'},at,secret)
  callDshRework(db,host,old,{action:'publish_text_result',operation_id:uuidv7(),deliverable_index:2,text:'保留的会话正文'},at,secret)
  withTx(db,tx=>tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[nodeId]))
  const originals=db.raw.prepare('SELECT a.artifact_id,a.sha256,c.file_name FROM artifacts a JOIN artifact_contents c USING(artifact_id) WHERE c.node_run_id=? ORDER BY c.file_name').all(nodeId) as Array<{artifact_id:string;sha256:string;file_name:string}>
  const source=originals.find(file=>file.file_name==='report.md')!
  const owner='service:'+sha256Hex(secret).slice(0,8)
  const request=host.request({operation_id:uuidv7(),run_id,target_node_run_id:nodeId,expected_revision:withTx(db,tx=>loadNodeRun(tx,nodeId)).revision,
    source_artifact_id:source.artifact_id,source_artifact_hash:source.sha256,reason:'更正报告',expected_result:'数据与正文原样保留',
    file_manifest:{originals:originals.map(file=>({...file,action:file.file_name==='report.md'?'revise':'keep'})),attachments:[]}},owner,at)
  expect(request.status).toBe('scheduled')
  const current=start(request.new_node_run_id!)
  expect(readPublicationTargets(db,current)).toBeNull()
  expect(readPublicationTargets(db,old)).toBeNull()
  callDshRework(db,host,current,{action:'publish',operation_id:uuidv7(),file_name:'report.md',text:'revised bytes'},at,secret)
  const proof=withTx(db,tx=>verifyArtifactCompletion(tx,secret,{...loadNodeRun(tx,current.node_run_id),status:'verifying'},at))
  expect(proof?.proof.artifacts.map(file=>file.file_name)).toEqual(['report.md','data.csv','会话正文-3.md'])
  const copied=db.raw.prepare("SELECT a.artifact_id,a.sha256,a.evidence_index FROM artifacts a JOIN artifact_contents c USING(artifact_id) WHERE c.node_run_id=? AND c.file_name='会话正文-3.md'").get(current.node_run_id)!
  expect(copied.sha256).toBe(sha256Hex('保留的会话正文'))
  expect(JSON.parse(String(copied.evidence_index))).toMatchObject({kind:'orchestra.chat-text.v1',node_run_id:current.node_run_id,attempt:current.attempt})
  expect(copied.artifact_id).not.toBe(originals.find(file=>file.file_name==='会话正文-3.md')!.artifact_id)
})

it('人工验收不能借同名新版满足的字节门槛去通过不合格旧稿，也不能借旧版通过不合格新版',async()=>{
  const {planCommands,db}=await boot(async()=>valid())
  const plan=await planCommands.proposeTaskPlan('核对项目交付',['保留系统证据'])
  const {run_id}=await planCommands.confirmTaskPlan(plan.plan_id,plan.content_hash)
  const node_run_id=String(db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='verify'").get(run_id)!.node_run_id)
  const at=new Date().toISOString(), later=new Date(Date.now()+1).toISOString(),last=new Date(Date.now()+2).toISOString()
  withTx(db,tx=>tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[node_run_id]))
  const old=registerRunArtifact(db,{artifactId:'short-old',runId:run_id,nodeRunId:node_run_id,fileName:'交付.md',bytes:Buffer.from('x')},at)
  const latest=registerRunArtifact(db,{artifactId:'qualified-new',runId:run_id,nodeRunId:node_run_id,fileName:'交付.md',bytes:Buffer.from('x'.repeat(160))},later)
  const owner='service:'+sha256Hex('planning-contract-secret').slice(0,8),host=createDeliveryReviewHost(db,'planning-contract-secret')
  const held=host.change({operation_id:uuidv7(),run_id,node_run_id,action:'hold'},owner,at)
  const selected=(artifact:typeof old)=>({operation_id:uuidv7(),run_id,node_run_id,action:'accept' as const,artifact_id:artifact.artifact_id,sha256:artifact.sha256,hold_id:held.hold_id,expected_revision:held.revision})
  expect(()=>host.change(selected(old),owner,later)).toThrow(/应审清单/)
  const accepted=host.change(selected(latest),owner,later)
  expect(accepted.status).toBe('accepted')
  registerRunArtifact(db,{artifactId:'short-newest',runId:run_id,nodeRunId:node_run_id,fileName:'交付.md',bytes:Buffer.from('x')},last)
  const again=host.change({operation_id:uuidv7(),run_id,node_run_id,action:'hold',hold_id:accepted.hold_id,expected_revision:accepted.revision},owner,last)
  expect(()=>host.change({...selected(latest),hold_id:again.hold_id,expected_revision:again.revision},owner,last)).toThrow(/成果不齐/)
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

it('P05 会话文字结果是一等交付类型，不再借用文件规则来验收', async () => {
  const { planCommands, db } = await boot(async () => {
    const candidate = valid()
    candidate.deliverables = [{ title: '会话结论', node_id: 'verify', goal_ids: ['goal'],
      acceptance: { kind: 'chat/text_result' } }, valid().deliverables[1]!]
    return candidate
  })
  const plan = await planCommands.proposeTaskPlan('核对项目交付', ['保留系统证据'])
  expect(plan.quality.ready).toBe(true)
  expect(plan.quality.checks.find((check) => check.check === 'deliverables')?.passed).toBe(true)
  expect(plan.proposal.deliverables[0]?.acceptance).toMatchObject({ kind: 'chat/text_result' })
  await expect(planCommands.confirmTaskPlan(plan.plan_id, plan.content_hash)).resolves.toMatchObject({ run_id: expect.any(String) })
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 1 })
})

it('pins an explicitly selected published workflow outside the discovery pool', async () => {
  const host = await boot(async () => valid(), undefined, { empty: true })
  host.publish('review', reviewDoc, '2026-11-17T01:00:00.000Z')
  for (let n = 0; n < 200; n++) host.publish('w-' + n, reviewDoc, '2026-11-18T01:00:00.000Z')
  const result = await host.planCommands.proposeTaskPlan('核对项目交付', ['核验'], undefined,
    { workflow_id: 'review', workflow_version: '1' })
  expect(result.proposal.workflow_id).toBe('review')
  expect(result.quality.ready).toBe(true)
}, 30_000)

it('subworkflow can plan read-only child tools without delegating them to its parent',async()=>{
 let tools:string[]=[]
 const {publish,planCommands}=await boot(async ()=>({ title:'处理报告',workflow_id:'parent',workflow_version:'1',
  steps:[{node_id:'sub',description:'取数据',goal_ids:['goal'],depends_on:[],tools,complexity:'routine',model_reason:'核对来源'},
         {node_id:'summary',description:'汇总',goal_ids:['goal'],depends_on:['sub'],tools:[],complexity:'routine',model_reason:'生成汇总'}],
  risks:[],deliverables:[{title:'结果',node_id:'summary',goal_ids:['goal'],acceptance:{kind:'artifact',file_name:'result.md',minimum_bytes:1}}]}),undefined,{empty:true})
 publish('child',reviewDoc)
 publish('parent',{name:'复核汇总',nodes:[
 {node_id:'t',type:'trigger',title:'触发',position:{x:0,y:0}},
 {node_id:'sub',type:'subworkflow',title:'资料核验',position:{x:10,y:0},config:{workflow_id:'child',pinned_version:1}},
 {node_id:'summary',type:'agent',title:'汇总',position:{x:20,y:0}}
 ],edges:[{from:'t',to:'sub'},{from:'sub',to:'summary'}]})
 for(const choice of [[],['ro.check']]){
  tools=choice
  const p=await planCommands.proposeTaskPlan('汇总核验',[],undefined,{workflow_id:'parent',workflow_version:'1'})
  const errors=p.quality.checks.flatMap(x=>x.issues)
  expect(p.quality.ready).toBe(choice.length === 0)
  if (choice.length) expect(errors.join(' ')).toContain('控制步骤')
 }
})


it('生成的合法工作步骤不会因展示标题含配置审批节点而丢失', async () => {
  let offered: string[] = []
  const generated = {
    name: '配置核对',
    nodes: [
      { node_id: 'start', type: 'trigger', title: '开始' },
      { node_id: 'configure', type: 'agent', title: '配置审批节点',
        config: { tools: { allow: ['ro.check'] } },
        contract: { description: '核对现有系统审批配置并交付核对报告' } },
      { node_id: 'approve', type: 'approval', title: '人工确认配置',
        config: { prompt: '请核对配置报告', on_timeout: 'fail' } },
      { node_id: 'finish', type: 'agent', title: '交付结论' },
    ],
    edges: [{ from: 'start', to: 'configure' }, { from: 'configure', to: 'approve' },
      { from: 'approve', to: 'finish' }],
  }
  const host = await boot(async (input) => {
    const workflow = input.workflows[0]!
    offered = workflow.nodes.map(node => node.id)
    return {
      title: '配置复核', workflow_id: workflow.workflowId, workflow_version: workflow.version,
      steps: workflow.nodes.map(node => ({ node_id: node.id, description: node.title ?? '检查配置',
        goal_ids: ['goal'], depends_on: node.dependsOn, tools: node.toolAllow,
        complexity: 'routine', model_reason: '核对已有配置' })),
      deliverables: [{ title: '核对结论', node_id: 'finish', goal_ids: ['goal'],
        acceptance: { kind: 'artifact', file_name: 'check.md', minimum_bytes: 1 } }],
      risks: [],
    }
  }, undefined, { empty: true, workflowGenerator: async () => generated })
  await host.planCommands.proposeTaskPlan('核对现有配置并交付结论', [])
  expect(offered).toEqual(['configure', 'approve', 'finish'])
  const doc = JSON.parse(String(host.db.raw.prepare('SELECT doc_json FROM workflow_versions').get()?.doc_json))
  expect(doc.nodes.find((node: { node_id: string }) => node.node_id === 'configure')).toMatchObject({ title: '配置审批节点' })
  expect(doc.edges).toContainEqual({ from: 'configure', to: 'approve' })
})


it('草稿按双键分页且操作者隔离，新草稿不会把旧草稿挤出后页', async () => {
  const host = await boot(async () => valid())
  const oldIds: string[] = []
  for (let i = 0; i < 23; i++) {
    const { view } = await host.planning!.propose({ goal: '核对-' + i, requirements: ['保留证据'] }, 'alice', now)
    oldIds.push(view.plan_id)
  }
  await host.planning!.propose({ goal: '其他人的草稿', requirements: ['保留证据'] }, 'bob', now)
  const first = host.planning!.listDrafts('alice')
  expect(first.items).toHaveLength(20)
  expect(first.next_cursor).toBeTruthy()
  await host.planning!.propose({ goal: '分页中新建', requirements: ['保留证据'] }, 'alice', now)
  const next = host.planning!.listDrafts('alice', undefined, { cursor: first.next_cursor! })
  expect(next.items).toHaveLength(3)
  expect([...first.items, ...next.items].map(p => p.plan_id).sort()).toEqual(oldIds.sort())
  expect(() => host.planning!.listDrafts('bob', undefined, { cursor: first.next_cursor! })).toThrow('过滤条件变了')
})

it('调整草稿原子替换、同请求重试取得后继，旧草稿不能启动或撤销', async () => {
  const planner = vi.fn(async () => valid())
  const host = await boot(planner)
  const first = await host.planCommands.proposeTaskPlan('核对项目', ['保留证据'])
  const reference = { plan_id: first.plan_id, content_hash: first.content_hash }
  const second = await host.planCommands.proposeTaskPlan('调整目标', ['保留证据'], undefined, undefined, reference)
  const replay = await host.planCommands.proposeTaskPlan('调整目标', ['保留证据'], undefined, undefined, reference)
  expect(replay.plan_id).toBe(second.plan_id)
  expect(planner).toHaveBeenCalledTimes(2)
  expect((await host.api.listPlanDrafts()).data.items.map(p => p.plan_id)).toEqual([second.plan_id])
  await expect(host.planCommands.confirmTaskPlan(first.plan_id, first.content_hash)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  await expect(host.planCommands.discardTaskPlan(first.plan_id, first.content_hash)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  await expect(host.planCommands.discardTaskPlan(second.plan_id, second.content_hash)).resolves.toMatchObject({ discarded: true, replayed: false })
  await expect(host.planCommands.discardTaskPlan(second.plan_id, second.content_hash)).resolves.toMatchObject({ discarded: true, replayed: true })
  expect((await host.api.listPlanDrafts()).data.items).toEqual([])
  await expect(host.planCommands.confirmTaskPlan(second.plan_id, second.content_hash)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
})

it('已启动计划不能放弃；失败的重新规划保留原草稿', async () => {
  let fail = false
  const host = await boot(async () => { if (fail) throw new Error('fixture unavailable'); return valid() })
  const original = await host.planCommands.proposeTaskPlan('核对项目', ['保留证据'])
  fail = true
  await expect(host.planCommands.proposeTaskPlan('调整目标', ['保留证据'], undefined, undefined,
    { plan_id: original.plan_id, content_hash: original.content_hash })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect((await host.api.listPlanDrafts()).data.items.map(p => p.plan_id)).toEqual([original.plan_id])
  await host.planCommands.confirmTaskPlan(original.plan_id, original.content_hash)
  await expect(host.planCommands.discardTaskPlan(original.plan_id, original.content_hash)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
})

it('面板调整原生会话草稿仍保留回报归属，放弃后规划状态不再显示待确认', async () => {
  const host = await boot(async () => valid())
  const origin = { messageKey: 'message', requestKey: 'request', inputHash: 'original-input',
    signal: new AbortController().signal, assertCurrent: () => {} }
  const original = (await host.planning!.proposeFromChat({ goal: '原会话任务', requirements: ['核验'] }, 'alice', now, origin)).view
  host.db.raw.prepare(`INSERT INTO chat_planning_progress(request_key,actor,scope,input_hash,stage,plan_id,updated_ms)
    VALUES ('request','alice','workspace-session','original-input','declined',?,?)`).run(original.plan_id, Date.parse(now))
  const next = (await host.planning!.propose({ goal: '补充目标', requirements: ['核验'],
    revises: { plan_id: original.plan_id, content_hash: original.content_hash } }, 'alice', now)).view
  expect(host.db.raw.prepare('SELECT plan_id FROM chat_task_receipts WHERE request_key=?').get('request')).toMatchObject({ plan_id: next.plan_id })
  expect(host.db.raw.prepare('SELECT plan_id,stage FROM chat_planning_progress WHERE request_key=?').get('request'))
    .toMatchObject({ plan_id: next.plan_id, stage: 'approval' })
  const started = host.planning!.confirm({ plan_id: next.plan_id, content_hash: next.content_hash, confirmed: true }, 'alice', now)
  expect(host.db.raw.prepare(`SELECT o.run_id FROM chat_task_receipts c JOIN task_plans p USING(plan_id)
    JOIN start_run_operations o ON o.operation_id=p.launch_operation_id WHERE c.request_key='request'`).get())
    .toMatchObject({ run_id: started.run_id })
  const another = (await host.planning!.propose({ goal: '另一个目标', requirements: ['核验'] }, 'alice', now)).view
  host.db.raw.prepare(`INSERT INTO chat_planning_progress(request_key,actor,scope,input_hash,stage,plan_id,updated_ms)
    VALUES ('another','alice','workspace-session','another-input','approval',?,?)`).run(another.plan_id, Date.parse(now))
  host.planning!.discard({ plan_id: another.plan_id, content_hash: another.content_hash }, 'alice', now)
  expect(host.db.raw.prepare("SELECT stage FROM chat_planning_progress WHERE request_key='another'").get()).toMatchObject({ stage: 'cancelled' })
})

it('material revision rebinds the native receipt, rejects stale starts and renews expired grants without orphan runs', async () => {
  const { planning, db } = await boot(async () => valid())
  const stamp = new Date().toISOString()
  const origin = { messageKey: 'material-native-message', requestKey: 'material-native-request', inputHash: 'a'.repeat(64),
    signal: new AbortController().signal, assertCurrent() {} }
  const original = (await planning.proposeFromChat({ goal: '核对交付', requirements: ['工具验证'] }, 'owner', stamp, origin)).view
  const input = { operation_id: uuidv7(), plan_id: original.plan_id, content_hash: original.content_hash,
    nodes: ['collect'], items: [{ name: '清单.csv', body: '文件,状态\n报告,已交付' }] }
  const revised = planning.grantMaterials(input, 'owner', stamp)
  expect(planning.grantMaterials(input, 'owner', stamp).plan_id).toBe(revised.plan_id)
  expect(() => planning.grantMaterials({ ...input, operation_id: uuidv7() }, 'owner', stamp))
    .toThrow(/计划已变化/u)
  const replay = (await planning.proposeFromChat({ goal: '核对交付', requirements: ['工具验证'] }, 'owner', stamp, origin)).view
  expect(replay.plan_id).toBe(revised.plan_id)
  expect(planning.listDrafts('owner').items[0]?.material_recipients).toEqual(['collect', 'verify'])
  expect(() => planning.launchFromChat(original.plan_id, original.content_hash, 'owner', stamp, origin, true)).toThrow()
  const expiredAt = Date.parse(stamp) + 30 * 60_000 + 1
  const later = new Date(expiredAt).toISOString()
  expect(() => planning.confirm({ plan_id: revised.plan_id, content_hash: revised.content_hash, confirmed: true }, 'owner', later))
    .toThrow(/材料或授权发生变化/u)
  expect(db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(0)
  expect(db.raw.prepare('SELECT count(*) n FROM start_run_operations').get()?.n).toBe(0)
  expect(withTx(db, tx => expireMaterials(tx, expiredAt))).toBe(1)
  const renewed = planning.grantMaterials({ ...input, operation_id: uuidv7(), plan_id: revised.plan_id,
    content_hash: revised.content_hash }, 'owner', later)
  expect(renewed.brief.materials).toHaveLength(1)
  expect(renewed.brief.materials![0]!.id).not.toBe(revised.brief.materials![0]!.id)
  const launched = planning.launchFromChat(renewed.plan_id, renewed.content_hash, 'owner', later, origin, true)
  expect(planning.launchFromChat(renewed.plan_id, renewed.content_hash, 'owner', later, origin, true).run_id).toBe(launched.run_id)
  expect(db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(1)
  expect(JSON.stringify(db.raw.prepare('SELECT receipt_json FROM inbox').all())).not.toContain('报告,已交付')
})


it('另一连接在确认读取后废弃草稿，启动写事务返回版本冲突且不留下运行', async () => {
  const host = await boot(async () => valid())
  const plan = (await host.planning!.propose({ goal: '并发核对', requirements: ['核验'] }, 'alice', now)).view
  const second = openDb(host.db.file)
  const execute = host.db.raw.exec.bind(host.db.raw)
  let beforeWrite = true
  const boundary = vi.spyOn(host.db.raw, 'exec').mockImplementation(sql => {
    if (beforeWrite && sql === 'BEGIN IMMEDIATE') {
      beforeWrite = false
      discardDraft(second, { plan_id: plan.plan_id, content_hash: plan.content_hash }, 'alice', now)
    }
    return execute(sql)
  })
  try {
    expect(() => host.planning!.confirm({ plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true }, 'alice', now))
      .toThrowError(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
    expect(beforeWrite).toBe(false)
    expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0)
    expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM start_run_operations').get()?.n).toBe(0)
  } finally { boundary.mockRestore(); second.raw.close() }
})


function requirementsContract(constraints: TaskRequirement[] = [], start_policy: RequirementsContract['start_policy'] = 'immediate'): RequirementsContract {
  const text = '只在聊天给我结论。不要新建文件。原表保留。只读处理。禁止外发。启动前等我点头。发布前经我审批。'
  return { version: 1, start_policy, sources: [{ message_id: 'human-message', text }], constraints }
}

function constraintBase(id: string, quote: string) {
  return { id, quote, source_message_id: 'human-message' }
}

it('结构化约束经真实规划入口持久化，生成器与规划器取得同一份原文来源', async () => {
  const contract = requirementsContract([{ ...constraintBase('chat', '只在聊天给我结论'), kind: 'chat_only' }])
  const generate = vi.fn<NonNullable<TaskPlanningOptions['workflowGenerator']>>(async () => reviewDoc)
  const planner = vi.fn(async (input: Parameters<TaskPlanningOptions['propose']>[0]) => {
    const result = proposalFor(input)
    result.deliverables = [{ title: '文字核对', node_id: 'verify', goal_ids: ['goal', 'R1'], acceptance: { kind: 'chat/text_result' } }]
    return result
  })
  const host = await boot(planner, undefined, { empty: true, workflowGenerator: generate })
  const { view } = await host.planning!.propose({ goal: '核对项目', requirements: ['保留证据'], requirements_contract: contract }, 'owner', now)
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ requirements_contract: contract })
  expect(planner.mock.calls[0]?.[0]).toMatchObject({ requirements_contract: contract })
  expect(view.contract_version).toBe(2)
  expect(host.db.raw.prepare('SELECT contract_version FROM task_plans WHERE plan_id=?').get(view.plan_id)).toEqual({ contract_version: 2 })
  expect(view.brief.requirements_contract).toEqual(contract)
  expect(view.quality.ready).toBe(true)
})

it.each([
  ['协作未回复', '如果协作请求未完成，请如实说明有没有收到回复'],
  ['审批状态', '如果审批未完成，请如实说明审批状态'],
] as const)('%s 不能作为数据缺口权限放行高风险部分结果', async (_kind, quote) => {
  const contract: RequirementsContract = { version: 1, start_policy: 'immediate',
    sources: [{ message_id: 'human-message', text: `核查库存。商品 B 单价缺失。${quote}。数量核算独立完成。` }],
    constraints: [{ ...constraintBase('gap', quote), kind: 'report_data_gap' }],
  }
  const planner = vi.fn(async () => ({ ...valid(), risks: [{ severity: 'high', description: '商品 B 单价缺失',
    mitigation: '报告金额缺口并先交付独立数量结果', node_id: 'verify',
    partial_result: { source_message_id: 'human-message', quote } }] }))
  const host = await boot(planner, undefined, { empty: true })
  expect(requirementsContractSchema.safeParse(contract).success).toBe(false)
  await expect(host.planning!.propose({ goal: contract.sources[0]!.text, requirements: [], requirements_contract: contract }, 'owner', now))
    .rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  expect(planner).not.toHaveBeenCalled()
  expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM task_plans').get()?.n).toBe(0)
  expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0)
})

it.each(['cited independent branch', 'ordinary high risk', 'forged source', 'unapproved quote', 'fabricated intent',
  'dependent branch', 'undeclared effect', 'uses external tool', 'violates chat restriction'] as const)(
  'only admits a verified partial outcome with an independently runnable text branch (%s)', async scenario => {
    const missingPrice = '商品 B 单价缺失'
    const reportGap = '金额核算发现必要数据缺失时，应如实报告未完成金额和下一步'
    const text = `核查库存。商品 A 数量 10，单价 20 元；商品 B 数量 5，${missingPrice}；商品 C 数量 3，单价 30 元。
${reportGap}。数量核算独立完成，不等待金额核算。
只在本会话交付，不联网，不读写工作区文件。`
    const contract: RequirementsContract = { version: 1, start_policy: 'immediate',
      sources: [{ message_id: 'human-message', text }], constraints: [
        { ...constraintBase('chat', '只在本会话交付'), kind: 'chat_only' },
        { ...constraintBase('network', '不联网'), kind: 'no_network' },
        { ...constraintBase('read', '不读写工作区文件'), kind: 'no_workspace_read' },
        { ...constraintBase('write', '不读写工作区文件'), kind: 'no_workspace_files' },
        { ...constraintBase('gap', scenario === 'fabricated intent' ? '不联网' : reportGap), kind: 'report_data_gap' },
      ],
    }
    const host = await boot(async ({ workflows }) => {
      const workflow = workflows[0]!
      const partial = { source_message_id: scenario === 'forged source' ? 'invented-source' : 'human-message',
        quote: scenario === 'unapproved quote' ? missingPrice : reportGap }
      const risk = { severity: 'high' as const, description: missingPrice, mitigation: '保留已知小计，报告缺价及补齐后复核的步骤',
        node_id: 'value', ...(scenario === 'ordinary high risk' ? {} : { partial_result: partial }) }
      return { title: '库存核查', workflow_id: workflow.workflowId, workflow_version: workflow.version,
        steps: workflow.nodes.map(node => ({ node_id: node.id, description: node.title ?? node.id, goal_ids: ['goal'],
          depends_on: node.dependsOn, tools: node.toolAllow, complexity: 'routine', model_reason: '只核对已提供的库存数据' })),
        deliverables: [
          { title: '库存金额', node_id: 'value', goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' } },
          { title: '库存数量', node_id: 'quantity', goal_ids: ['goal'], acceptance: scenario === 'violates chat restriction'
            ? { kind: 'artifact', file_name: 'quantity.md', minimum_bytes: 1 } : { kind: 'chat/text_result' } },
        ],
        risks: [risk],
      }
    }, undefined, { empty: true })
    const value = { node_id: 'value', type: 'agent' as const, title: '库存金额', position: { x: 100, y: 0 },
      config: { side_effect_policy: 'pure' } }
    const quantity = { node_id: 'quantity', type: 'agent' as const, title: '库存数量', position: { x: 100, y: 100 },
      config: { ...(scenario === 'undeclared effect' ? {} : { side_effect_policy: 'pure' }),
        ...(scenario === 'uses external tool' ? { tools: { allow: ['ro.check'] } } : {}) } }
    host.publish('inventory', { name: '库存核查',
      nodes: [{ node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 } }, value, quantity],
      edges: [{ from: 'start', to: 'value' }, { from: scenario === 'dependent branch' ? 'value' : 'start', to: 'quantity' }],
    })
    const plan = host.planning!.propose({
      goal: text, requirements: [], workflow_id: 'inventory', workflow_version: '1', requirements_contract: contract,
    }, 'owner', now)
    if (scenario === 'fabricated intent') {
      await expect(plan).rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
      expect(host.db.raw.prepare('SELECT count(*) n FROM task_plans').get()?.n).toBe(0)
      return
    }
    const { view } = await plan
    const confirm = () => host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now)
    if (scenario === 'cited independent branch') {
      expect(view.quality.ready).toBe(true)
      expect(view.proposal.risks).toMatchObject([{ severity: 'high', partial_result: { source_message_id: 'human-message', quote: reportGap } }])
      expect(confirm()).toMatchObject({ run_id: expect.any(String) })
    } else {
      expect(view.quality.ready).toBe(false)
      expect(() => confirm()).toThrow(expect.objectContaining({ code: 'VERDICT_POLICY_UNMET' }))
      expect(host.db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(0)
    }
  })

it.each(['revised', 'still complex', 'extra tool', 'extra node', 'omission', 'provider refused', 'cancelled', 'timed out',
  'no reporting requirement', 'configured complex'] as const)(
  'rechecks an unavailable planning tier once and reads the settings used for dispatch (%s)', async scenario => {
    const goal = scenario === 'no reporting requirement' ? '分别核对金额和库存数量。' :
      '商品 B 单价缺失。金额核算发现必要数据缺失时，应如实报告未完成金额和下一步。数量核算独立完成。'
    const gap = { ...constraintBase('gap', '金额核算发现必要数据缺失时，应如实报告未完成金额和下一步'), kind: 'report_data_gap' as const }
    const contract: RequirementsContract = { version: 1, start_policy: 'immediate', sources: [{ message_id: 'human-message', text: goal }],
      constraints: scenario === 'no reporting requirement' ? [] : [gap] }
    const originalReason = '涉及多处库存数据核验'
    const revisedReason = '金额分支只汇总已知金额并如实报告缺价'
    const proposal: TaskPlanProposal = { title: '库存核查', workflow_id: 'inventory', workflow_version: '1',
      steps: [{ node_id: 'value', description: '库存金额核算', goal_ids: ['goal'], depends_on: [], tools: [],
        complexity: 'complex', model_reason: originalReason },
      { node_id: 'quantity', description: '库存数量核算', goal_ids: ['goal'], depends_on: [], tools: [],
        complexity: 'advanced', model_reason: '独立核对库存数量' }],
      deliverables: ['value', 'quantity'].map(node_id => ({ node_id, title: node_id, goal_ids: ['goal'], acceptance: { kind: 'chat/text_result' } })),
      risks: [{ node_id: 'value', severity: 'medium', description: '商品 B 单价缺失', mitigation: '报告缺口及下一步' }],
    }
    const revise = { node_id: 'value', complexity: scenario === 'still complex' ? 'complex' : 'standard', model_reason: revisedReason }
    const startedReview = Promise.withResolvers<void>()
    const planner = vi.fn<TaskPlanningOptions['propose']>(async (input, signal) => {
      if (!input.model_calibration) return proposal
      startedReview.resolve()
      if (scenario === 'cancelled' || scenario === 'timed out') {
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      if (scenario === 'provider refused') throw new OrchError('SERVICE_UNAVAILABLE', '当前规划模型服务额度不足', { planning_issue: 'quota' })
      if (scenario === 'extra tool') return { steps: [{ ...revise, tools: ['ro.check'] }] }
      if (scenario === 'extra node') return { steps: [revise, { ...revise, node_id: 'quantity' }] }
      if (scenario === 'omission') return { steps: [] }
      return { steps: [revise] }
    })
    const spawned: SpawnParams[] = []
    const modelRef = 'fixture/gpt-6.2-sol'
    const host = await boot(planner, input => spawned.push(input), { empty: true,
      ...(scenario === 'timed out' && { timeoutMs: 1000 }), modelRouting: {
      profiles: [], catalog: () => ({ session_execution_model_ref: modelRef,
        profiles: [{ ref: modelRef, provider: 'fixture', model: 'gpt-6.2-sol', capacity: null }] }),
      recommend: () => { throw new Error('必须读取已经确认的计划') },
    } })
    host.publish('inventory', { name: '库存核查',
      nodes: [{ node_id: 'start', type: 'trigger', title: '触发', position: { x: 0, y: 0 } },
        { node_id: 'value', type: 'agent', title: '库存金额核算', position: { x: 100, y: 0 }, config: { side_effect_policy: 'pure' } },
        { node_id: 'quantity', type: 'agent', title: '库存数量核算', position: { x: 100, y: 100 }, config: { side_effect_policy: 'pure' } }],
      edges: [{ from: 'start', to: 'value' }, { from: 'start', to: 'quantity' }],
    })
    const configured = scenario === 'configured complex'
    if (configured) await host.client.post('/v1/settings/model-routing', { operation_id: uuidv7(), expected_revision: 0,
      mapping: { routine: null, standard: null, complex: modelRef }, model_capacities: [{ ref: modelRef, capacity: 'complex' }],
    })
    const controller = new AbortController()
    const pending = host.planning!.propose({ goal, requirements: [], workflow_id: 'inventory', workflow_version: '1',
      requirements_contract: contract }, 'owner', now, controller.signal)
    if (scenario === 'cancelled' || scenario === 'timed out') {
      const cancelled = new DOMException('取消复核', 'AbortError')
      const failure = expect(pending).rejects.toMatchObject(scenario === 'cancelled' ? { name: cancelled.name, message: cancelled.message }
        : { code: 'OPERATION_TIMEOUT', details: { boundary: 'maximum' } })
      if (scenario === 'cancelled') {
        await startedReview.promise
        controller.abort(cancelled)
      }
      await failure
      expect(planner).toHaveBeenCalledTimes(2)
      expect(planner.mock.calls[1]?.[1].aborted).toBe(true)
      expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toEqual({ n: 0 })
      expect(host.db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 })
      expect(spawned).toEqual([])
      return
    }
    const { view } = await pending
    const tiers = configured ? ['routine', 'standard', 'advanced', 'complex'] : ['routine', 'standard', 'advanced']
    expect(planner.mock.calls[0]?.[0].available_model_tiers).toEqual(tiers)
    const rechecked = !configured && scenario !== 'no reporting requirement'
    expect(planner).toHaveBeenCalledTimes(rechecked ? 2 : 1)
    if (rechecked) {
      expect(planner.mock.calls[1]?.[0]).toMatchObject({ available_model_tiers: tiers,
        model_calibration: [{ node_id: 'value', complexity: 'complex', model_reason: originalReason }] })
      expect(planner.mock.calls[1]?.[0].model_calibration).toHaveLength(1)
      expect(planner.mock.calls[1]?.[1]).toBe(planner.mock.calls[0]?.[1])
    }
    expect(view.quality.ready).toBe(true)
    const revised = scenario === 'revised' || scenario === 'still complex'
    expect(view.proposal).toEqual(revised ? { ...proposal, steps: [{ ...proposal.steps[0], ...revise }, proposal.steps[1]] } : proposal)
    const { run_id } = host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now)
    const spawnFor = (node: string) => spawned.find(({ nodeRunId }) => host.db.raw.prepare('SELECT node_id FROM node_runs WHERE node_run_id=?')
      .get(nodeRunId)?.node_id === node)
    await expect.poll(() => spawnFor('quantity'), { timeout: 5_000 }).toMatchObject({ modelRef, toolPolicy: { allow: [] },
      ...(!configured && { sessionModelFallback: true }) })
    if (configured || scenario === 'revised') {
      await expect.poll(() => spawnFor('value'), { timeout: 5_000 }).toMatchObject({ modelRef, toolPolicy: { allow: [] },
        ...(!configured && { sessionModelFallback: true }) })
      if (configured) expect(spawnFor('value')?.sessionModelFallback).toBeUndefined()
    } else {
      await expect.poll(() => host.db.raw.prepare('SELECT status FROM node_runs WHERE run_id=? AND node_id=?').get(run_id, 'value'),
        { timeout: 5_000 }).toEqual({ status: 'blocked_pre' })
      expect(spawnFor('value')).toBeUndefined()
    }
  }, 15_000)

it.each(['chat_only', 'no_workspace_files'] as const)('换一种说法仍由结构化 %s 限制文件交付', async (kind) => {
  const host = await boot(async () => valid())
  const contract = requirementsContract([{ ...constraintBase('c1', '不要新建文件'), kind }])
  const { view } = await host.planning!.propose({ goal: '这回只需要对话里的答案', requirements: ['保留证据'], requirements_contract: contract }, 'owner', now)
  expect(view.quality.ready).toBe(false)
  expect(() => host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now))
    .toThrow(expect.objectContaining({ code: 'VERDICT_POLICY_UNMET' }))
  expect(host.db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(0)
})

it('只给工具证据不能满足聊天正文交付，保护原件仍可新建报告', async () => {
  const host = await boot(async () => {
    const result = valid()
    result.deliverables = [{ ...result.deliverables[1]!, goal_ids: ['goal', 'R1'] }]
    return result
  })
  const contract = requirementsContract([{ ...constraintBase('chat', '只在聊天给我结论'), kind: 'chat_only' }])
  const view = (await host.planning!.propose({ goal: '核对', requirements: ['保留证据'], requirements_contract: contract }, 'owner', now)).view
  expect(view.quality.ready).toBe(false)
  expect(view.quality.checks.flatMap(check => check.issues).join(' ')).toContain('缺少可验收的会话文字')
  const other = await boot(async () => valid())
  const preservation = requirementsContract([{ ...constraintBase('original', '原表保留'), kind: 'preserve_input', target: '原表.csv' }])
  const preserved = (await other.planning!.propose({ goal: '核对并生成报告', requirements: ['核验'], requirements_contract: preservation }, 'owner', now)).view
  expect(preserved.quality.ready).toBe(true)
})

it('输入含伪造来源、未知约束或仅有版本号时，在解释与规划前拒绝', async () => {
  const planner = vi.fn(async () => valid())
  const interpret = vi.fn(async (input) => input)
  const host = await boot(planner, undefined, { interpret })
  const contract = requirementsContract([{ ...constraintBase('chat', '材料里并无这句话'), kind: 'chat_only' }])
  for (const input of [
    { goal: '核对', requirements: [], requirements_contract: contract },
    { goal: '核对', requirements: [], requirements_contract: { ...contract, constraints: [{ ...contract.constraints[0], kind: 'anything_goes' }] } },
    { goal: '核对', requirements: [], workflow_version: '2' },
  ]) await expect(host.client.post('/v1/task-plans', input)).rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  expect(planner).not.toHaveBeenCalled()
  expect(interpret).not.toHaveBeenCalled()
  expect(host.db.raw.prepare('SELECT count(*) n FROM task_plans').get()?.n).toBe(0)
})

it('面板解释只调用一次，已解释的聊天直达规划，解释失败和流程冲突均零建单', async () => {
  const contract = requirementsContract()
  const interpret = vi.fn(async (input) => ({ ...input, requirements_contract: contract }))
  const planner = vi.fn(async () => valid())
  const host = await boot(planner, undefined, { interpret })
  const input = { goal: '核对', requirements: ['核验'], workflow_id: 'review' }
  const first = await host.planning!.propose(input, 'owner', now)
  expect(first.view.contract_version).toBe(2)
  await host.planning!.propose({ ...input, requirements_contract: contract }, 'owner', now)
  expect(interpret).toHaveBeenCalledTimes(1)
  expect(planner).toHaveBeenCalledTimes(2)
  interpret.mockResolvedValueOnce({ ...input, workflow_id: 'other', requirements_contract: contract })
  await expect(host.planning!.propose(input, 'owner', now)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  interpret.mockRejectedValueOnce(new OrchError('OPERATION_TIMEOUT', '解释超时'))
  await expect(host.planning!.propose(input, 'owner', now)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
  expect(planner).toHaveBeenCalledTimes(2)
  expect(host.db.raw.prepare('SELECT count(*) n FROM task_plans').get()?.n).toBe(2)
  expect(host.db.raw.prepare('SELECT count(*) n FROM tasks').get()?.n).toBe(0)
})

it.each(['plan_only', 'approval'] as const)('会话 %s 的限制进入哈希并要求显式确认', async mode => {
  const host = await boot(async () => valid())
  const contract = mode === 'plan_only' ? requirementsContract([], 'plan_only')
    : requirementsContract([{ ...constraintBase('before', '启动前等我点头'), kind: 'approval_before', scope: 'task', reviewer: { kind: 'operator' } }])
  const origin = { messageKey: uuidv7(), requestKey: uuidv7(), inputHash: 'b'.repeat(64), signal: new AbortController().signal, assertCurrent() {} }
  const { view } = await host.planning!.proposeFromChat({ goal: '核对', requirements: ['核验'], requirements_contract: contract }, 'owner', now, origin)
  expect(() => host.planning!.launchFromChat(view.plan_id, view.content_hash, 'owner', now, origin, false))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }))
  expect(host.db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(0)
  if (mode === 'plan_only') expect(() => host.planning!.launchFromChat(view.plan_id, view.content_hash, 'owner', now, origin, true))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }))
  const launch = host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now)
  expect(host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now))
    .toMatchObject({ ...launch, replayed: true })
})

it('步骤审批绑定检查全部受控执行节点，AND 前置可通过，错绑和条件跳过受阻', () => {
  const contract = requirementsContract([{ ...constraintBase('gate', '发布前经我审批'), kind: 'approval_before', scope: 'steps', action: '发布', reviewer: { kind: 'operator' } }])
  const nodes: RequirementNode[] = [
    { id: 'approval', type: 'approval', dependsOn: [], declaredTools: [] },
    { id: 'data', type: 'policy', dependsOn: [], declaredTools: [] },
    { id: 'a', type: 'agent', dependsOn: ['approval'], declaredTools: [] },
    { id: 'b', type: 'agent', dependsOn: ['a', 'data'], declaredTools: [] },
  ]
  const proposal = { steps: [{ node_id: 'a', tools: [] }, { node_id: 'b', tools: [] }], deliverables: [],
    constraint_bindings: [{ constraint_id: 'gate', approval_node_id: 'approval', protected_node_ids: ['a', 'b'] }] }
  expect(requirementIssues(contract, proposal, nodes)).toEqual([])
  const wrong = { ...proposal, constraint_bindings: [{ ...proposal.constraint_bindings[0]!, protected_node_ids: ['a'] }] }
  expect(requirementIssues(contract, wrong, nodes).join(' ')).toContain('全部执行步骤')
  const bypass = nodes.map(node => node.id === 'b' ? { ...node, dependsOn: ['data'] } : node)
  expect(requirementIssues(contract, proposal, bypass).join(' ')).toContain('步骤 b')
  const conditional = nodes.map(node => node.id === 'data' ? { ...node, type: 'branch' } : node)
  expect(requirementIssues(contract, proposal, conditional).join(' ')).toContain('无法证明')
  const fake = nodes.map(node => node.id === 'approval' ? { ...node, type: 'wait' } : node)
  expect(requirementIssues(contract, proposal, fake).join(' ')).toContain('无法证明')
})

it('具名审批、外发能力缺口和副作用节点不被纯文本约束放行', () => {
  const proposal = { steps: [{ node_id: 'a', tools: ['ro.check'] }], deliverables: [] }
  const nodes: RequirementNode[] = [{ id: 'a', type: 'agent', dependsOn: [], declaredTools: ['ro.check'], sideEffectPolicy: 'irreversible' }]
  const constraints: TaskRequirement[] = [
    { ...constraintBase('reviewer', '发布前经我审批'), kind: 'approval_before', scope: 'task', reviewer: { kind: 'named', name: '财务' } },
    { ...constraintBase('send', '禁止外发'), kind: 'no_external_send' },
    { ...constraintBase('read', '只读处理'), kind: 'read_only' },
  ]
  const issues = requirementIssues(requirementsContract(constraints), proposal, nodes).join(' ')
  expect(issues).toContain('财务')
  expect(issues).toContain('外发范围')
  expect(issues).toContain('副作用步骤')
})

it('v2 计划的材料修订保留需求契约和版本，原哈希不能确认新约束', async () => {
  const host = await boot(async () => valid())
  const stamp = new Date().toISOString()
  const contract = requirementsContract([{ ...constraintBase('original', '原表保留'), kind: 'preserve_input', target: '原表.csv' }])
  const { view } = await host.planning!.propose({ goal: '核对', requirements: ['核验'], requirements_contract: contract }, 'owner', stamp)
  const updated = host.planning!.grantMaterials({ operation_id: uuidv7(), plan_id: view.plan_id, content_hash: view.content_hash,
    nodes: ['collect'], items: [{ name: '原表.csv', body: '数量,2' }] }, 'owner', stamp)
  expect(updated.contract_version).toBe(2)
  expect(updated.brief.requirements_contract).toEqual(contract)
  expect(updated.content_hash).not.toBe(view.content_hash)
  expect(() => host.planning!.confirm({ plan_id: updated.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', stamp))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
  const launch = host.planning!.confirm({ plan_id: updated.plan_id, content_hash: updated.content_hash, confirmed: true }, 'owner', stamp)
  const specs = resolveApprovedPlanNodeSpecs(host.db, host.catalog, host.registry, { ...launch, workflow_id: 'review', workflow_version: '1' })
  expect(specs?.collect?.input).toMatchObject({ requirements_contract: contract })
})

it('升级后的 v1 原哈希、回执重放和启动后固定版本仍有效，篡改 v2 约束不能确认', async () => {
  const host = await boot(async () => valid())
  const legacy = (await host.planning!.propose({ goal: '核对', requirements: ['核验'] }, 'owner', now)).view
  expect(legacy.content_hash).toBe(sha256Hex(canonicalJson({ schema: 1, brief: legacy.brief, proposal: legacy.proposal,
    quality: legacy.quality, workflow_hash: host.catalog.definitionHash('review', '1') })))
  const launch = host.planning!.confirm({ plan_id: legacy.plan_id, content_hash: legacy.content_hash, confirmed: true }, 'owner', now)
  const reopened = openDb(host.db.file)
  try {
    const planning = createTaskPlanningHost(reopened, host.catalog, host.registry, {
      propose: async () => valid(), interpret: async input => ({ ...input, requirements_contract: requirementsContract() }),
    })
    expect(planning.confirm({ plan_id: legacy.plan_id, content_hash: legacy.content_hash, confirmed: true }, 'owner', now))
      .toMatchObject({ ...launch, replayed: true })
    expect(withTx(reopened, tx => readApprovedTaskPlanForRun(tx, launch.run_id))?.brief).toEqual(legacy.brief)
  } finally { reopened.raw.close() }
  const pendingLegacy = (await host.planning!.propose({ goal: '旧草稿', requirements: ['核验'] }, 'owner', now)).view
  const upgraded = createTaskPlanningHost(host.db, host.catalog, host.registry, {
    propose: async () => valid(), interpret: async input => ({ ...input, requirements_contract: requirementsContract() }),
  })
  expect(() => upgraded.confirm({ plan_id: pendingLegacy.plan_id, content_hash: pendingLegacy.content_hash, confirmed: true }, 'owner', now))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }))
  const typed = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], requirements_contract: requirementsContract([], 'plan_only') }, 'owner', now)).view
  const tampered = { ...typed.brief, requirements_contract: { ...typed.brief.requirements_contract!, start_policy: 'immediate' } }
  const id = uuidv7()
  host.db.raw.prepare(`INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,
    content_hash,launch_operation_id,created_at,owner_task_id,auto_workflow_id,contract_version)
    SELECT ?,created_by,?,proposal_json,quality_json,workflow_hash,content_hash,?,created_at,owner_task_id,auto_workflow_id,contract_version
    FROM task_plans WHERE plan_id=?`).run(id, JSON.stringify(tampered), uuidv7(), typed.plan_id)
  expect(() => host.planning!.confirm({ plan_id: id, content_hash: typed.content_hash, confirmed: true }, 'owner', now))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
})

it('079 迁移只补版本列，不重写历史计划 JSON 和哈希', () => {
  const db = openDb(':memory:')
  try {
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps.filter(step => step.version <= 78))
    const id = uuidv7()
    db.raw.prepare(`INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,
      content_hash,launch_operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, 'owner', '{"goal":"old","requirements":[]}', '{}', '{}', 'a'.repeat(64), 'b'.repeat(64), uuidv7(), now)
    const before = db.raw.prepare('SELECT input_json,proposal_json,quality_json,content_hash FROM task_plans').get()
    expect(applySteps(db, steps.filter(step => step.version === 79))).toEqual([79])
    expect(db.raw.prepare('SELECT input_json,proposal_json,quality_json,content_hash FROM task_plans').get()).toEqual(before)
    expect(db.raw.prepare('SELECT contract_version FROM task_plans').get()).toEqual({ contract_version: 1 })
  } finally { db.raw.close() }
})


it('真实规划与确认按结构化审批绑定校验，错绑不创建运行', async () => {
  const doc = { ...reviewDoc, nodes: [reviewDoc.nodes[0]!,
    { node_id: 'gate', type: 'approval', title: '操作确认', position: { x: 50, y: 0 }, config: { prompt: '允许执行', on_timeout: 'fail' } },
    ...reviewDoc.nodes.slice(1)], edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'collect' }, { from: 'collect', to: 'verify' }] }
  let protectedNodes = ['verify']
  const host = await boot(async input => {
    const proposal = proposalFor(input)
    proposal.steps = input.workflows[0]!.nodes.map(node => ({ node_id: node.id, description: node.id,
      goal_ids: ['goal', 'R1'], depends_on: node.dependsOn, tools: node.toolAllow, complexity: 'routine', model_reason: '核验' }))
    proposal.constraint_bindings = [{ constraint_id: 'gate-before', approval_node_id: 'gate', protected_node_ids: protectedNodes }]
    return proposal
  }, undefined, { empty: true })
  host.publish('review', doc)
  const requirements_contract = requirementsContract([{ ...constraintBase('gate-before', '发布前经我审批'),
    kind: 'approval_before', scope: 'steps', action: '核对并发布', reviewer: { kind: 'operator' } }])
  const first = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], requirements_contract }, 'owner', now)).view
  expect(first.quality.ready).toBe(false)
  expect(() => host.planning!.confirm({ plan_id: first.plan_id, content_hash: first.content_hash, confirmed: true }, 'owner', now))
    .toThrow(expect.objectContaining({ code: 'VERDICT_POLICY_UNMET' }))
  protectedNodes = ['collect', 'verify']
  const second = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], requirements_contract }, 'owner', now)).view
  expect(second.quality.ready).toBe(true)
  expect(host.planning!.confirm({ plan_id: second.plan_id, content_hash: second.content_hash, confirmed: true }, 'owner', now))
    .toMatchObject({ run_id: expect.any(String) })
  expect(host.db.raw.prepare('SELECT count(*) n FROM runs').get()?.n).toBe(1)
})

it('固定历史版本能够确认，新版本与错误提案不会改变绑定或生成专属流程', async () => {
  const generator = vi.fn(async () => reviewDoc)
  const planner = vi.fn<TaskPlanningOptions['propose']>(async input => proposalFor(input))
  const host = await boot(planner, undefined, { workflowGenerator: generator })
  const draft = host.commands.openWorkflowDraft({ workflowId: 'review', baseVersion: 1, actor: 'host', now, operationId: uuidv7() }) as { revision: number }
  const update = host.commands.updateWorkflowDraft({ workflowId: 'review', revision: draft.revision,
    definition: { ...reviewDoc, nodes: reviewDoc.nodes.map(node => node.node_id === 'verify'
      ? { ...node, config: { tools: { allow: [] } } } : node) }, actor: 'host', now, operationId: uuidv7() }) as { revision: number }
  expect(host.commands.testWorkflowDraft({ workflowId: 'review', revision: update.revision, now }).passed).toBe(true)
  host.commands.publishWorkflow({ workflowId: 'review', revision: update.revision, baseVersion: 1, note: '新版', actor: 'host', now, operationId: uuidv7() })
  const input = { goal: '核对', requirements: ['核验'], workflow_id: 'review', workflow_version: '1', requirements_contract: requirementsContract() }
  const { view } = await host.planning!.propose(input, 'owner', now)
  const launch = host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now)
  expect(host.db.raw.prepare('SELECT CAST(workflow_version AS TEXT) version,workflow_definition_hash hash FROM runs WHERE run_id=?').get(launch.run_id))
    .toEqual({ version: '1', hash: host.catalog.definitionHash('review', '1') })
  planner.mockResolvedValueOnce({ kind: 'no_candidate', reason: '不适用' })
  await expect(host.planning!.propose(input, 'owner', now)).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
  planner.mockResolvedValueOnce({ ...valid(), workflow_version: '2' })
  await expect(host.planning!.propose(input, 'owner', now)).rejects.toMatchObject({ code: 'WORKFLOW_DEFINITION_INVALID' })
  expect(generator).not.toHaveBeenCalled()
  expect(host.db.raw.prepare("SELECT count(*) n FROM workflows WHERE scope='task_local'").get()?.n).toBe(0)
  expect(host.db.raw.prepare('SELECT count(*) n FROM task_plans').get()?.n).toBe(1)
})


it('调整 v2 草稿把旧约束交给解释器，重试回原后继且自定义宿主无法静默降级', async () => {
  const contract = requirementsContract([{ ...constraintBase('original', '原表保留'), kind: 'preserve_input', target: '原表.csv' }])
  const interpret = vi.fn<NonNullable<TaskPlanningOptions['interpret']>>(async (input, _signal, previous) =>
    ({ ...input, requirements_contract: previous?.requirements_contract ?? contract }))
  const host = await boot(async () => valid(), undefined, { interpret })
  const original = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], workflow_id: 'review', workflow_version: '1', requirements_contract: contract }, 'owner', now)).view
  const input = { goal: '核对下周项目', requirements: ['核验'], revises: { plan_id: original.plan_id, content_hash: original.content_hash } }
  const changed = (await host.planning!.propose(input, 'owner', now)).view
  expect(interpret.mock.calls[0]?.[2]).toMatchObject({ goal: original.brief.goal, requirements_contract: contract, workflow_id: 'review', workflow_version: '1' })
  expect(changed.brief).toMatchObject({ workflow_id: 'review', workflow_version: '1' })
  expect(changed.brief.requirements_contract?.constraints).toEqual([{ ...contract.constraints[0], id: 'c1' }])
  expect((await host.planning!.propose(input, 'owner', now)).view.plan_id).toBe(changed.plan_id)
  expect(interpret).toHaveBeenCalledTimes(1)
  const custom = createTaskPlanningHost(host.db, host.catalog, host.registry, { propose: async () => valid() })
  await expect(custom.propose({ ...input, revises: { plan_id: changed.plan_id, content_hash: changed.content_hash } }, 'owner', now))
    .rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
})


it('调用方直接提交新契约也不能在修订中移除旧约束、立即启动或替换固定版本', async () => {
  const host = await boot(async () => valid())
  const contract = requirementsContract([{ ...constraintBase('original', '原表保留'), kind: 'preserve_input', target: '原表.csv' }], 'plan_only')
  const first = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], workflow_id: 'review', workflow_version: '1', requirements_contract: contract }, 'owner', now)).view
  const next = { goal: '继续核对', requirements: ['核验'], revises: { plan_id: first.plan_id, content_hash: first.content_hash },
    requirements_contract: requirementsContract() }
  await expect(host.planning!.propose({ ...next, workflow_id: 'another', workflow_version: '2' }, 'owner', now))
    .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  const result = (await host.planning!.propose(next, 'owner', now)).view
  expect(result.brief).toMatchObject({ workflow_id: 'review', workflow_version: '1', requirements_contract: {
    start_policy: 'plan_only', constraints: [{ ...contract.constraints[0], id: 'c1' }],
  } })
  expect(result.content_hash).not.toBe(first.content_hash)
  expect(() => host.planning!.confirm({ plan_id: first.plan_id, content_hash: first.content_hash, confirmed: true }, 'owner', now))
    .toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
})


it('修订合并对同义结构约束去重并稳定编号，不接受同一来源号对应不同正文', () => {
  const prior = requirementsContract([{ ...constraintBase('old-name', '原表保留'), kind: 'preserve_input', target: '原表.csv' }], 'plan_only')
  const next: RequirementsContract = { version: 1, start_policy: 'immediate',
    sources: [{ message_id: 'next', text: '原表保留，禁止外发。' }], constraints: [
      { id: 'c1', kind: 'preserve_input', target: '原表.csv', source_message_id: 'next', quote: '原表保留' },
      { id: 'c2', kind: 'no_external_send', source_message_id: 'next', quote: '禁止外发' },
    ] }
  const merged = mergeRequirementsContracts(prior, next)
  expect(merged.constraints.map(item => [item.id, item.kind, item.source_message_id])).toEqual([
    ['c1', 'preserve_input', 'human-message'], ['c2', 'no_external_send', 'next'],
  ])
  expect(merged.start_policy).toBe('plan_only')
  expect(mergeRequirementsContracts(merged, next)).toEqual(merged)
  expect(() => mergeRequirementsContracts(prior, { ...next, sources: [{ message_id: 'human-message', text: '不同正文' }] })).toThrow()
})

it('执行权限从已启动计划读取，子流程继承原限制，绑定被改或跨任务父链均拒绝', async () => {
  const host = await boot(async () => valid())
  const contract = requirementsContract([{ ...constraintBase('readonly', '只读处理'), kind: 'read_only' }])
  const view = (await host.planning!.propose({ goal: '核对', requirements: ['核验'], requirements_contract: contract }, 'owner', now)).view
  const launch = host.planning!.confirm({ plan_id: view.plan_id, content_hash: view.content_hash, confirmed: true }, 'owner', now)
  const node = host.db.raw.prepare("SELECT node_run_id,side_effect_policy FROM node_runs WHERE run_id=? AND node_id='collect'")
    .get(launch.run_id) as { node_run_id: string; side_effect_policy: string }
  expect(readNativeExecutionPolicy(host.db, node.node_run_id)).toEqual({
    sideEffectPolicy: node.side_effect_policy, requirementsContract: contract,
  })
  expect(() => readNativeExecutionPolicy(host.db, 'model-invented-node')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  withTx(host.db, tx => {
    tx.run(`INSERT INTO runs (run_id,task_id,workflow_id,workflow_version,workflow_definition_hash,status,revision,
      parent_run_id,root_run_id,subworkflow_depth,created_at,updated_at)
      SELECT 'permission-child',task_id,workflow_id,workflow_version,workflow_definition_hash,'running',0,
        run_id,run_id,1,created_at,updated_at FROM runs WHERE run_id=?`, [launch.run_id])
    tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,attempt,status,revision,side_effect_policy,created_at,updated_at)
      VALUES ('permission-child-node','permission-child','collect',0,'agent',1,'queued',0,'pure',?,?)`, [now, now])
  })
  expect(readNativeExecutionPolicy(host.db, 'permission-child-node')).toEqual({ sideEffectPolicy: 'pure', requirementsContract: contract })
  const original = host.db.raw.prepare('SELECT workflow_definition_hash FROM runs WHERE run_id=?')
    .get(launch.run_id)!.workflow_definition_hash as string
  withTx(host.db, tx => tx.run('UPDATE runs SET workflow_definition_hash=? WHERE run_id=?', ['0'.repeat(64), launch.run_id]))
  expect(() => readNativeExecutionPolicy(host.db, 'permission-child-node')).toThrow(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
  withTx(host.db, tx => {
    tx.run('UPDATE runs SET workflow_definition_hash=? WHERE run_id=?', [original, launch.run_id])
    tx.run(`INSERT INTO tasks (task_id,title,status,revision,created_at,updated_at) VALUES ('different-task','另一个任务','queued',0,?,?)`, [now, now])
    tx.run("UPDATE runs SET task_id='different-task' WHERE run_id='permission-child'")
  })
  expect(() => readNativeExecutionPolicy(host.db, 'permission-child-node')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})
