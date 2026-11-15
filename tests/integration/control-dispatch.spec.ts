// 控制节点的生产入口：dispatch 不再只认 agent，wait/subworkflow 也走同一条装配命令。
// 控制配置只能来自已签名的工作流定义，请求体只能复述节点要跑什么工具（审计 P1-1）。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../../src/executor/tools.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { definitionHashOf } from '../../src/service/workflows.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'

const SECRET = 'control-dispatch-secret'
const NOW = '2026-11-13T03:00:00.000Z'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

const ROOT_DEF = {
  workflow_id: 'wf',
  workflow_version: '1',
  nodes: [
    {
      node_id: 'wait_one',
      type: 'wait' as const,
      wait: { wait_kind: 'event' as const, match: { type: 'build.finished' }, max_wait_ms: 60_000 },
    },
    {
      node_id: 'sub_one',
      type: 'subworkflow' as const,
      subworkflow: { workflow_id: 'child', pinned_version: 1 },
    },
  ],
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-control-'))
  dirs.push(dir)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = { readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }) }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }) }
  const service = await openServiceOrchestra({
    dbFile: join(dir, 'orchestra.db'),
    secret: SECRET,
    phase: 'S3',
    executor: {
      registry,
      agents,
      bridge: fakeAgentClient({ agentId: 'agent_1', steps: [], at: NOW }),
      runner: new ReadOnlyToolRunner(registry, host, dir),
    },
  })
  service.orchestra.catalog.load({ workflow_id: 'child', workflow_version: '1', nodes: [{ node_id: 'a', type: 'agent' }] })
  service.orchestra.catalog.load(ROOT_DEF)
  withTx(service.orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','控制节点','running',1,?,?)", [NOW, NOW])
    tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('r1','t1','wf',1,?,'running',1,?,?)",
      [definitionHashOf(ROOT_DEF), NOW, NOW],
    )
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_w','r1','wait_one',1,'wait',1,'queued',0,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_s','r1','sub_one',2,'subworkflow',1,'queued',0,?,?)", [NOW, NOW])
  })
  return service
}

describe('控制节点的生产派发', () => {
  it('wait 节点按定义里的等待配置登记，幂等键按 run/node/attempt 派生', async () => {
    const service = await boot()
    try {
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { wait_one: { tools: [] } },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr_w', status: 'waiting', reason: 'wait_registered' })
      const node = service.orchestra.db.raw.prepare('SELECT status, lease_id, wait_started_at FROM node_runs WHERE node_run_id = ?').get('nr_w') as { status: string; lease_id: string | null; wait_started_at: string | null }
      expect(node.status).toBe('waiting')
      expect(node.lease_id).toBeNull()
      expect(node.wait_started_at).toBe(NOW)
      const registration = service.orchestra.db.raw.prepare("SELECT state, idempotency_key, wait_kind FROM wait_registrations WHERE node_run_id = 'nr_w'").get() as { state: string; idempotency_key: string; wait_kind: string }
      expect(registration).toEqual({ state: 'active', idempotency_key: 'r1:wait_one:1', wait_kind: 'event' })
    } finally {
      await service.release()
    }
  })

  it('请求体带 control：拒绝派发，不按请求里的目标建子运行', async () => {
    const service = await boot()
    try {
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: {
          sub_one: {
            tools: [],
            control: { kind: 'subworkflow', workflowId: 'child', workflowVersion: '1' },
          } as never,
        },
      })
      expect(out.find((item) => item.node_run_id === 'nr_s')).toMatchObject({ status: 'failed', error_code: 'PAYLOAD_SCHEMA_INVALID' })
      const children = service.orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'r1'").get() as { n: number }
      expect(children.n).toBe(0)
    } finally {
      await service.release()
    }
  })
})

describe('子流程控制节点', () => {
  it('subworkflow 节点按定义里的 pin 版本建子运行并让父节点进 waiting', async () => {
    const service = await boot()
    try {
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { sub_one: { tools: [] } },
      })
      const sub = out.find((item) => item.node_run_id === 'nr_s')!
      expect(sub).toMatchObject({ node_run_id: 'nr_s', status: 'waiting' })
      expect(sub.reason).toMatch(/^child_run:/)
      const parent = service.orchestra.db.raw.prepare("SELECT status, lease_id FROM node_runs WHERE node_run_id = 'nr_s'").get() as { status: string; lease_id: string | null }
      expect(parent).toEqual({ status: 'waiting', lease_id: null })
      const child = service.orchestra.db.raw.prepare("SELECT parent_node_run_id, workflow_id, workflow_version, status FROM runs WHERE parent_node_run_id = 'nr_s'").get() as { parent_node_run_id: string; workflow_id: string; workflow_version: number; status: string }
      expect(child).toMatchObject({ parent_node_run_id: 'nr_s', workflow_id: 'child', workflow_version: 1, status: 'running' })
    } finally {
      await service.release()
    }
  })

  it('run 绑定的定义哈希与目录不一致：控制节点不派发', async () => {
    const service = await boot()
    try {
      withTx(service.orchestra.db, (tx) => {
        tx.run("UPDATE runs SET workflow_definition_hash = ? WHERE run_id = 'r1'", ['0'.repeat(64)])
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { wait_one: { tools: [] } },
      })
      expect(out[0]).toMatchObject({ status: 'failed', error_code: 'WORKFLOW_VERSION_IMMUTABLE' })
      // 确定性错误不能把节点留在 queued：否则 run 永远等一个不会执行的节点
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_w'").get() as { status: string }
      expect(node.status).toBe('failed')
    } finally {
      await service.release()
    }
  })
})

describe('控制节点类型边界', () => {
  it('数据库 node_type 与已签名定义不一致：拒绝派发，不改状态', async () => {
    const service = await boot()
    try {
      // 把 wait 节点的库内类型改成 agent：请求不能凭 node_type 把它变成 agent 节点
      withTx(service.orchestra.db, (tx) => {
        tx.run("UPDATE node_runs SET node_type = 'agent' WHERE node_run_id = 'nr_w'")
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { wait_one: { tools: [] } },
      })
      const row = out.find((item) => item.node_run_id === 'nr_w')!
      expect(row).toMatchObject({ status: 'failed', error_code: 'SCHEMA_VERSION_UNSUPPORTED' })
      // 被改过类型的节点不许按 wait 登记，也不许被当成 agent 跑
      const registrations = service.orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM wait_registrations WHERE node_run_id = 'nr_w'").get() as { n: number }
      expect(registrations.n).toBe(0)
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_w'").get() as { status: string }
      expect(node.status).toBe('failed')
    } finally {
      await service.release()
    }
  })
})

describe('控制节点不接受执行器上报', () => {
  it('waiting 的 wait 节点收到 done 报告：拒绝，不借普通出口改写控制状态', async () => {
    const service = await boot()
    try {
      await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { wait_one: { tools: [] } },
      })
      const out = service.orchestra.commands.report({
        nodeRunId: 'nr_w',
        attempt: 1,
        expectedStatus: 'waiting',
        generation: 1,
        now: NOW,
        report: {
          report_id: 'rpt_control_1',
          node_run_id: 'nr_w',
          attempt: 1,
          status: 'failed',
          evidence: { source: 'executor', exitCode: 0 },
        },
      } as never)
      expect(out).toMatchObject({ accepted: false, reason: 'control_node_report_not_allowed' })
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_w'").get() as { status: string }
      expect(node.status).toBe('waiting')
    } finally {
      await service.release()
    }
  })
})
