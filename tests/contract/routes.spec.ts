// 生产路由：命令真的接到了服务层（审计 F-01）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { startServer } from '../../src/service/server.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../../src/executor/tools.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { enterWaiting } from '../../src/service/commands/wait.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { getDecisionSnapshot } from '../../src/service/queries/decisions.ts'

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
  const spawnedSessions: string[] = []
  const agents: HostAgentFactory = { create: async () => {
    const sessionId = 'sess_1'
    spawnedSessions.push(sessionId)
    return { agentId: 'agent_1', sessionId }
  } }
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
  return { endpoint: svc.endpoint, orchestra, spawnedSessions }
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

  it('Q-34 节点会话标识不能替代面板凭证，认证主体落到 resolved_by', async () => {
    const { endpoint, orchestra, spawnedSessions } = await boot(true)
    expect((await post(endpoint + '/v1/workflows/load', {
      workflow_version: '1', pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
      nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
    })).status).toBe(200)
    bindRunVersion(orchestra.db, orchestra.catalog, 1, 'r1')
    expect((await post(endpoint + '/v1/node-runs/run', {
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, ownerEpoch: 1, leaseTtlMs: 60000, leaseRenewIntervalMs: 5000,
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
    })).status).toBe(200)
    expect(spawnedSessions).toHaveLength(1)
    const childSession = spawnedSessions[0]!
    withTx(orchestra.db, (tx) => openDecision(tx, {
      decisionId: 'd-panel-only', runId: 'r1', nodeRunId: null, kind: 'pre_execution', approver: 'either',
    }))
    const url = endpoint + '/v1/decisions/resolve'
    const request = { decisionId: 'd-panel-only', revision: 1, resolution: 'approved',
      actor: { kind: 'human', id: childSession } }
    const denied = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestra-secret': String(childSession) },
      body: JSON.stringify(request),
    })
    expect(denied.status).toBe(401)
    expect(getDecisionSnapshot(orchestra.db, request.decisionId).item).toMatchObject({ status: 'pending', current_revision: 1 })
    expect((await post(url, request)).status).toBe(200)
    expect(getDecisionSnapshot(orchestra.db, request.decisionId).item).toMatchObject({ status: 'resolved', resolved_by: /^service:[0-9a-f]{8}$/ })
  })

  it('Q-15 高风险裁决预检、请求绑定、过期、CAS 与回执优先', async () => {
    let now = NOW
    const { endpoint, orchestra } = await boot(false, () => now)
    withTx(orchestra.db, (tx) => {
      openDecision(tx, { decisionId: 'd-confirm', runId: 'r1', nodeRunId: null,
        kind: 'pre_execution', approver: 'human', confirmRequired: true })
      openDecision(tx, { decisionId: 'd-other', runId: 'r1', nodeRunId: null,
        kind: 'rule_ambiguous', approver: 'human' })
    })
    const request = { operation_id: uuidv7(), decisionId: 'd-confirm', revision: 1, resolution: 'approved', payload: { note: 'original' } }
    const submit = (body: Record<string, unknown>) => post(endpoint + '/v1/decisions/resolve', body)
    const failure = async (body: Record<string, unknown>, code: string) => {
      const res = await submit(body)
      expect(res.status).toBe(409)
      const response = await res.json() as { error: { code: string; details: { confirm_challenge?: string } } }
      expect(response.error.code).toBe(code)
      return response.error.details
    }
    const receipt = () => orchestra.db.raw.prepare('SELECT * FROM inbox WHERE operation_id = ?').get(request.operation_id)
    const decision = () => getDecisionSnapshot(orchestra.db, 'd-confirm', Date.parse(now)).item
    const eventCount = () => orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n
    const eventsBefore = eventCount()
    const details = await failure({ ...request, confirm: true }, 'CONFIRMATION_REQUIRED')
    const { confirm_challenge } = await failure(request, 'CONFIRMATION_REQUIRED')
    expect(typeof confirm_challenge).toBe('string')
    expect(details.confirm_challenge).not.toBe(confirm_challenge)
    expect(receipt()).toBeUndefined()
    expect(eventCount()).toBe(eventsBefore)
    expect(decision()).toMatchObject({ status: 'pending', current_revision: 1 })
    expect(decision()).not.toHaveProperty('confirm_challenge')

    const apply = { ...request, confirm_challenge }
    for (const changed of [
      { operation_id: uuidv7() }, { decisionId: 'd-other' }, { resolution: 'rejected' }, { payload: { note: 'changed' } },
      { confirm_challenge: 'tampered' },
    ]) await failure({ ...apply, ...changed }, 'CONFIRMATION_MISMATCH')
    await failure({ ...apply, revision: 2 }, 'DECISION_REVISION_CONFLICT')
    now = new Date(Date.parse(NOW) + 120_000).toISOString()
    await failure(apply, 'CONFIRMATION_EXPIRED')
    expect(receipt()).toBeUndefined()
    expect(eventCount()).toBe(eventsBefore)

    now = NOW
    orchestra.db.raw.prepare("UPDATE decisions SET revision=2 WHERE decision_id='d-confirm'").run()
    await failure(apply, 'DECISION_REVISION_CONFLICT')
    const updated = { ...request, revision: 2 }
    const fresh = await failure(updated, 'CONFIRMATION_REQUIRED')
    const ok = await submit({ ...updated, confirm_challenge: fresh.confirm_challenge })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ data: { decisionId: 'd-confirm', revision: 3, replayed: false } })
    expect(receipt()).toMatchObject({ status: 'applied' })
    const eventsAfter = eventCount()
    now = new Date(Date.parse(NOW) + 120_000).toISOString()
    expect(await (await submit({ ...updated, confirm_challenge: fresh.confirm_challenge })).json())
      .toMatchObject({ data: { decisionId: 'd-confirm', revision: 3, replayed: true } })
    await failure({ ...updated, resolution: 'rejected' }, 'OPERATION_ID_CONFLICT')
    expect(eventCount()).toBe(eventsAfter)
  })

  it('Q-11 受限、过期和无公共命令的裁决投影空选项，命令拒绝该处置', async () => {
    const { endpoint, orchestra } = await boot()
    withTx(orchestra.db, (tx) => {
      for (const [id, kind] of [['a-expired', 'pre_execution'], ['a-review', 'verify_human'], ['a-conflict', 'report_contradicted']] as const) {
        openDecision(tx, { decisionId: id, runId: 'r1', nodeRunId: null, kind,
          approver: 'human', ...(id === 'a-expired' ? { expiresAt: NOW } : {}) })
      }
    })
    for (const decisionId of ['a-expired', 'a-review', 'a-conflict']) {
      expect(getDecisionSnapshot(orchestra.db, decisionId, Date.parse(NOW)).item).toMatchObject({
        allowed_resolutions: [], resolution_unavailable_reason: expect.any(String),
      })
      const res = await post(endpoint + '/v1/decisions/resolve', { decisionId, revision: 1, resolution: 'approved' })
      expect(await res.json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    }
  })

  it.each([
    ['verify_human', 'applied', 'decision'],
    ['action_overrun', 'not_applied', 'verified_none'],
  ] as const)('Q-11 / Q-32 %s 兼容带核验证据的 HTTP 裁决，拒绝缺失或错误作用域', async (kind, verdict, basis) => {
    const { endpoint, orchestra } = await boot()
    const { db } = orchestra
    const hash = 'c'.repeat(64)
    const decisionId = 'effect-decision'
    withTx(db, (tx) => {
      tx.run('UPDATE runs SET workflow_definition_hash = ? WHERE run_id = ?', [hash, 'r1'])
      tx.run("UPDATE node_runs SET status='failed_with_unverified', side_effect_policy='irreversible' WHERE node_run_id='nrun_1'")
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('foreign','r1','other',2,'agent',1,'failed_with_unverified',1,'irreversible',?,?)", [NOW, NOW])
      openDecision(tx, { decisionId, runId: 'r1', nodeRunId: 'nrun_1', kind, approver: 'human', createdAt: NOW })
    })
    async function checkedExecution(nodeRunId: string, nodeId: string) {
      const reference = `r1/${nodeRunId}/1`
      const registry = new ToolRegistry()
      registry.register({ name: 'read-receipt', capability: 'read_only', command: { bin: 'receipt-check', args: [] }, effectVerifier: {
        id: 'receipt/v1', workflowDefinitionHash: hash, nodeId,
        verify: (target, { stdout }) => stdout === `${target.run_id}/${target.node_run_id}/${target.attempt}` ? { verdict, reference: stdout } : null,
      } })
      const runner = new ReadOnlyToolRunner(registry, {
        readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: reference, stderr: '' }),
      }, '.')
      const collector = new EvidenceCollector({ db, secret: SECRET, registry, runner, policy: { allow: ['read-receipt'] },
        allowedTools: ['read-receipt'], nodeRunId, attempt: 1, executorAgentId: 'trusted-verifier', nowAt: () => NOW })
      const result = await collector.collect({ callId: 'read', tool: 'read-receipt', args: [], cwd: '.', timeoutMs: 100 })
      return result.trace!.executionId
    }
    const foreignEvidence = await checkedExecution('foreign', 'other')
    const evidence = await checkedExecution('nrun_1', 'check')
    const command = { operation_id: uuidv7(), decisionId, revision: 1, resolution: 'approved' }
    const submit = (payload?: Record<string, unknown>) => post(endpoint + '/v1/decisions/resolve', { ...command, payload })
    const receipt = () => db.raw.prepare('SELECT * FROM inbox WHERE operation_id=?').get(command.operation_id)
    const settled = () => db.raw.prepare('SELECT resolution_basis, decision_id, stop_evidence FROM unverified_resolutions WHERE node_run_id=?').get('nrun_1')
    expect(getDecisionSnapshot(db, decisionId).item).toMatchObject({ allowed_resolutions: [], resolution_unavailable_reason: expect.stringContaining('系统核验证据') })
    for (const payload of [undefined, { effect_verdict: verdict, evidence_ids: [foreignEvidence] }]) {
      const rejected = await submit(payload)
      expect(rejected.ok).toBe(false)
      expect(await rejected.json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(getDecisionSnapshot(db, decisionId).item).toMatchObject({ status: 'pending', current_revision: 1 })
      expect(settled()).toBeUndefined()
      expect(receipt()).toBeUndefined()
    }
    const payload = { effect_verdict: verdict, evidence_ids: [evidence] }
    expect(await (await submit(payload)).json()).toMatchObject({ data: { decisionId, revision: 2, replayed: false } })
    expect(settled()).toEqual({ resolution_basis: basis, decision_id: verdict === 'applied' ? decisionId : null,
      stop_evidence: verdict === 'not_applied' ? evidence : null })
    expect(getDecisionSnapshot(db, decisionId).item).toMatchObject({ status: 'resolved', current_revision: 2 })
    expect(receipt()).toMatchObject({ status: 'applied' })
    expect(await (await submit(payload)).json()).toMatchObject({ data: { replayed: true } })
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
