import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadUpgradeBuild, head, previousCompatibility, readPreviousModelCatalog, request } from '../../scripts/upgrade-host.ts'
import { sha256File } from '../../src/infra/backup.ts'
import { BridgeClient, type SpawnParams } from '../../src/executor/bridge.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import type { ModelProfile } from '../../src/executor/model-routing.ts'
import type { TaskPlanView } from '../../src/service/task-planning.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'

const previousArchive = process.env.ORCHESTRA_PREVIOUS_PACKAGE_TEST_ARCHIVE
const candidateArchive = process.env.ORCHESTRA_PACKAGE_TEST_ARCHIVE
const profiles = [
  { ref: 'fast', capacity: 'routine' }, { ref: 'middle', capacity: 'standard' },
  { ref: 'analyst', capacity: 'advanced' }, { ref: 'expert', capacity: 'expert' },
] satisfies ModelProfile[]

it.runIf(Boolean(previousArchive && candidateArchive))('双包设置可往返，旧引擎执行兼容计划，新语义计划保留并阻止旧引擎接手', async () => {
  mkdirSync(resolve('tmp'), { recursive: true })
  const root = mkdtempSync(resolve('tmp', 'model-upgrade-'))
  const secret = 'model-upgrade-fixture'
  const packs = await Promise.all([
    loadUpgradeBuild({ archive: previousArchive!, sha256: sha256File(previousArchive!) }, join(root, 'previous'), true),
    loadUpgradeBuild({ archive: candidateArchive!, sha256: sha256File(candidateArchive!) }, join(root, 'candidate'), false),
  ])
  type Module = typeof packs[0]['module']
  const spawned: string[] = []
  async function boot(module: Module, phase: 'S5' | 'S6', choice: 'ordinary' | 'advanced' | 'preferred-only' = 'ordinary') {
    const registry = new module.ToolRegistry()
    registry.register({ name: 'ro.verify', capability: 'read_only', command: { bin: 'fixture', args: [] } })
    const transport = fakeAgentBridge({ agentId: 'fixture-' + phase, steps: [{ tool: 'ro.verify', cwd: root }], at: new Date().toISOString() })
    const bridge = new BridgeClient({
      async request<T>(method: string, input: unknown) {
        if (method === 'executor.spawn') {
          const model = (input as SpawnParams).modelRef
          spawned.push(model ?? 'missing')
          return { ...(await transport.request<object>(method, input)), effectiveModelRef: model } as T
        }
        return transport.request<T>(method, input)
      },
      listen: transport.listen,
    })
    const service = await module.serveOrchestra({
      dbFile: join(root, 'live.db'), secret, phase, asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
      appendLedgerEvent: () => { throw new Error('Unexpected raw ledger write') },
      planning: { async propose(input) {
        if (choice === 'advanced') expect(input.model_profiles).toContainEqual({ ref: 'expert', capacity: 'expert', user_note: '复杂证据' })
        return {
          title: 'Compat fixture', workflow_id: 'model-compat', workflow_version: '1',
          steps: [{ node_id: 'check', description: '核验', goal_ids: ['goal'], depends_on: [], tools: ['ro.verify'],
            complexity: choice === 'advanced' ? 'expert' : 'routine', model_reason: '核验依据',
            ...(choice === 'advanced' ? { preferred_model_ref: 'expert' } : choice === 'preferred-only' ? { preferred_model_ref: 'fast' } : {}),
          }],
          deliverables: [{ title: '核验证据', node_id: 'check', goal_ids: ['goal'],
            acceptance: { kind: 'tool_evidence', tool: 'ro.verify', exit_code: 0 } }],
          risks: [],
        }
      } },
      executor: { bridge, registry, runner: new module.ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
        run: async () => ({ exitCode: 0, stdout: 'verified', stderr: '' }) }, root),
      modelRouting: { profiles: phase === 'S5' ? profiles.slice(0, 2) : profiles, recommend: () => { throw new Error('Missing approved plan') } } },
    })
    return { service, call: <T>(route: string, data?: unknown) => request<T>(service, secret, route, data) }
  }
  let session: Awaited<ReturnType<typeof boot>> | undefined
  const map = { routine: 'fast', standard: null, advanced: 'analyst', complex: null, expert: null }
  const mappingPath = '/v1/settings/model-routing'
  const propose = { goal: 'Verify model compatibility', requirements: [] }
  const waitDone = async (runId: string, client: Awaited<ReturnType<typeof boot>>) => {
    await vi.waitFor(async () => {
      const page = await client.call<{ items: unknown[] }>('/v1/node-runs?run_id=' + runId)
      expect(page.items[0]).toMatchObject({ status: 'done', execution_count: 1 })
    }, { timeout: 8_000 })
  }
  try {
    session = await boot(packs[0].module, 'S5')
    const previousCatalog = await readPreviousModelCatalog(session.service, secret)
    expect(previousCatalog).toEqual(profiles.slice(0, 2))
    await session.service.close()
    session = await boot(packs[1].module, 'S6')
    const save = { operation_id: uuidv7(), expected_revision: 0, mapping: { ...map, routine: 'expert', advanced: null } }
    await session.call(mappingPath, save)
    expect(() => previousCompatibility(session!.service.orchestra.db, previousCatalog))
      .toThrow(/"candidate_model_bindings":1.*previous_catalog_missing_or_insufficient/)
    expect(() => previousCompatibility(session!.service.orchestra.db))
      .toThrow(/"candidate_model_bindings":1.*previous_catalog_unverified/)
    const fullSave = { operation_id: uuidv7(), expected_revision: 1, mapping: map,
      model_notes: [{ ref: 'expert', note: '复杂证据' }, { ref: 'fast', note: '低延迟' }] }
    await session.call(mappingPath, fullSave)
    const definition = { name: 'Model upgrade fixture',
      nodes: [{ node_id: 'start', title: '开始', type: 'trigger', position: { x: 0, y: 0 } },
        { node_id: 'check', title: '核验', type: 'agent', position: { x: 80, y: 0 },
          config: { tools: { allow: ['ro.verify'] }, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] } }],
      edges: [{ from: 'start', to: 'check' }],
    }
    const draft = await session.call<{ revision: number }>('/v1/workflows', { workflow_id: 'model-compat', name: definition.name,
      definition, operation_id: uuidv7() })
    expect(await session.call('/v1/workflows/test', { workflow_id: 'model-compat', revision: draft.revision })).toMatchObject({ passed: true })
    await session.call('/v1/workflows/publish', { workflow_id: 'model-compat', revision: draft.revision,
      base_version: 0, publish_note: 'fixture', operation_id: uuidv7() })
    const ordinary = await session.call<TaskPlanView>('/v1/task-plans', propose)
    expect(ordinary.proposal.steps[0]).not.toHaveProperty('preferred_model_ref')
    expect(previousCompatibility(session.service.orchestra.db, previousCatalog))
      .toMatchObject({ candidate_plans: 0, candidate_routing: 0, candidate_model_bindings: 0 })
    expect(() => previousCompatibility(session!.service.orchestra.db, [{ ref: 'fast', capacity: 'expert' }]))
      .toThrow(/previous_catalog_missing_or_insufficient/)
    await session.service.close()
    session = await boot(packs[0].module, 'S5')
    expect(await session.call(mappingPath)).toMatchObject({ revision: 2, mapping: { routine: 'fast', standard: null, complex: null } })
    await session.call(mappingPath, { expected_revision: 2, operation_id: uuidv7(), mapping: { routine: 'middle', standard: null, complex: null } })
    expect(await session.call('/v1/task-plans/get?plan_id=' + ordinary.plan_id)).toMatchObject({
      content_hash: ordinary.content_hash, proposal: ordinary.proposal,
    })
    const approved = await session.call<{ run_id: string }>('/v1/task-plans/confirm', {
      plan_id: ordinary.plan_id, content_hash: ordinary.content_hash, confirmed: true,
    })
    await waitDone(approved.run_id, session)
    expect(spawned).toEqual(['middle'])
    await session.service.close()
    session = await boot(packs[1].module, 'S6', 'advanced')
    expect(await session.call(mappingPath)).toMatchObject({ revision: 3, mapping: { ...map, routine: 'middle' }, model_notes: fullSave.model_notes })
    expect(await session.call(mappingPath, fullSave)).toEqual({ revision: 2 })
    const newer = await session.call<TaskPlanView>('/v1/task-plans', propose)
    const inFlight = await session.call<{ run_id: string; task_id: string }>('/v1/task-plans/confirm', {
      plan_id: newer.plan_id, content_hash: newer.content_hash, confirmed: true,
    })
    const db = session.service.orchestra.db
    const before = { seq: head(db), epoch: db.epoch }
    expect(() => previousCompatibility(db, previousCatalog)).toThrow(/"candidate_plans":1,"in_flight_model_plans":1/)
    const context = { taskId: inFlight.task_id, runId: inFlight.run_id, workflowId: 'model-compat', workflowVersion: '1',
      nodeRunId: 'fixture', nodeId: 'check', attempt: 1, actionGeneration: 1 }
    expect(() => packs[0].module.getTaskPlanRecommendation(db, context)).toThrow()
    expect(packs[1].module.getTaskPlanRecommendation(db, context)).toEqual({ complexity: 'expert', preferredModel: 'expert', reason: '核验依据' })
    expect({ seq: head(db), epoch: db.epoch }).toEqual(before)
    await waitDone(inFlight.run_id, session)
    expect(spawned).toEqual(['middle', 'expert'])
    await session.service.close()
    session = await boot(packs[1].module, 'S6', 'preferred-only')
    const preferred = await session.call<TaskPlanView>('/v1/task-plans', propose)
    expect(preferred.proposal.steps[0]).toMatchObject({ complexity: 'routine', preferred_model_ref: 'fast' })
    expect(() => previousCompatibility(session!.service.orchestra.db, previousCatalog)).toThrow(/"candidate_plans":2,"in_flight_model_plans":0/)
  } finally {
    await session?.service.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
