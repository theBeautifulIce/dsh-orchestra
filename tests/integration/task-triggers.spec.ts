import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TaskTriggerCreate, TaskTriggerView } from '../../src/core/task-trigger.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { serveOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { createTaskTriggerHost, nextDailyFire } from '../../src/service/task-triggers.ts'
import type { ResolveTriggerNodeSpecs } from '../../src/service/task-trigger-dispatch.ts'
import { getTaskSummarySnapshot } from '../../src/service/queries/tasks.ts'

const SECRET = 'task-triggers-integration-secret'
const NOW = '2026-11-18T00:59:00.000Z'
const DUE = '2026-11-18T01:00:00.000Z'
const TOMORROW = '2026-11-19T01:00:00.000Z'
const HEADERS = { 'x-orchestra-secret': SECRET, 'content-type': 'application/json' }
const workflowId = 'trigger_test_flow'
const node = (node_id: string, type: string) => ({ node_id, type, title: node_id, position: { x: 0, y: 0 }, config: {} })
const definition = { name: '发布流程', nodes: [node('trigger', 'trigger'), node('read', 'agent')], edges: [{ from: 'trigger', to: 'read' }] }

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

const scheduled = (): TaskTriggerCreate => ({
  operation_id: uuidv7(), title: '每日 09:00 项目记忆巡检', kind: 'scheduled',
  workflow_id: workflowId, workflow_version: '1', daily_time: '09:00', time_zone: 'Asia/Shanghai',
})

it('按本地时间计算每日触发，DST 跳过不存在的分钟，重复的分钟只触发一次', () => {
  expect(nextDailyFire('09:00', 'Asia/Shanghai', NOW)).toBe(DUE)
  expect(nextDailyFire('09:00', 'Asia/Shanghai', DUE)).toBe(TOMORROW)
  expect(nextDailyFire('02:30', 'America/New_York', '2026-03-08T05:00:00.000Z')).toBe('2026-03-09T06:30:00.000Z')
  expect(nextDailyFire('01:30', 'America/New_York', '2026-11-01T04:00:00.000Z')).toBe('2026-11-01T05:30:00.000Z')
  expect(nextDailyFire('01:30', 'America/New_York', '2026-11-01T05:30:00.000Z')).toBe('2026-11-02T06:30:00.000Z')
  expect(() => nextDailyFire('09:00', '+08:00', NOW)).toThrow(/IANA/)
})

it('同一任务累积真实运行，重启幂等且不并行启动第二次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-daily-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    publish(service)
    const db = service.orchestra.db
    const triggers = createTaskTriggerHost(db, service.orchestra.catalog)
    // Tie fixture time to the future so the actual host timer cannot race the controlled ticks.
    const before = '2099-11-18T00:59:00.000Z'
    const dueAt = '2099-11-18T01:00:00.000Z'
    const dueNext = '2099-11-19T01:00:00.000Z'
    const dueThird = '2099-11-20T01:00:00.000Z'
    const dueFourth = '2099-11-21T01:00:00.000Z'
    const submit = scheduled()
    const rule = triggers.create(submit, 'test', before)
    expect(rule).toMatchObject({ next_fire_at: dueAt, enabled: true, revision: 1 })
    expect(triggers.create(submit, 'test', before)).toEqual(rule)
    const scan = (iso: string) => triggers.tick(iso, (err) => { throw err })
    scan(before)
    expect(db.raw.prepare('SELECT count(*) AS n FROM runs').get()).toMatchObject({ n: 0 })
    scan(dueAt)
    scan(dueAt)
    const first = db.raw.prepare('SELECT run_id, task_id, workflow_version FROM runs').get() as { run_id: string; task_id: string }
    expect(first).toMatchObject({ task_id: rule.task_id, workflow_version: 1 })
    expect(db.raw.prepare('SELECT status FROM node_runs WHERE run_id = ?').get(first.run_id)).toMatchObject({ status: 'queued' })
    scan(dueNext)
    expect(db.raw.prepare('SELECT status, reason FROM task_trigger_occurrences WHERE due_at = ?').get(dueNext))
      .toMatchObject({ status: 'skipped', reason: 'previous_run_active' })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'done', side_effect_policy = 'pure' WHERE run_id = ?", [first.run_id])
      expect(closeRun(tx, SECRET, first.run_id, dueNext)).toBe('succeeded')
    })
    expect(db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(rule.task_id)).toMatchObject({ status: 'succeeded' })
    expect(getTaskSummarySnapshot(db, rule.task_id).item).toMatchObject({ status: 'succeeded', lane: 'upcoming', next_trigger_at: dueThird })
    await service.close()
    service = undefined

    service = await boot(dir)
    const reopened = createTaskTriggerHost(service.orchestra.db, service.orchestra.catalog)
    expect(reopened.list(rule.task_id).items[0]).toMatchObject({ next_fire_at: dueThird, last_fired_at: dueAt })
    service.orchestra.commands.setWorkflowStatus({
      workflowId, status: 'disabled', expectedStatus: 'active', now: dueNext, actor: 'tester', operationId: uuidv7(),
    })
    reopened.tick(dueThird, (err) => { throw err })
    reopened.tick(dueThird, (err) => { throw err })
    expect(service.orchestra.db.raw.prepare('SELECT status, reason FROM task_trigger_occurrences WHERE due_at = ?').get(dueThird))
      .toMatchObject({ status: 'skipped', reason: 'workflow_inactive' })
    service.orchestra.commands.setWorkflowStatus({
      workflowId, status: 'active', expectedStatus: 'disabled', now: dueThird, actor: 'tester', operationId: uuidv7(),
    })
    reopened.tick(dueFourth, (err) => { throw err })
    const runs = service.orchestra.db.raw.prepare('SELECT task_id, run_id FROM runs ORDER BY created_at').all()
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.task_id === rule.task_id)).toBe(true)
    expect(runs[1]?.run_id).not.toBe(first.run_id)
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('生产宿主在重启时扫描到期定时，按可信节点规格派发进入等待', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-restart-dispatch-'))
  let service: Awaited<ReturnType<typeof boot>> | undefined
  try {
    service = await boot(dir)
    service.orchestra.commands.createWorkflow({
      workflowId, name: definition.name, scope: 'reusable', actor: 'tester', now: NOW, operationId: uuidv7(),
      definition: {
        ...definition,
        nodes: [node('trigger', 'trigger'), {
          ...node('read', 'wait'), config: { wait_kind: 'event', match: { type: 'project.ready' }, max_wait_ms: 60_000 },
        }],
      },
    })
    expect(service.orchestra.commands.testWorkflowDraft({ workflowId, revision: 1, now: NOW }).passed).toBe(true)
    service.orchestra.commands.publishWorkflow({
      workflowId, revision: 1, baseVersion: 0, note: 'fixture', actor: 'tester', now: NOW, operationId: uuidv7(),
    })
    const creation = await request(service, '', scheduled())
    expect(creation.status).toBe(200)
    const { data: rule } = await creation.json() as { data: TaskTriggerView }
    const due = new Date(Date.now() - 5000).toISOString()
    withTx(service.orchestra.db, (tx) => {
      tx.run('UPDATE task_triggers SET next_fire_at = ? WHERE trigger_id = ?', [due, rule.trigger_id])
    })
    await service.close()
    service = undefined

    const resolve = vi.fn<ResolveTriggerNodeSpecs>(() => ({ read: { tools: [] } }))
    service = await boot(dir, resolve)
    const db = service.orchestra.db
    await vi.waitFor(() => expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_id = 'read'").get()).toMatchObject({ status: 'waiting' }))
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ task_id: rule.task_id, workflow_id: workflowId, workflow_version: '1' }), expect.any(AbortSignal))
    expect(db.raw.prepare('SELECT status, due_at FROM task_trigger_occurrences').all()).toEqual([{ status: 'started', due_at: due }])
  } finally {
    await service?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('真实 HTTP 事件入口要求认证，固定版本，重放同一事件；暂停期间不重新匹配', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-trigger-event-'))
  const service = await boot(dir)
  try {
    publish(service)
    expect((await fetch(service.endpoint + '/v1/task-triggers/event', { method: 'POST' })).status).toBe(401)
    expect((await request(service, '', { ...scheduled(), daily_time: '25:10' })).status).toBe(400)
    expect((await request(service, '', { ...scheduled(), workflow_version: '2' })).status).toBe(409)
    const ruleResponse = await request(service, '', {
      operation_id: uuidv7(), title: '项目就绪触发', kind: 'event',
      workflow_id: workflowId, workflow_version: '1', event_type: 'project.ready',
    })
    expect(ruleResponse.status).toBe(200)
    const { data: rule } = await ruleResponse.json() as { data: TaskTriggerView }
    const list = await request(service, '?task_id=' + rule.task_id)
    expect(await list.json()).toMatchObject({ data: { items: [rule] } })
    const firstEvent = { event_id: 'project-ready-1', event_type: 'project.ready' }
    const response = await request(service, '/event', firstEvent)
    const started = await response.json()
    expect(started).toMatchObject({ data: { replayed: false, items: [{ task_id: rule.task_id, status: 'started', reason: null }] } })
    expect(await (await request(service, '/event', firstEvent)).json()).toMatchObject({ data: { ...started.data, replayed: true } })
    expect((await request(service, '/event', { ...firstEvent, event_type: 'other' })).status).toBe(409)
    const pause = { operation_id: uuidv7(), trigger_id: rule.trigger_id, expected_revision: rule.revision, enabled: false }
    expect(await (await request(service, '/enabled', pause)).json()).toMatchObject({ data: { enabled: false, revision: rule.revision + 1 } })
    expect((await request(service, '/enabled', { ...pause, operation_id: uuidv7() })).status).toBe(409)
    const paused = { ...firstEvent, event_id: 'project-ready-2' }
    expect(await (await request(service, '/event', paused)).json()).toMatchObject({ data: { replayed: false, items: [] } })
    expect(await (await request(service, '/enabled', { ...pause, expected_revision: rule.revision + 1, enabled: true, operation_id: uuidv7() })).json())
      .toMatchObject({ data: { enabled: true } })
    expect(await (await request(service, '/event', paused)).json()).toMatchObject({ data: { replayed: true, items: [] } })
    expect(service.orchestra.db.raw.prepare('SELECT task_id FROM runs').all()).toEqual([{ task_id: rule.task_id }])
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
