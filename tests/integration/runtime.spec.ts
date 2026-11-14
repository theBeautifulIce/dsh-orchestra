// 生产路径端到端：命令装配 → 租约 → 执行 → 强证据 → 收口（审计 F-01）
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openServiceOrchestra } from '../../src/index.ts'
import { definitionHashOf } from '../../src/service/workflows.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { ToolRegistry } from '../../src/executor/tools.ts'
import { ReadOnlyToolRunner, type HostRunner } from '../../src/executor/tools.ts'
import { runNode } from '../../src/executor/run-node.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { sweepNow } from '../../src/service/commands/runtime.ts'
import { fakeAgentClient, type AgentToolStep } from '../fixtures/agent-bridge.ts'

const NOW = '2026-11-13T03:00:00.000Z'

async function setup(steps: AgentToolStep[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-runtime-'))
  const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 's3cr3t-runtime', phase: 'S2' })
  const orchestra = service.orchestra
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','生产路径','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','wf',7,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_1','r1','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  orchestra.catalog.load({
    workflow_version: '7',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo', 'ro.fail', 'ro.ok'], deny: [] } }],
  })
  withTx(orchestra.db, (tx) => tx.run('UPDATE runs SET workflow_definition_hash = ? WHERE run_id = ?', [definitionHashOf(orchestra.catalog.get('7')), 'r1']))
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  registry.register({ name: 'ro.fail', capability: 'read_only', command: { bin: 'fail', args: [] } })
  registry.register({ name: 'ro.ok', capability: 'read_only', command: { bin: 'ok', args: [] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  }
  const agents: HostAgentFactory = {
    create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }),
  }
  const bridge = fakeAgentClient({ agentId: 'agent_1', steps, at: NOW })
  return { dir, orchestra, release: service.release, registry, agents, bridge, runner: new ReadOnlyToolRunner(registry, host, dir) }
}

const nodeRow = (db: any) => db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id='nrun_1'").get() as any

describe('生产路径跑通单节点', () => {
  it('queued → dispatched → started → verifying → done，落强证据', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    const out = await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        // 请求里的 args 只是形状字段，执行与哈希都必须以注册表定义为准（第七轮审计 P2）
        tools: [{ command: 'ro.echo', args: ['ignored'], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    expect(out.final_status).toBe('done')
    expect(out.evidence?.source).toBe('run_tool')
    const row = nodeRow(orchestra.db)
    expect(row.status).toBe('done')
    expect(Number(row.action_generation)).toBe(1)
    const applied = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='report_applied'").get() as { n: number }
    expect(Number(applied.n)).toBe(1)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Agent 只报 done、没有宿主工具证据：不许收口', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup()
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [], now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Agent 请求不在本次节点工具清单里的工具：拒绝执行并阻断', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [], now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('调用方传别的 nodeId 借不到另一份工具授权', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup()
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'other', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(nodeRow(orchestra.db).status).toBe('queued')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('判定条件不满足：exitCode 不是 0 就不许 done', async () => {
    const { dir, orchestra, release, registry, agents, bridge } = await setup([{ tool: 'ro.echo' }])
    const badRunner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }),
    }, dir)
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner: badRunner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toThrowError(/没过判定条件|verdict_unmet/)
    // 审计 P0-2：判定失败必须停在 blocked_post 并留 verify_human 凭据，不许卡在 verifying
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    const human = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='verify_human'").get() as { n: number }
    expect(Number(human.n)).toBeGreaterThan(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('进 verifying 挂判定时钟，收口离开半态后清钟', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    // 进 verifying 时挂 120 秒判定钟（规格 4.4 行 333）
    const ev = orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nrun_1' AND type='status_changed' AND payload LIKE '%\"to\":\"verifying\"%'").get() as { payload: string }
    expect(JSON.parse(ev.payload).verify_deadline_at).toBe('2026-11-13T03:02:00.000Z')
    // 收口离开半态必须清钟（规格 4.4 行 328）
    expect(nodeRow(orchestra.db).verify_deadline_at).toBeNull()
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具起飞前先落 tool_start_at 与 tool_started 事件', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    expect(nodeRow(orchestra.db).tool_start_at).toBe(NOW)
    const started = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='tool_started'").get() as { n: number }
    expect(Number(started.n)).toBe(1)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('长动作：心跳把租约续上，2.5 秒时的扫描不判过期', async () => {
    const { dir, orchestra, release, registry, agents, bridge } = await setup([{ tool: 'ro.echo' }])
    const slowRunner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        return { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    }, dir)
    const running = runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner: slowRunner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 2000, leaseRenewIntervalMs: 500,
      },
    )
    // 动作比租约长：不续租到这里就会过期
    await new Promise((resolve) => setTimeout(resolve, 2500))
    sweepNow(orchestra.runtime, new Date(Date.parse(NOW) + 2500).toISOString())
    expect(nodeRow(orchestra.db).status).toBe('started')
    const expired = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='lease_expired'").get() as { n: number }
    expect(Number(expired.n)).toBe(0)
    const out = await running
    expect(out.final_status).toBe('done')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('多工具：第一份失败即停，不会被后面的成功覆盖', async () => {
    const { dir, orchestra, release, registry, agents, bridge } = await setup([{ tool: 'ro.fail' }, { tool: 'ro.ok' }])
    registry.register({ name: 'ro.fail', capability: 'read_only', command: { bin: 'fail', args: [] } })
    registry.register({ name: 'ro.ok', capability: 'read_only', command: { bin: 'ok', args: [] } })
    let calls = 0
    const runner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async (input) => {
        calls += 1
        return input.bin === 'fail' ? { exitCode: 3, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    }, dir)
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [
          { command: 'ro.fail', args: [], cwd: '.', timeoutMs: 5000 },
          { command: 'ro.ok', args: [], cwd: '.', timeoutMs: 5000 },
        ],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toThrowError(/没过判定条件|verdict_unmet/)
    // 首个失败就该停：第二个成功工具没被执行，证据也不可能被它盖掉
    expect(calls).toBe(1)
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    const human = orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nrun_1' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(human.payload).reason).toContain('tool_execution_failed')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同名工具跑两次：两次都留痕、tool_seq 为 1 与 2、节点不被错误阻塞（第二次意见 P1）', async () => {
    const { dir, orchestra, release, registry, agents, bridge } = await setup([{ tool: 'ro.echo' }, { tool: 'ro.echo' }])
    let calls = 0
    const runner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => {
        calls += 1
        return { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    }, dir)
    const out = await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        // 同一个工具在同一次节点执行里调两次：以前第二次会撞 (node_run_id, attempt, tool) 主键，
        // 异常走工具失败处理，正常重复调用把节点错误阻塞（第二次意见 P1）
        tools: [
          { command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 },
          { command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 },
        ],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    expect(calls).toBe(2)
    expect(out.final_status).toBe('done')
    expect(nodeRow(orchestra.db).status).toBe('done')
    const rows = orchestra.db.raw.prepare("SELECT tool_seq, tool, execution_id FROM tool_executions WHERE node_run_id='nrun_1' AND attempt=1 ORDER BY tool_seq ASC").all() as { tool_seq: number; tool: string; execution_id: string }[]
    expect(rows.length).toBe(2)
    expect(Number(rows[0]!.tool_seq)).toBe(1)
    expect(Number(rows[1]!.tool_seq)).toBe(2)
    expect(rows[0]!.tool).toBe('ro.echo')
    expect(rows[1]!.tool).toBe('ro.echo')
    expect(rows[0]!.execution_id).not.toBe(rows[1]!.execution_id)
    // 事件面：两次执行各留 tool_started / tool_finished，并绑各自的 execution_id
    const events = orchestra.db.raw.prepare("SELECT type, payload FROM node_run_events WHERE node_run_id='nrun_1' AND type IN ('tool_started','tool_finished') ORDER BY seq ASC").all() as { type: string; payload: string }[]
    expect(events.length).toBe(4)
    const started = events.filter((e) => e.type === 'tool_started').map((e) => JSON.parse(e.payload) as { tool_seq: number; execution_id: string })
    const finished = events.filter((e) => e.type === 'tool_finished').map((e) => JSON.parse(e.payload) as { tool_seq: number; execution_id: string })
    expect(started.map((p) => p.tool_seq)).toEqual([1, 2])
    expect(finished.map((p) => p.tool_seq)).toEqual([1, 2])
    expect(started[0]!.execution_id).toBe(rows[0]!.execution_id)
    expect(finished[1]!.execution_id).toBe(rows[1]!.execution_id)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })
})
