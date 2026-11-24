// 生产路径端到端：命令装配 → 租约 → 执行 → 强证据 → 收口（审计 F-01）
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openServiceOrchestra } from '../../src/index.ts'
import { OrchError } from '../../src/core/errors.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { definitionHashOf } from '../../src/service/workflows.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { ToolRegistry } from '../../src/executor/tools.ts'
import { ReadOnlyToolRunner, type HostRunner } from '../../src/executor/tools.ts'
import { runNode } from '../../src/executor/run-node.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import { BridgeClient, bridgeHostAgentFactory, type BridgeTransport } from '../../src/executor/bridge.ts'
import { getNode } from '../../src/service/queries/nodes.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { submitCancel, sweepNow } from '../../src/service/commands/runtime.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createDshExecutor } from '../../src/executor/dsh-host.ts'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { fakeAgentBridge, fakeAgentClient, type AgentToolStep } from '../fixtures/agent-bridge.ts'

const NOW = '2026-11-13T03:00:00.000Z'

async function setup(steps: AgentToolStep[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-runtime-'))
  const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 's3cr3t-runtime', phase: 'S2' })
  const orchestra = service.orchestra
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','生产路径','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','default',7,'running',1,?,?)", [NOW, NOW])
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

// 生产命令装配版：cancel 必须经 commands.cancel 打中正在跑的 runNode，
// 不能只测 runNode 自己的 cancelSignal。
async function setupCommands() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cancel-'))
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  }
  const runner = new ReadOnlyToolRunner(registry, host, dir)
  const agents: HostAgentFactory = {
    create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }),
  }
  const base = fakeAgentBridge({ agentId: 'agent_1', steps: [], at: NOW })
  const bridge = new BridgeClient({
    request: async (method, params) => base.request(method, params),
    listen: async function* (_params, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  })
  const service = await openServiceOrchestra({
    dbFile: join(dir, 'orchestra.db'), secret: 's3cr3t-runtime', phase: 'S2',
    executor: { registry, runner, bridge, agents },
  })
  const orchestra = service.orchestra
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','生产路径','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','default',7,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_1','r1','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  orchestra.catalog.load({
    workflow_version: '7',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
  })
  withTx(orchestra.db, (tx) => tx.run('UPDATE runs SET workflow_definition_hash = ? WHERE run_id = ?', [definitionHashOf(orchestra.catalog.get('7')), 'r1']))
  return { dir, orchestra, release: service.release }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('生产路径跑通单节点', () => {
  it('节点等待慢目录期间可以取消，交还租约与调度位并且不产生子会话停机回执', async () => {
    const { dir, orchestra, release, registry, runner } = await setup()
    const deps = { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime' }
    const controller = new AbortController()
    const loading = Promise.withResolvers<void>()
    const host = createDshExecutor({ context: {} as Context, parentForNode: () => undefined, models: [],
      loadModelCatalog: () => {
        loading.resolve()
        return new Promise(() => {})
      },
      recommend: () => ({ complexity: 'routine', reason: 'fixture' }) })
    const scheduler = createExecutionScheduler({ concurrency: 1, humanSlots: 1 })
    try {
      withTx(orchestra.db, (tx) => tx.run("UPDATE node_runs SET side_effect_policy='pure' WHERE node_run_id='nrun_1'"))
      const bridge = host.bridge
      const task = scheduler.run(() => runNode({ ...deps, registry, runner, bridge,
        agents: { create: async () => { throw new Error('must not spawn') } }, cancelSignal: controller.signal, modelRouting: host.modelRouting,
      }, { nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [], now: NOW, ownerEpoch: 1, leaseTtlMs: 600_000 }))
      const rejected = expect(task).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '节点执行已被取消' })
      await loading.promise
      expect(scheduler.inFlight).toBe(1)
      const next = scheduler.run(() => 'next action')
      expect(scheduler.waiting).toBe(1)
      submitCancel(orchestra.runtime, { nodeRunId: 'nrun_1', attempt: 1, revision: nodeRow(orchestra.db).revision,
        cancelResult: 'interrupted', now: NOW, graceMs: 10_000 })
      controller.abort('cancel:interrupted')
      await rejected
      await expect(next).resolves.toBe('next action')
      expect(nodeRow(orchestra.db)).toMatchObject({ status: 'timeout', lease_id: null, fence_state: null })
      expect(orchestra.db.raw.prepare("SELECT type FROM node_run_events WHERE type IN ('executor.model_selected','executor.agent_stopped')").all()).toEqual([])
    } finally {
      await host.close()
      await scheduler.close()
      await release()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 2_500)

  it.each([
    { mode: '显式复杂度档优先', binding: true, tier: 'deep', model: 'turbo', chosen: 'deep' },
    { mode: '自动分配继承模型默认', binding: false, tier: null, model: 'turbo', chosen: 'turbo' },
    { mode: '无覆盖时由宿主决定', binding: false, tier: null, model: null, chosen: null },
  ] as const)('$mode，固定派发与修订并保存实际请求回执', async ({ binding, tier, model, chosen }) => {
    const { dir, orchestra, release, registry, runner } = await setup()
    try {
      const profile = { ref: 'fixture/same', provider: 'fixture', model: 'same', capacity: 'expert',
        reasoning: { defaultEffort: 'deep', efforts: [{ id: 'deep', name: 'Deep' }, { id: 'turbo', name: 'Turbo' }] } } as const
      const catalog = () => ({ profiles: [profile], unavailable_providers: [] })
      const settings = createModelRoutingSettingsHost(orchestra.db, catalog)
      const mapping = { routine: null, standard: null, complex: binding ? profile.ref : null }
      settings.save({ mapping, operation_id: uuidv7(), expected_revision: 0, reasoning_efforts: { complex: tier },
        model_reasoning_defaults: [{ ref: profile.ref, effort: model }] }, 'operator', NOW)
      const observed = chosen ?? profile.reasoning.defaultEffort
      const transport = fakeAgentBridge({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
      const bridge = new BridgeClient({
        async request<T>(method: string, params: unknown) {
          if (method === 'executor.spawn') {
            expect(params).toMatchObject({ modelRef: profile.ref, reasoningEffort: chosen })
            settings.save({ mapping, operation_id: uuidv7(), expected_revision: 1,
              ...(binding ? { reasoning_efforts: { complex: 'turbo' } } : {}),
              model_reasoning_defaults: [{ ref: profile.ref, effort: 'deep' }] }, 'operator', NOW)
            return { agentId: 'agent_1', sessionId: 'session_deep', effectiveModelRef: profile.ref, effectiveReasoningEffort: chosen } as T
          }
          return transport.request(method, params)
        },
        async *listen(params, signal) {
          for await (const event of transport.listen(params, signal)) {
            yield event.type === 'turn' ? { ...event, payload: { ...(event.payload as object),
              model_use: { model_ref: profile.ref, provider: profile.provider, model: profile.model,
                reasoning_effort: observed, observed_request_headers: 1 } } } : event
          }
        },
      })
      await expect(runNode({ runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, runner, bridge,
        agents: bridgeHostAgentFactory(bridge), modelRouting: {
          profiles: [], catalog, recommend: () => ({ complexity: 'complex', reason: '交叉复核' }),
        },
      }, { nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5_000 }], now: NOW, ownerEpoch: 1, leaseTtlMs: 600_000 }))
        .resolves.toMatchObject({ final_status: 'done' })
      const assignment = getNode(orchestra.db, 'nrun_1').model_assignment
      expect(assignment).toMatchObject({
        model_ref: profile.ref, provider: profile.provider, model: profile.model,
        state: 'confirmed', reasoning_effort: chosen,
        usage: { model: profile.model, provider: profile.provider, reasoning_effort: observed, observed_request_headers: 1 },
      })
      expect(assignment?.settings_revision).toBe(chosen === null ? undefined : 1)
      expect(settings.get().item.model_reasoning_defaults).toEqual([{ ref: profile.ref, effort: 'deep' }])
    } finally {
      await release()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([true, false])('模型仅在宿主回读一致后才发送指令（confirmed=%s）', async (confirmed) => {
    const { dir, orchestra, release, registry, runner } = await setup([{ tool: 'ro.echo' }])
    try {
      const base = fakeAgentBridge({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
      const calls: string[] = []
      const bridge = new BridgeClient({
        request: async (method, params) => {
          calls.push(method)
          if (method === 'executor.spawn') {
            expect(params).toMatchObject({ modelRef: 'approved/reasoner', attempt: 1, inheritHistory: false })
            return { agentId: 'agent_1', sessionId: 'session_model', effectiveModelRef: confirmed ? 'approved/reasoner' : 'default' } as never
          }
          return base.request(method, params)
        },
        listen: (params, signal) => base.listen(params, signal),
      })
      const run = runNode({ runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, runner, bridge,
        agents: bridgeHostAgentFactory(bridge), modelRouting: {
          profiles: [{ ref: 'approved/fast', capacity: 'routine' }, { ref: 'approved/reasoner', capacity: 'complex' }],
          recommend: (context) => {
            expect(context).toMatchObject({ taskId: 't1', runId: 'r1', nodeId: 'check', actionGeneration: 1 })
            return { complexity: 'complex', reason: '需要多步独立复核' }
          },
        },
      }, { nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }], now: NOW, ownerEpoch: 1, leaseTtlMs: 600000 })
      if (confirmed) await expect(run).resolves.toMatchObject({ final_status: 'done' })
      else {
        await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
        expect(nodeRow(orchestra.db).status).toBe('blocked_pre')
        expect(calls).toContain('executor.dispose')
      }
      expect(calls.includes('executor.send')).toBe(confirmed)
      expect(getNode(orchestra.db, 'nrun_1').model_assignment).toMatchObject({ model_ref: 'approved/reasoner',
        state: confirmed ? 'confirmed' : 'rejected', complexity: 'complex' })
    } finally {
      await release()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('commands.cancel 经注册表 abort 正在跑的 runNode，节点落 timing_out', async () => {
    const { dir, orchestra, release } = await setupCommands()
    const running = orchestra.commands.runNode({
      nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
      now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
    })
    await waitFor(() => nodeRow(orchestra.db).status === 'started')
    const row = nodeRow(orchestra.db)
    const out = orchestra.commands.cancel({
      nodeRunId: 'nrun_1', attempt: 1, revision: row.revision,
      cancelResult: 'interrupted', now: NOW, graceMs: 5000,
    })
    expect(out.cancel_result).toBe('interrupted')
    await expect(running).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(nodeRow(orchestra.db).status).toBe('timing_out')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

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

  it('run 绑定的定义哈希被换掉：执行期取工具授权前就拒，不 spawn', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([])
    withTx(orchestra.db, (tx) => tx.run("UPDATE runs SET workflow_definition_hash = ? WHERE run_id = 'r1'", ['f'.repeat(64)]))
    let spawned = false
    const watched: HostAgentFactory = {
      create: async (params) => { spawned = true; return agents.create(params) },
    }
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents: watched, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'WORKFLOW_VERSION_IMMUTABLE' })
    expect(spawned).toBe(false)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn 回包失败：节点落 startup_unknown，不能永远停在 dispatched', async () => {
    const { dir, orchestra, release, registry, bridge, runner } = await setup([])
    const badAgents: HostAgentFactory = {
      create: async () => { throw new Error('spawn response lost') },
    }
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents: badAgents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toThrow('spawn response lost')
    expect(nodeRow(orchestra.db).status).toBe('startup_unknown')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn 明确拒绝：落 blocked_pre，不能冒充启动结果未知', async () => {
    const { dir, orchestra, release, registry, bridge, runner } = await setup([])
    const rejected: HostAgentFactory = {
      create: async () => { throw new OrchError('FORBIDDEN', '宿主拒绝建会话') },
    }
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents: rejected, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(nodeRow(orchestra.db).status).toBe('blocked_pre')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn 回包缺 agentId：协议错误不能算宿主明确拒绝，必须落 startup_unknown', async () => {
    const { dir, orchestra, release, registry, bridge, runner } = await setup([])
    const badAgents: HostAgentFactory = {
      create: async () => { throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'spawn 回包缺 agentId') },
    }
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents: badAgents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
    expect(nodeRow(orchestra.db).status).toBe('startup_unknown')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('外部取消：abort 当前 attempt，节点停在 timing_out，不写 blocked_post', async () => {
    const { dir, orchestra, release, registry, agents, runner } = await setup([])
    const base = fakeAgentBridge({ agentId: 'agent_1', steps: [], at: NOW })
    const bridge = new BridgeClient({
      request: async (method, params) => base.request(method, params),
      listen: async function* (_params, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    const controller = new AbortController()
    const running = runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner, cancelSignal: controller.signal },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    await waitFor(() => nodeRow(orchestra.db).status === 'started')
    const row = nodeRow(orchestra.db)
    submitCancel(orchestra.runtime, {
      nodeRunId: 'nrun_1', attempt: 1, revision: row.revision,
      cancelResult: 'interrupted', now: NOW, graceMs: 5000,
    })
    controller.abort('cancel:interrupted')
    await expect(running).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(nodeRow(orchestra.db).status).toBe('timing_out')
    const blocked = orchestra.db.raw.prepare(
      "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='blocked_post'",
    ).get() as { n: number }
    expect(Number(blocked.n)).toBe(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn 挂住：启动超时必须落 startup_unknown，不能永远停在 dispatched', async () => {
    const { dir, orchestra, release, registry, bridge, runner } = await setup([])
    const hanging: HostAgentFactory = { create: () => new Promise<never>(() => {}) }
    const began = Date.now()
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents: hanging, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000, startupTimeoutMs: 50,
      },
    )).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(Date.now() - began).toBeLessThan(1000)
    expect(nodeRow(orchestra.db).status).toBe('startup_unknown')
    const blocked = orchestra.db.raw.prepare(
      "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='blocked_post'",
    ).get() as { n: number }
    expect(Number(blocked.n)).toBe(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stop 未确认：节点不得先落 done，必须停在 blocked_post', async () => {
    const { dir, orchestra, release, registry, agents, runner } = await setup([{ tool: 'ro.echo' }])
    const base = fakeAgentBridge({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
    const bridge = new BridgeClient({
      request: async (method, params) => {
        if (method === 'executor.whenIdle') return { idle: false, timedOut: true } as never
        if (method === 'executor.state') return { state: 'running', toolCallSeq: 1, hasToolCall: true } as never
        return base.request(method, params)
      },
      listen: (params, signal) => base.listen(params, signal),
    })
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    const applied = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='report_applied'").get() as { n: number }
    expect(Number(applied.n)).toBe(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stop 的 state RPC 挂住：限时落 blocked_post，不能永久占用执行槽', async () => {
    const { dir, orchestra, release, registry, agents, runner } = await setup([{ tool: 'ro.echo' }])
    const base = fakeAgentBridge({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW })
    const bridge = new BridgeClient({
      request: async (method, params) => {
        if (method === 'executor.state') return new Promise<never>(() => {}) as never
        return base.request(method, params)
      },
      listen: (params, signal) => base.listen(params, signal),
    })
    const began = Date.now()
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    expect(Date.now() - began).toBeLessThan(8_000)
    expect(nodeRow(orchestra.db).status).toBe('blocked_post')
    const applied = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='report_applied'").get() as { n: number }
    expect(Number(applied.n)).toBe(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Agent 创建后 started 迁移失败：仍要释放宿主会话', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    const calls: string[] = []
    const originalCreate = agents.create
    agents.create = async (input) => {
      // 在 create 成功和 transition 之间把状态改成 leased，让 started 迁移失败
      withTx(orchestra.db, (tx) => tx.run("UPDATE node_runs SET status='leased' WHERE node_run_id='nrun_1'"))
      return originalCreate(input)
    }
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge: new BridgeClient(transport), runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toBeTruthy()
    expect(calls).toContain('executor.cancel')
    expect(calls).toContain('executor.dispose')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('B06 独立进程：工具副作用已发生、回传前 SIGKILL，恢复时只能人工核实，不能重跑', async () => {
    const { dir, orchestra, release, registry, runner } = await setup([])
    const marker = join(dir, 'tool-ran.txt')
    const child = spawn(process.execPath, [
      '--no-warnings',
      join(process.cwd(), 'tests/fixtures/crash-collector-child.ts'),
      join(dir, 'orchestra.db'), marker, 'nrun_1', 's3cr3t-runtime', dir,
    ], { cwd: process.cwd(), stdio: 'ignore' })
    // exit 监听必须在 kill 之前就挂上：SIGKILL 后 exit 可能在下一行 await 之前发出，
    // 事后挂 once 会永远等不到，表现为随机 5s/30s 超时。
    const exited = once(child, 'exit')
    // 干净克隆首次启动子进程会被杀软/文件缓存拖慢，默认 5s 会抖动；
    // 只放宽等待与用例时限，不改断言语义。
    await waitFor(() => existsSync(marker), 20_000)
    child.kill('SIGKILL')
    await exited
    expect(readFileSync(marker, 'utf8')).toBe('ran')

    const collector = new EvidenceCollector({
      db: orchestra.db, secret: 's3cr3t-runtime', registry, runner,
      policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' },
      allowedTools: ['ro.echo'], nodeRunId: 'nrun_1', attempt: 1, executorAgentId: 'agent_1', nowAt: () => NOW,
    })
    await expect(collector.collect({ callId: 'call_child', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' })
    // 重放没有再次触发宿主工具：副作用只有一次。
    expect(readFileSync(marker, 'utf8')).toBe('ran')
    await release()
    rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('入口已取消：在取租约之前拒绝，不产生 lease_acquired 事件', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([])
    const controller = new AbortController()
    controller.abort('cancel:interrupted')
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner, cancelSignal: controller.signal },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(nodeRow(orchestra.db).status).toBe('queued')
    const leased = orchestra.db.raw.prepare(
      "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='lease_acquired'",
    ).get() as { n: number }
    expect(Number(leased.n)).toBe(0)
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具成功但回传前崩：重放已完成 outbox，恢复 trace/evidence 且不重跑', async () => {
    const { dir, orchestra, release, registry, agents, bridge, runner } = await setup([{ tool: 'ro.echo' }])
    const out = await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, bridge, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )
    expect(out.final_status).toBe('done')
    const collector = new EvidenceCollector({
      db: orchestra.db, secret: 's3cr3t-runtime', registry, runner,
      policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' },
      allowedTools: ['ro.echo'], nodeRunId: 'nrun_1', attempt: 1, executorAgentId: 'agent_1', nowAt: () => NOW,
    })
    const replay = await collector.collect({ callId: 'call_1_1', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 })
    expect(replay.exitCode).toBe(0)
    expect(replay.trace?.tool).toBe('ro.echo')
    expect(replay.evidence?.source).toBe('run_tool')
    expect(collector.traceEntries).toHaveLength(1)
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

  it('结构化阻塞即使已运行工具也不假报完成，保留原因、缺项和下一步', async () => {
    const { dir, orchestra, release, registry, agents, runner } = await setup()
    const completion = { outcome: 'blocked', reason: '无法访问新闻来源',
      next_action: '启用来源会话的检索工具后重试', missing: ['AIHOT 访问工具'] }
    const bridge = fakeAgentClient({ agentId: 'agent_1', steps: [{ tool: 'ro.echo' }], at: NOW,
      report: { status: 'failed', output: { summary: '未检索，当前没有可交付条目。', completion } } })
    try {
      await expect(runNode({ runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime',
        registry, agents, runner, bridge }, {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      })).rejects.toMatchObject({ code: 'VERDICT_POLICY_UNMET' })
      expect(nodeRow(orchestra.db).status).toBe('blocked_post')
      const human = orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nrun_1' AND type='verify_human' ORDER BY seq DESC LIMIT 1").get()!
      expect(JSON.parse(String(human.payload))).toMatchObject({
        reason: '无法访问新闻来源；下一步：启用来源会话的检索工具后重试', missing: ['AIHOT 访问工具'],
      })
      expect(orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='report_applied'").get()).toEqual({ n: 0 })
    } finally { await release(); rmSync(dir, { recursive: true, force: true }) }
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
    const startedAt = nodeRow(orchestra.db).tool_start_at as string
    expect(Number.isFinite(Date.parse(startedAt))).toBe(true)
    // 量化的 NOW 只能当展示锚点；工具起止必须来自真实墙钟，且完成不早于开始。
    expect(startedAt).not.toBe(NOW)
    const started = orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nrun_1' AND type='tool_started'").get() as { n: number }
    expect(Number(started.n)).toBe(1)
    const finished = orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nrun_1' AND type='tool_finished' ORDER BY seq DESC LIMIT 1").get() as { payload: string }
    const finishedPayload = JSON.parse(finished.payload) as { started_at: string; finished_at: string }
    expect(Date.parse(finishedPayload.finished_at)).toBeGreaterThanOrEqual(Date.parse(finishedPayload.started_at))
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

  it('生产维护扫描：桥游标十分钟不动就挂起，恢复后按信号重启', async () => {
    const { dir, orchestra, release } = await setup([])
    orchestra.db.raw.prepare(
      "UPDATE node_runs SET status='started', started_at=?, updated_at=? WHERE node_run_id='nrun_1'",
    ).run('2026-11-13T02:00:00.000Z', '2026-11-13T02:00:00.000Z')
    orchestra.db.raw.prepare(
      'INSERT INTO bridge_stream_cursors (node_run_id, attempt, executor_agent_id, last_persisted_ack_seq, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('nrun_1', 1, 'agent_1', 0, '2026-11-13T02:00:00.000Z')
    const paused = sweepNow(orchestra.runtime, NOW)
    expect(paused.bridge_paused).toContain('nrun_1')
    expect(nodeRow(orchestra.db).status).toBe('paused_bridge_missing')
    orchestra.db.raw.prepare("UPDATE bridge_stream_cursors SET updated_at=? WHERE node_run_id='nrun_1'").run(NOW)
    const restored = sweepNow(orchestra.runtime, NOW)
    expect(restored.bridge_restored).toContain('nrun_1')
    expect(nodeRow(orchestra.db).status).not.toBe('paused_bridge_missing')
    await release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('生产维护扫描：从没建立桥游标的在跑节点按执行器失联收口', async () => {
    const { dir, orchestra, release } = await setup([])
    orchestra.db.raw.prepare(
      "UPDATE node_runs SET status='started', started_at=?, updated_at=? WHERE node_run_id='nrun_1'",
    ).run('2026-11-13T02:00:00.000Z', '2026-11-13T02:00:00.000Z')
    const out = sweepNow(orchestra.runtime, NOW)
    expect(out.executor_orphaned).toContain('nrun_1')
    expect(nodeRow(orchestra.db).status).toBe('orphaned')
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
