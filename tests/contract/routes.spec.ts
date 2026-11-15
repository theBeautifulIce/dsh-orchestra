// 生产路由：命令真的接到了服务层（审计 F-01）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { startServer } from '../../src/service/server.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../../src/executor/tools.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { enterWaiting } from '../../src/service/commands/wait.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const SECRET = 'routes-secret'
const NOW = '2026-11-13T03:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot(withExecutor = false, nowProvider?: () => string) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-routes-'))
  dirs.push(dir)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = { readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }) }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }) }
  const bridge = fakeAgentClient({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
  const executor = withExecutor ? { registry, agents, bridge, runner: new ReadOnlyToolRunner(registry, host, dir) } : undefined
  const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase: 'S2', ...(executor ? { executor } : {}) })
  const orchestra = service.orchestra
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
    now: nowProvider ?? (() => NOW),
    commands: orchestra.commands,
  })
  closers.push(async () => { await svc.close(); await service.release() })
  return { endpoint: svc.endpoint, orchestra }
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

describe('节点命令与工作流加载路由', () => {
  it('加载工作流 → 拿租约 → 上报 → 三条路都进服务层', async () => {
    const { endpoint: base } = await boot()
    const loaded = await post(base + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent' }],
    })
    expect(loaded.status).toBe(200)
    const loadedBody = await loaded.json() as any
    expect(loadedBody.data.workflow_version).toBe('1')
    expect(loadedBody.data.nodes[0].pass_conditions).toHaveLength(1)

    const lease = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: 60000, now: NOW })
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

  it('生产执行路由：/v1/node-runs/run 一路跑到 done', async () => {
    const { endpoint: base, orchestra } = await boot(true)
    const loaded = await post(base + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
    })
    expect(loaded.status).toBe(200)
    bindRunVersion(orchestra.db, orchestra.catalog, 1, 'r1')
    const run = await post(base + '/v1/node-runs/run', {
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, now: NOW, ownerEpoch: 1, leaseTtlMs: 60000, leaseRenewIntervalMs: 5000,
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
    })
    expect(run.status).toBe(200)
    const body = await run.json() as any
    expect(body.data.final_status).toBe('done')
    expect(body.data.evidence.source).toBe('run_tool')
  })

  it('加载 parallel 定义 → HTTP 403 FORBIDDEN', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/workflows/load', {
      workflow_version: '1',
      nodes: [{ node_id: 'n1', type: 'parallel' }],
    })
    expect(res.status).toBe(403)
    const body = await res.json() as any
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('上报时间以服务端时钟为准，body.now 不能回拨租约', async () => {
    let current = NOW
    const { endpoint: base } = await boot(false, () => current)
    const loaded = await post(base + '/v1/workflows/load', {
      workflow_version: '1',
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent' }],
    })
    expect(loaded.status).toBe(200)
    const lease = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: 1000 })
    expect(lease.status).toBe(200)
    current = '2026-11-13T03:00:02.000Z'
    const report = await post(base + '/v1/node-runs/report', {
      nodeRunId: 'nrun_1', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
      report: { report_id: 'rep_clock', node_run_id: 'nrun_1', attempt: 1, status: 'started', evidence: { source: 'run_tool', exitCode: 0 } },
    })
    expect(report.status).not.toBe(200)
    const body = await report.json() as any
    expect(body.error.code).toBe('LEASE_EXPIRED')
  })

  it('缺字段 → 400 PAYLOAD_SCHEMA_INVALID', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1' })
    // 入参不合法按 400 回：请求体本身不合法，与服务端结构错（422）不是一回事
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error.code).toBe('PAYLOAD_SCHEMA_INVALID')
  })
})

describe('入参校验：每条命令一套 Zod Schema', () => {
  // 入参不合法统一 400：错误码沿用 PAYLOAD_SCHEMA_INVALID，details.issues 逐项点名
  const expectBadRequest = async (res: Response, field: string) => {
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error.code).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(body.error.message).toContain(field)
    expect(body.error.details.issues.length).toBeGreaterThan(0)
  }

  it('leaseTtlMs 负数 → 400 并点名 leaseTtlMs', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: -1000 })
    await expectBadRequest(res, 'leaseTtlMs')
  })

  it('leaseTtlMs 传字符串 → 400（不拿字符串凑数）', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: '60000' })
    await expectBadRequest(res, 'leaseTtlMs')
  })

  it('leaseTtlMs 超大整数 → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: 1e21 })
    await expectBadRequest(res, 'leaseTtlMs')
  })

  it('leaseTtlMs 超过上限 120000 → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: 1, leaseTtlMs: 600000 })
    await expectBadRequest(res, 'leaseTtlMs')
  })

  it('ownerEpoch 负数 → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'nrun_1', ownerEpoch: -1, leaseTtlMs: 60000 })
    await expectBadRequest(res, 'ownerEpoch')
  })

  it('续租间隔为 0 → 400（不能让续租定时器狂写库）', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/run', {
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, leaseRenewIntervalMs: 0, tools: [],
    })
    await expectBadRequest(res, 'leaseRenewIntervalMs')
  })

  it('续租间隔不小于租约时长的一半 → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/run', {
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, leaseTtlMs: 1000, leaseRenewIntervalMs: 500, tools: [],
    })
    await expectBadRequest(res, 'leaseRenewIntervalMs')
  })

  it('畸形 tools → 400 并点名 tools.0', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/run', {
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1,
      tools: [{ command: '', args: 'not-array', cwd: 1, timeoutMs: -5 }],
    })
    await expectBadRequest(res, 'tools.0')
  })

  it('超长 nodeRunId → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/lease', { nodeRunId: 'n'.repeat(200), ownerEpoch: 1, leaseTtlMs: 60000 })
    await expectBadRequest(res, 'nodeRunId')
  })

  it('cancelResult 不在枚举内 → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/cancel', {
      nodeRunId: 'nrun_1', attempt: 1, revision: 1, cancelResult: 'not_a_result', graceMs: 1000,
    })
    await expectBadRequest(res, 'cancelResult')
  })

  it('report 缺 report_id → 400 并点名 report.report_id', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/node-runs/report', {
      nodeRunId: 'nrun_1', attempt: 1, expectedStatus: 'dispatched', generation: 1,
      report: { node_run_id: 'nrun_1', attempt: 1, status: 'done' },
    })
    await expectBadRequest(res, 'report.report_id')
  })

  it('report_id 带引号/反斜杠 → 400 并点名 report.report_id（第三十四轮审计 P1-1）', async () => {
    const { endpoint: base } = await boot()
    for (const bad of ['rep_"quote', 'rep_\\back', 'rep_ sp ace']) {
      const res = await post(base + '/v1/node-runs/report', {
        nodeRunId: 'nrun_1', attempt: 1, expectedStatus: 'dispatched', generation: 1,
        report: { report_id: bad, node_run_id: 'nrun_1', attempt: 1, status: 'done', evidence: { source: 'run_tool', exitCode: 0 } },
      })
      await expectBadRequest(res, 'report.report_id')
    }
  })

  it('建 run 缺 taskTitle → 400', async () => {
    const { endpoint: base } = await boot()
    const res = await post(base + '/v1/runs', { workflowVersion: '1' })
    await expectBadRequest(res, 'taskTitle')
  })

  it('租约与续租间隔合法 → 放行到服务层（不再 400）', async () => {
    const { endpoint: base } = await boot()
    // 没装执行器时派发命令停在执行器缺失：这里只证明入参校验放行，不是 400
    const res = await post(base + '/v1/runs/dispatch', {
      runId: 'r1', ownerEpoch: 1, leaseTtlMs: 60000, leaseRenewIntervalMs: 5000, nodes: {},
    })
    expect(res.status).not.toBe(400)
    const body = await res.json() as any
    expect(body.error.code).toBe('EVIDENCE_SOURCE_UNAVAILABLE')
  })
})

describe('起运行与裁决收口路由', () => {
  it('start-run 固定版本并支持 operation_id 幂等重放', async () => {
    const { endpoint: base } = await boot()
    await post(base + '/v1/workflows/load', { workflow_version: '1', nodes: [{ node_id: 'check', type: 'agent' }] })
    const first = await post(base + '/v1/runs/start', { taskTitle: '起运行', workflowVersion: '1', operationId: 'op-1' })
    expect(first.status).toBe(200)
    const a = await first.json() as any
    expect(a.data.run_id).toBeTruthy()
    expect(a.data.replayed).toBe(false)
    const second = await post(base + '/v1/runs/start', { taskTitle: '起运行', workflowVersion: '1', operationId: 'op-1' })
    const b = await second.json() as any
    expect(b.data.run_id).toBe(a.data.run_id)
    expect(b.data.replayed).toBe(true)
  })

  it('decision.resolve 批准后同一事务把 blocked_pre 节点放回 queued', async () => {
    const { endpoint: base, orchestra } = await boot()
    withTx(orchestra.db, (tx) => {
      tx.run(
        "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, resume_state, blocked_decision_id, created_at, updated_at) " +
          "VALUES ('nrun_blocked','r1','check2',2,'agent',1,'blocked_pre',0,'queued','d-block',?,?)",
        [NOW, NOW],
      )
      openDecision(tx, {
        decisionId: 'd-block', runId: 'r1', nodeRunId: 'nrun_blocked', kind: 'pre_execution', approver: 'human', payload: {},
      })
    })
    const res = await post(base + '/v1/decisions/resolve', {
      decisionId: 'd-block', revision: 1, resolution: 'approved',
    })
    expect(res.status).toBe(200)
    const node = orchestra.db.raw.prepare('SELECT status, blocked_decision_id FROM node_runs WHERE node_run_id = ?').get('nrun_blocked') as { status: string; blocked_decision_id: string | null }
    expect(node.status).toBe('queued')
    expect(node.blocked_decision_id).toBeNull()
  })

  it('decision.resolve 走批准人与 revision CAS', async () => {
    const { endpoint: base, orchestra } = await boot()
    withTx(orchestra.db, (tx) => openDecision(tx, {
      decisionId: 'd-route', runId: 'r1', nodeRunId: null, kind: 'pre_execution', approver: 'human', payload: {},
    }))
    const ok = await post(base + '/v1/decisions/resolve', {
      decisionId: 'd-route', revision: 1, resolution: 'approved', actor: { kind: 'human', id: 'human:forged' },
    })
    expect(ok.status).toBe(200)
    const resolvedBy = (orchestra.db.raw.prepare('SELECT resolved_by FROM decisions WHERE decision_id = ?').get('d-route') as { resolved_by: string }).resolved_by
    expect(resolvedBy.startsWith('service:')).toBe(true)
    expect(resolvedBy).not.toContain('forged')
    const stale = await post(base + '/v1/decisions/resolve', {
      decisionId: 'd-route', revision: 1, resolution: 'approved', actor: { kind: 'human', id: 'human:test' },
    })
    expect(stale.status).toBe(409)
  })

  it('补偿开始与收口都有生产路由，收口保留原节点状态', async () => {
    const { endpoint: base, orchestra } = await boot()
    withTx(orchestra.db, (tx) => {
      tx.run(
        "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) " +
          "VALUES ('nrun_comp','r1','comp',3,'agent',1,'failed',0,?,?)",
        [NOW, NOW],
      )
    })
    const started = await post(base + '/v1/compensations/start', {
      nodeRunId: 'nrun_comp', attempt: 1,
      descriptor: { tool: 'rm', args: ['tmp/a'], verify: { command: 'test', args: ['!', '-e', 'tmp/a'] }, descriptorVersion: 'v1' },
    })
    expect(started.status).toBe(200)
    const a = await started.json() as any
    expect(a.data.started).toBe(true)
    const settled = await post(base + '/v1/compensations/settle', {
      compensationId: a.data.compensationId, state: 'applied', evidence: { exitCode: 0 },
    })
    expect(settled.status).toBe(200)
    expect((await settled.json() as any).data.settled).toBe(true)
    const node = orchestra.db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nrun_comp') as { status: string }
    expect(node.status).toBe('failed')
  })

  it('等待事件走生产路由：先落 inbox，再唤醒同 run 的活跃等待', async () => {
    const { endpoint: base, orchestra } = await boot()
    withTx(orchestra.db, (tx) => {
      tx.run(
        "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) " +
          "VALUES ('nrun_wait','r1','wait',2,'wait',1,'started',0,?,?)",
        [NOW, NOW],
      )
      enterWaiting(tx, SECRET, {
        nodeRunId: 'nrun_wait', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'build.done', path: 'buildId', equals: 'b1' },
        idempotencyKey: 'wait-route-1', maxWaitMs: 60_000, now: NOW,
        clock: TEST_CLOCK,
      })
    })
    const res = await post(base + '/v1/wait/events', {
      runId: 'r1', eventType: 'build.done', payload: { buildId: 'b1' }, idempotencyKey: 'evt-route-1',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.woken).toBe(1)
    const node = orchestra.db.raw.prepare('SELECT status, wait_deadline_at FROM node_runs WHERE node_run_id = ?').get('nrun_wait') as { status: string; wait_deadline_at: string | null }
    expect(node.status).toBe('done')
    expect(node.wait_deadline_at).toBeNull()
  })

  it('运行级取消走生产路由并向子运行传播', async () => {
    const { endpoint: base, orchestra } = await boot()
    withTx(orchestra.db, (tx) => {
      tx.run(
        "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, parent_run_id, parent_node_run_id, status, revision, created_at, updated_at) " +
          "VALUES ('r_child','t1','wf',1,'r1','nrun_1','running',1,?,?)",
        [NOW, NOW],
      )
      tx.run(
        "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) " +
          "VALUES ('nrun_child','r_child','child',1,'agent',1,'started',0,?,?)",
        [NOW, NOW],
      )
    })
    const res = await post(base + '/v1/runs/cancel', { runId: 'r1', cancelResult: 'interrupted', graceMs: 0 })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.cancelledRuns).toContain('r_child')
    expect(body.data.cancelledNodes).toContain('nrun_child')
    const child = orchestra.db.raw.prepare('SELECT cancel_result FROM runs WHERE run_id = ?').get('r_child') as { cancel_result: string | null }
    expect(child.cancel_result).toBe('interrupted')
  })
})

describe('取消运行的对外契约：停止意图与业务结果分开', () => {
  it('cancelRun 返回 terminalStatus 与 outcome，调用方不必再翻事件', async () => {
    const { endpoint, orchestra } = await boot(false)
    // queued 节点的副作用尚未发生：标成 pure 后取消即作废，run 能立即收口
    withTx(orchestra.db, (tx) => {
      tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE node_run_id = 'nrun_1'")
    })
    const cancel = await post(endpoint + '/v1/runs/cancel', {
      runId: 'r1',
      cancelResult: 'interrupted',
      graceMs: 1000,
    })
    expect(cancel.status).toBe(200)
    const body = await cancel.json() as any
    expect(body.data).toMatchObject({
      runStatus: 'cancelled',
      terminalStatus: 'cancelled',
      // 唯一节点被取消后作废，没有失败也没有未核实副作用
      outcome: 'succeeded',
    })
  })
})
