import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TaskTriggerView } from '../../src/core/task-trigger.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { serveOrchestra } from '../../src/index.ts'
import {
  createTriggerDispatchPump,
  type ResolveTriggerNodeSpecs,
} from '../../src/service/task-trigger-dispatch.ts'
import { listTriggerExecutionStates } from '../../src/service/task-triggers.ts'

const SECRET = 'trigger-readiness-secret'
const NOW = '2026-11-18T00:59:00.000Z'
const HEADERS = { 'x-orchestra-secret': SECRET, 'content-type': 'application/json' }
const workflowId = 'readiness_flow'
const node = (node_id: string, type: string) => ({ node_id, type, title: node_id, position: { x: 0, y: 0 }, config: {} })
const definition = {
  name: '就绪流程',
  nodes: [
    node('trigger', 'trigger'),
    { ...node('read', 'wait'), config: { wait_kind: 'event', match: { type: 'project.ready' }, max_wait_ms: 60_000 } },
  ],
  edges: [{ from: 'trigger', to: 'read' }],
}

type RuleView = TaskTriggerView & { readiness: { state: string; reason: string | null; run_id: string | null } }

async function boot(dir: string, resolveTriggerNodeSpecs?: ResolveTriggerNodeSpecs) {
  return serveOrchestra({
    dbFile: join(dir, 'orchestra.sqlite'), secret: SECRET, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveTriggerNodeSpecs,
  })
}

function publish(service: Awaited<ReturnType<typeof boot>>) {
  service.orchestra.commands.createWorkflow({
    workflowId, name: definition.name, scope: 'reusable', definition, actor: 'tester', now: NOW, operationId: uuidv7(),
  })
  expect(service.orchestra.commands.testWorkflowDraft({ workflowId, revision: 1, now: NOW }).passed).toBe(true)
  service.orchestra.commands.publishWorkflow({
    workflowId, revision: 1, baseVersion: 0, note: 'fixture', actor: 'tester', now: NOW, operationId: uuidv7(),
  })
}

function request(service: Awaited<ReturnType<typeof boot>>, suffix = '', body?: unknown) {
  return fetch(service.endpoint + '/v1/task-triggers' + suffix, {
    headers: HEADERS, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createRule(service: Awaited<ReturnType<typeof boot>>, eventType: string) {
  const response = await request(service, '', {
    operation_id: uuidv7(), title: '项目就绪触发 ' + eventType, kind: 'event',
    workflow_id: workflowId, workflow_version: '1', event_type: eventType,
  })
  expect(response.status).toBe(200)
  const { data } = await response.json() as { data: RuleView }
  return data
}

it('宿主没装配解析器时，规则能建能启用，触发只记成"还没派发"，重放不重复建运行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-readiness-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    publish(service)
    const rule = await createRule(service, 'project.ready')
    // 规则已登记，但宿主没装配可信解析器：就绪态必须说清楚"执行器没就绪"
    expect(rule.readiness.state).toBe('executor_not_ready')
    expect(rule.readiness.reason).toBe('executor_not_ready')

    const enabled = await request(service, '/enabled', {
      operation_id: uuidv7(), trigger_id: rule.trigger_id, expected_revision: rule.revision, enabled: true,
    })
    expect(enabled.status).toBe(200)

    const fired = await request(service, '/event', { event_id: 'project-ready-1', event_type: 'project.ready' })
    expect(await fired.json()).toMatchObject({
      data: { replayed: false, items: [{ task_id: rule.task_id, status: 'started', reason: null }] },
    })

    const db = service.orchestra.db
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 1 })
    const nodes = db.raw.prepare('SELECT status FROM node_runs').all() as { status: string }[]
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((item) => item.status === 'queued')).toBe(true)

    // 就绪态：规则级说"执行器没就绪"，触发级说"触发已发生"
    const states = listTriggerExecutionStates(db, { trigger_id: rule.trigger_id })
    expect(states).toHaveLength(2)
    const ruleState = states.find((item) => item.occurrence_key === '')
    const occurrenceState = states.find((item) => item.occurrence_key === 'project-ready-1')
    expect(ruleState).toMatchObject({ state: 'executor_not_ready', reason: 'executor_not_ready' })
    expect(occurrenceState).toMatchObject({ state: 'fired', reason: null })
    expect(ruleState?.run_id).toBeTruthy()

    // HTTP 列表就是就绪态的读取入口
    const listed = await (await request(service, '?task_id=' + rule.task_id)).json() as { data: { items: RuleView[] } }
    expect(listed.data.items[0]?.readiness.state).toBe('executor_not_ready')

    // 重放同一个事件：不重复建运行，也不重复写就绪态
    const replay = await request(service, '/event', { event_id: 'project-ready-1', event_type: 'project.ready' })
    expect(await replay.json()).toMatchObject({ data: { replayed: true } })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 1 })
    expect(listTriggerExecutionStates(db, { trigger_id: rule.trigger_id })).toHaveLength(2)
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('宿主装配解析器后，触发从"已发生"推进到"已派发"，运行真的往前走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-dispatch-ready-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    publish(service)
    const rule = await createRule(service, 'project.ready')
    await request(service, '/event', { event_id: 'project-ready-1', event_type: 'project.ready' })
    expect(listTriggerExecutionStates(service.orchestra.db, { trigger_id: rule.trigger_id }))
      .toContainEqual(expect.objectContaining({ occurrence_key: '', state: 'executor_not_ready' }))
    await service.close()
    service = undefined

    const resolve = vi.fn<ResolveTriggerNodeSpecs>(() => ({ read: { tools: [] } }))
    service = await boot(dir, resolve)
    const db = service.orchestra.db
    await vi.waitFor(
      () => expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_id = 'read'").get()).toMatchObject({ status: 'waiting' }),
      { timeout: 10_000, interval: 100 },
    )
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ task_id: rule.task_id, workflow_id: workflowId }), expect.any(AbortSignal))
    const states = listTriggerExecutionStates(db, { trigger_id: rule.trigger_id })
    expect(states.find((item) => item.occurrence_key === '')).toMatchObject({ state: 'dispatched', reason: null })
    expect(states.find((item) => item.occurrence_key === 'project-ready-1')).toMatchObject({ state: 'dispatched', reason: null })
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('解析器解析不出规格时，原因落在就绪态里，不被静默吞掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-no-specs-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    publish(service)
    const rule = await createRule(service, 'project.blocked')
    await request(service, '/event', { event_id: 'project-blocked-1', event_type: 'project.blocked' })

    const db = service.orchestra.db
    const errors: unknown[] = []
    const pump = createTriggerDispatchPump(
      db,
      vi.fn<ResolveTriggerNodeSpecs>(() => undefined),
      async () => { throw new Error('没有规格时不该派发') },
      (error) => { errors.push(error) },
    )
    pump.tick()
    await expect.poll(
      () => listTriggerExecutionStates(db, { trigger_id: rule.trigger_id }).find((item) => item.occurrence_key === '')?.reason,
      { timeout: 5000, interval: 50 },
    ).toBe('resolver_returned_no_specs')
    await pump.close()

    const ruleState = listTriggerExecutionStates(db, { trigger_id: rule.trigger_id }).find((item) => item.occurrence_key === '')
    expect(ruleState?.state).not.toBe('dispatched')
    expect(errors).toEqual([])
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('解析器超时时，原因落在就绪态里，不被静默吞掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-timeout-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    publish(service)
    const rule = await createRule(service, 'project.paused')
    await request(service, '/event', { event_id: 'project-paused-1', event_type: 'project.paused' })

    const db = service.orchestra.db
    const errors: unknown[] = []
    const pump = createTriggerDispatchPump(
      db,
      vi.fn<ResolveTriggerNodeSpecs>(() => new Promise<Record<string, never>>(() => {})),
      async () => { throw new Error('超时时不该派发') },
      (error) => { errors.push(error) },
      undefined,
      { resolveTimeoutMs: 50 },
    )
    pump.tick()
    await expect.poll(
      () => listTriggerExecutionStates(db, { trigger_id: rule.trigger_id }).find((item) => item.occurrence_key === '')?.reason,
      { timeout: 5000, interval: 50 },
    ).toBe('resolver_timeout')
    await pump.close()

    const ruleState = listTriggerExecutionStates(db, { trigger_id: rule.trigger_id }).find((item) => item.occurrence_key === '')
    expect(ruleState?.state).not.toBe('dispatched')
    expect(errors).toHaveLength(1)
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
