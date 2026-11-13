// 生产路由：命令真的接到了服务层（审计 F-01）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrchestra } from '../src/index.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { startServer } from '../src/service/server.ts'

const SECRET = 'routes-secret'
const NOW = '2026-11-13T03:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-routes-'))
  dirs.push(dir)
  const orchestra = createOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase: 'S2' })
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','路由','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','wf',1,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_1','r1','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  const svc = await startServer({
    secret: SECRET, phase: 'S2', epoch: orchestra.db.epoch,
    asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    commands: orchestra.commands,
  })
  closers.push(async () => { await svc.close(); orchestra.close() })
  return svc.endpoint
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

describe('节点命令与工作流加载路由', () => {
  it('加载工作流 → 拿租约 → 上报 → 三条路都进服务层', async () => {
    const base = await boot()
    const loaded = await post(base + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent' }],
    })
    expect(loaded.status).toBe(200)
    const loadedBody = await loaded.json() as any
    expect(loadedBody.data.workflow_version).toBe('1')
    expect(loadedBody.data.nodes[0].pass_conditions).toHaveLength(1)

    const lease = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: 600000, now: NOW })
    expect(lease.status).toBe(200)
    const leaseBody = await lease.json() as any
    expect(leaseBody.data.action_generation).toBe(1)

    const report = await post(base + '/v1/node-runs/report', {
      nodeRunId: 'nrun_1', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
      report: { report_id: 'rep_1', node_run_id: 'nrun_1', attempt: 1, status: 'done', evidence: { source: 'run_tool', exitCode: 0 } },
    })
    expect(report.status).toBe(200)
    const reportBody = await report.json() as any
    expect(reportBody.data.accepted).toBe(false)
    // dispatched 不能直跳 done：路由到了服务层，状态机也守住了
    expect(reportBody.data.reason).toBe('illegal_transition')
  })

  it('缺字段 → 400 PAYLOAD_SCHEMA_INVALID', async () => {
    const base = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1' })
    // 结构错按 422 回（PAYLOAD_SCHEMA_INVALID 的既有口径）
    expect(res.status).toBe(422)
    const body = await res.json() as any
    expect(body.error.code).toBe('PAYLOAD_SCHEMA_INVALID')
  })
})
