// 生产并发闸回归：/v1/runs/dispatch 与 /v1/node-runs/run 必须共用同一个调度器（S2 第三十七轮 P0-01）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { startServer } from '../../src/service/server.ts'
import { createExecutionScheduler, type ExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../../src/executor/tools.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'

const SECRET = 'concurrency-secret'
const NOW = '2026-11-14T03:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

it('双入口共用一个并发上限：6 个节点同时提交，最多只跑 2 个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-concurrency-'))
  dirs.push(dir)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })

  let active = 0
  let maxActive = 0
  let started = 0
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => {
      active += 1
      started += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return { exitCode: 0, stdout: 'ok\n', stderr: '' }
    },
  }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }) }
  const bridge = fakeAgentClient({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
  const scheduler: ExecutionScheduler = createExecutionScheduler({ concurrency: 2 })
  const service = await openServiceOrchestra({
    dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase: 'S2',
    executor: { registry, agents, bridge, runner: new ReadOnlyToolRunner(registry, host, dir) },
    scheduler,
  })
  const orchestra = service.orchestra

  const nodeIds = ['d1', 'd2', 'd3', 's1', 's2', 's3']
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','并发','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r_disp','t1','wf',1,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r_direct','t1','wf',1,'running',1,?,?)", [NOW, NOW])
    let seq = 0
    for (const nodeId of ['d1', 'd2', 'd3']) {
      seq += 1
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'r_disp', ?, ?, 'agent', 1, 'queued', 0, ?, ?)", ['nrun_' + nodeId, nodeId, seq, NOW, NOW])
    }
    for (const nodeId of ['s1', 's2', 's3']) {
      seq += 1
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'r_direct', ?, ?, 'agent', 1, 'queued', 0, ?, ?)", ['nrun_' + nodeId, nodeId, seq, NOW, NOW])
    }
  })
  const svc = await startServer({
    secret: SECRET, phase: 'S2', epoch: orchestra.db.epoch,
    asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    now: () => NOW,
    commands: orchestra.commands,
  })
  closers.push(async () => { await svc.close(); await service.release() })

  const loaded = await post(svc.endpoint + '/v1/workflows/load', {
    workflow_version: '1',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: nodeIds.map((node_id) => ({ node_id, type: 'agent', tools: { allow: ['ro.echo'], deny: [] } })),
  })
  expect(loaded.status).toBe(200)
  bindRunVersion(orchestra.db, orchestra.catalog, 1, 'r_disp')
  bindRunVersion(orchestra.db, orchestra.catalog, 1, 'r_direct')

  // 两条入口同时开火：3 个走 dispatch，3 个走 runNode
  const dispatch = post(svc.endpoint + '/v1/runs/dispatch', {
    runId: 'r_disp',
    nodes: {
      d1: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] },
      d2: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] },
      d3: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] },
    },
    now: NOW,
    ownerEpoch: orchestra.db.epoch,
    leaseTtlMs: 60000,
    leaseRenewIntervalMs: 5000,
  })
  const direct = ['s1', 's2', 's3'].map((nodeId) =>
    post(svc.endpoint + '/v1/node-runs/run', {
      nodeRunId: 'nrun_' + nodeId, nodeId, attempt: 1, now: NOW,
      ownerEpoch: orchestra.db.epoch, leaseTtlMs: 60000, leaseRenewIntervalMs: 5000,
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
    }),
  )
  const responses = await Promise.all([dispatch, ...direct])
  for (const res of responses) expect(res.status).toBe(200)

  const dispatched = await responses[0].json() as any
  expect(dispatched.data.map((row: any) => row.status)).toEqual(['done', 'done', 'done'])
  for (const res of responses.slice(1)) {
    const body = await res.json() as any
    expect(body.data.final_status).toBe('done')
  }

  // 两条入口合计的真实并发被同一个闸压到 2
  expect(started).toBe(6)
  expect(maxActive).toBe(2)
  expect(scheduler.inFlight).toBe(0)
  expect(scheduler.waiting).toBe(0)
})
