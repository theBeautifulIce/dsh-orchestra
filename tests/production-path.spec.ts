// 生产全链路：加载定义 → 建 run 与节点 → 派发 → 收口，全程 HTTP（审计 F-01）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrchestra } from '../src/index.ts'
import { startServer } from '../src/service/server.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../src/executor/tools.ts'
import type { HostAgentFactory } from '../src/executor/session.ts'

const SECRET = 'prod-path-secret'
const NOW = '2026-11-13T03:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-prod-'))
  dirs.push(dir)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = { readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }) }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_prod', sessionId: 'sess_prod' }) }
  const orchestra = createOrchestra({
    dbFile: join(dir, 'orchestra.db'),
    secret: SECRET,
    phase: 'S2',
    executor: { registry, agents, runner: new ReadOnlyToolRunner(registry, host, dir) },
  })
  const svc = await startServer({
    secret: SECRET, phase: 'S2', epoch: orchestra.db.epoch,
    asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    commands: orchestra.commands,
  })
  closers.push(async () => { await svc.close(); orchestra.close() })
  return { endpoint: svc.endpoint, db: orchestra.db }
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

describe('生产全链路：定义 → run → 派发 → 收口', () => {
  it('一条路走完：加载定义、建 run 与节点、派发、节点落到 done', async () => {
    const { endpoint, db } = await boot()
    const loaded = await post(endpoint + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent' }],
    })
    expect(loaded.status).toBe(200)

    const created = await post(endpoint + '/v1/runs', { taskTitle: '全链路验证', workflowVersion: '1', now: NOW })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as any
    expect(createdBody.data.nodes).toHaveLength(1)
    expect(createdBody.data.nodes[0].status).toBe('queued')
    const runId = createdBody.data.run_id
    const nodeRunId = createdBody.data.nodes[0].node_run_id

    // run 与节点是服务层建的行，不是测试里手写 INSERT
    const runRow = db.raw.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as any
    expect(runRow.workflow_version).toBe(1)
    expect(runRow.status).toBe('running')

    const dispatched = await post(endpoint + '/v1/runs/dispatch', {
      runId,
      now: NOW,
      nodes: {
        check: {
          toolPolicy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' },
          tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        },
      },
    })
    expect(dispatched.status).toBe(200)
    const dispatchedBody = await dispatched.json() as any
    expect(dispatchedBody.data[0].status).toBe('done')
    expect(dispatchedBody.data[0].evidence_source).toBe('run_tool')

    const nodeRow = db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as any
    expect(nodeRow.status).toBe('done')
    const registry = db.raw.prepare('SELECT * FROM report_registry WHERE node_run_id = ?').get(nodeRunId) as any
    expect(registry.state).toBe('applied')
    const types = (db.raw.prepare('SELECT type FROM node_run_events WHERE node_run_id = ? ORDER BY seq').all(nodeRunId) as { type: string }[]).map((r) => r.type)
    expect(types).toContain('lease_acquired')
    expect(types).toContain('tool_started')
    expect(types).toContain('report_applied')
  })

  it('定义没加载过 → 建 run 直接 404 NOT_FOUND', async () => {
    const { endpoint } = await boot()
    const res = await post(endpoint + '/v1/runs', { taskTitle: '没定义', workflowVersion: '99', now: NOW })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('节点缺工具配置 → 这一轮跳过，不动节点状态', async () => {
    const { endpoint, db } = await boot()
    await post(endpoint + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent' }],
    })
    const created = await post(endpoint + '/v1/runs', { taskTitle: '缺配置', workflowVersion: '1', now: NOW })
    const createdBody = await created.json() as any
    const res = await post(endpoint + '/v1/runs/dispatch', { runId: createdBody.data.run_id, now: NOW, nodes: {} })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data[0].status).toBe('skipped')
    expect(body.data[0].reason).toBe('no_node_spec')
    const nodeRow = db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get(createdBody.data.nodes[0].node_run_id) as any
    expect(nodeRow.status).toBe('queued')
  })
})
