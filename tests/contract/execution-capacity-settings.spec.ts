import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { ReadOnlyToolRunner, serveOrchestra, ToolRegistry } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'

const secret = 'execution-settings-fixture'
const path = '/v1/settings/execution-capacity'
const bridgeFixtureAt = '2026-11-13T03:00:00.000Z'
const defaults = { concurrency: 1, max_waiting: 4, action_timeout_ms: 75_123 }
const options = {
  secret, phase: 'S6' as const,
  asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'test' }),
  resolveHttpHuman: (req: Parameters<NonNullable<Parameters<typeof serveOrchestra>[0]['resolveHttpHuman']>>[0]) =>
    req.headers['x-test-session'] === 'local' ? { id: 'local-fixture' } : null,
}

function configAt(directory: string) {
  const config = JSON.parse(readFileSync(new URL('../../orchestra.config.json', import.meta.url), 'utf8'))
  const file = join(directory, 'config.json')
  writeFileSync(file, JSON.stringify({ ...config, execution: { ...config.execution, ...defaults } }))
  return file
}

function request(endpoint: string, target: string, body?: unknown, identified = true) {
  return fetch(endpoint + target, {
    headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json', ...(identified ? { 'x-test-session': 'local' } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
}

it('保存校验认证、版本与回执，持久化并在重开时应用，恢复宿主默认值', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-execution-settings-'))
  const configPath = configAt(directory)
  const open = (dbName: string, scheduler?: ReturnType<typeof createExecutionScheduler>) => serveOrchestra({
    ...options, dbFile: join(directory, dbName), configPath, scheduler,
  })
  let service = await open('local.db')
  let other: typeof service | undefined
  try {
    expect(await (await request(service.endpoint, '/health')).json()).toMatchObject({ data: { execution_capacity_enabled: true } })
    expect((await request(service.endpoint, path, undefined, false)).status).toBe(403)
    expect((await request(service.endpoint, path, {}, false)).status).toBe(403)
    expect(await (await request(service.endpoint, path)).json()).toMatchObject({ data: { revision: 0, values: defaults, defaults, overridden: false } })
    const save = { operation_id: uuidv7(), expected_revision: 0, values: { concurrency: 2, max_waiting: 3, action_timeout_ms: 109_456 } }
    for (const values of [
      { ...save.values, concurrency: 0 }, { ...save.values, concurrency: 1.5 },
      { ...save.values, max_waiting: 10_001 }, { ...save.values, action_timeout_ms: 999 },
      { ...save.values, human_slots: 1 },
    ]) expect((await request(service.endpoint, path, { ...save, values })).status).toBe(400)
    for (const values of [{ ...save.values, concurrency: 33 }, { ...save.values, action_timeout_ms: 3_600_001 }]) {
      expect((await request(service.endpoint, path, { ...save, values })).status).toBe(422)
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await (await request(service.endpoint, path, save)).json()).toMatchObject({ ok: true, data: { revision: 1 } })
    }
    expect((await request(service.endpoint, path, { ...save, operation_id: uuidv7() })).status).toBe(409)
    expect(await (await request(service.endpoint, '/v1/operations/get?operation_id=' + save.operation_id)).json())
      .toMatchObject({ data: { kind: 'execution_capacity.save', status: 'applied' } })
    other = await open('other.db')
    expect(await (await request(other.endpoint, path)).json()).toMatchObject({ data: { revision: 0, values: defaults } })
    await service.close()
    const scheduler = createExecutionScheduler({ concurrency: defaults.concurrency, maxWaiting: defaults.max_waiting })
    service = await open('local.db', scheduler)
    expect(scheduler.stats()).toMatchObject({ concurrency: 2, maxWaiting: 3 })
    expect(service.orchestra.executionCapacitySettings?.actionTimeoutMs()).toBe(109_456)
    expect(await (await request(service.endpoint, path)).json()).toMatchObject({ data: { revision: 1, values: save.values, defaults, overridden: true } })
    const reset = { operation_id: uuidv7(), expected_revision: 1, values: null }
    expect(await (await request(service.endpoint, path, reset)).json()).toMatchObject({ ok: true, data: { revision: 2 } })
    expect(scheduler.stats()).toMatchObject({ concurrency: 1, maxWaiting: 4 })
    expect(service.orchestra.executionCapacitySettings?.actionTimeoutMs()).toBe(75_123)
    expect(await (await request(service.endpoint, path, save)).json()).toMatchObject({ ok: true, data: { revision: 1 } })
    expect(scheduler.stats()).toMatchObject({ concurrency: 1, maxWaiting: 4 })
    expect(service.orchestra.executionCapacitySettings?.actionTimeoutMs()).toBe(75_123)
  } finally {
    await other?.close()
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('修改队列时保留旧宿主的大容量默认值，重新加载后跟随新宿主', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-legacy-capacity-'))
  const configPath = configAt(directory)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const legacy = { concurrency: 48, max_waiting: 4, action_timeout_ms: 4_000_000 }
  writeFileSync(configPath, JSON.stringify({ ...config, execution: { ...config.execution, ...legacy } }))
  const open = () => serveOrchestra({ ...options, dbFile: join(directory, 'local.db'), configPath })
  let service = await open()
  try {
    expect((await request(service.endpoint, path, { operation_id: uuidv7(), expected_revision: 0,
      values: { ...legacy, concurrency: 47 } })).status).toBe(422)
    expect((await request(service.endpoint, path, { operation_id: uuidv7(), expected_revision: 0,
      values: { ...legacy, max_waiting: 2 } })).status).toBe(200)
    await service.close()
    writeFileSync(configPath, JSON.stringify(config))
    service = await open()
    expect(await (await request(service.endpoint, path)).json()).toMatchObject({ data: {
      values: { ...defaults, max_waiting: 2 }, defaults, revision: 1,
    } })
  } finally {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('真实执行入口保留在跑步骤时限，在排队节点开跑时读取新时限', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-execution-timer-'))
  const configPath = configAt(directory)
  const scheduler = createExecutionScheduler({ concurrency: defaults.concurrency, maxWaiting: defaults.max_waiting })
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const firstToolRelease = Promise.withResolvers<void>()
  let started = 0
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => true,
    run: async () => {
      started += 1
      if (started === 1) await firstToolRelease.promise
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  }, directory)
  const bridge = fakeAgentClient({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: bridgeFixtureAt })
  const service = await serveOrchestra({ ...options, dbFile: join(directory, 'local.db'), configPath, scheduler, executor: { registry, runner, bridge } })
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const nodeIds = ['first', 'second']
  try {
    const { db, catalog, commands } = service.orchestra
    const now = new Date().toISOString()
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('task','执行设置测试','running',1,?,?)", [now, now])
      tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('run','task','wf',1,'running',1,?,?)", [now, now])
      for (const [index, nodeId] of nodeIds.entries()) {
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'run', ?, ?, 'agent', 1, 'queued', 0, ?, ?)", [nodeId, nodeId, index + 1, now, now])
      }
    })
    commands.loadWorkflow({
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: nodeIds.map((node_id) => ({ node_id, type: 'agent', tools: { allow: ['ro.echo'], deny: [] } })),
    })
    bindRunVersion(db, catalog, 1, 'run')
    const run = (nodeId: string) => request(service.endpoint, '/v1/node-runs/run', {
      nodeRunId: nodeId, nodeId, attempt: 1, now, ownerEpoch: db.epoch,
      leaseTtlMs: 60_000, leaseRenewIntervalMs: 5_000, tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
    })
    const first = run('first')
    await expect.poll(() => started).toBe(1)
    expect(timers.mock.calls.filter(([, timeout]) => timeout === defaults.action_timeout_ms)).toHaveLength(1)
    const second = run('second')
    await expect.poll(() => scheduler.isWaiting?.('second')).toBe(true)
    const action_timeout_ms = 109_456
    const saved = await request(service.endpoint, path, {
      operation_id: uuidv7(), expected_revision: 0, values: { ...defaults, max_waiting: 1, action_timeout_ms },
    })
    expect(saved.status).toBe(200)
    expect(scheduler.stats()).toMatchObject({ inFlight: 1, waiting: 1, maxWaiting: 1 })
    expect(timers.mock.calls.some(([, timeout]) => timeout === action_timeout_ms)).toBe(false)
    firstToolRelease.resolve()
    for (const response of await Promise.all([first, second])) {
      expect(await response.json()).toMatchObject({ ok: true, data: { final_status: 'done' } })
    }
    const stopped = db.raw.prepare("SELECT node_run_id,payload FROM node_run_events WHERE type='recovery.host_stopped' ORDER BY node_run_id")
      .all() as { node_run_id: string; payload: string }[]
    expect(stopped.map(({ node_run_id, payload }) => ({ node_run_id, ...JSON.parse(payload) }))).toMatchObject(
      nodeIds.map(node_run_id => ({ node_run_id, attempt: 1, action_generation: 1, executor_agent_id: 'agent_1', stopped_at: expect.any(String) })),
    )
    expect(timers.mock.calls.filter(([, timeout]) => timeout === defaults.action_timeout_ms)).toHaveLength(1)
    expect(timers.mock.calls.filter(([, timeout]) => timeout === action_timeout_ms)).toHaveLength(1)
  } finally {
    firstToolRelease.resolve()
    timers.mockRestore()
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
