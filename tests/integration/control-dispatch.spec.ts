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
import { failControlDispatch } from '../../src/service/dispatcher.ts'
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
      // 返回 failed 就必须把库里的 queued 节点一起收成 failed，并留一条可追溯事件
      const node = service.orchestra.db.raw.prepare("SELECT status, lease_id FROM node_runs WHERE node_run_id = 'nr_s'").get() as { status: string; lease_id: string | null }
      expect(node).toEqual({ status: 'failed', lease_id: null })
      const events = service.orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr_s' AND type = 'dispatch.failed'").get() as { n: number }
      expect(events.n).toBe(1)
      // 同一 run 里还有别的 queued 节点（wait_one）时 run 本来就不该收口；
      // 这里只断言被拒的节点已经离开 queued，收口由下一条单节点用例证明。
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

  it('节点已被并发流程接管：失败收口不覆盖新状态，也不重复写事件', async () => {
    const service = await boot()
    try {
      // 并发流程已经把它推进到 waiting（例如另一次派发完成了等待登记）
      withTx(service.orchestra.db, (tx) => {
        tx.run("UPDATE node_runs SET status = 'waiting', revision = revision + 1 WHERE node_run_id = 'nr_s'")
      })
      const settled = failControlDispatch(
        { db: service.orchestra.db, secret: SECRET },
        { now: NOW },
        { node_run_id: 'nr_s', node_id: 'sub_one', attempt: 1 },
        '模拟初始化失败',
        'SERVICE_UNAVAILABLE',
      )
      expect(settled).toBe(false)
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_s'").get() as { status: string }
      expect(node.status).toBe('waiting')
      const events = service.orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr_s' AND type = 'dispatch.failed'").get() as { n: number }
      expect(events.n).toBe(0)
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

describe('单节点 run：被拒的派发不阻塞收口', () => {
  it('只有一个 subworkflow 节点且请求体带 control：节点 failed，run 收口', async () => {
    const service = await boot()
    try {
      withTx(service.orchestra.db, (tx) => {
        tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('r6','t1','wf',1,?,'running',1,?,?)", [definitionHashOf(ROOT_DEF), NOW, NOW])
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr6','r6','sub_one',1,'subworkflow',1,'queued',0,?,?)", [NOW, NOW])
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r6',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { sub_one: { tools: [], control: { kind: 'subworkflow' } } as never },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr6', status: 'failed', error_code: 'PAYLOAD_SCHEMA_INVALID' })
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr6'").get() as { status: string }
      expect(node.status).toBe('failed')
      const run = service.orchestra.db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r6'").get() as { status: string }
      expect(run.status).not.toBe('running')
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

describe('无执行器时控制节点仍可推进（审计 P2-1）', () => {
  it('只有 wait 节点的 run：不装执行器也能派发并登记等待', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-noexec-'))
    dirs.push(dir)
    const def = {
      workflow_id: 'wf_ctl',
      workflow_version: '1',
      nodes: [{
        node_id: 'wait_only',
        type: 'wait' as const,
        wait: { wait_kind: 'event' as const, match: { type: 'build.finished' }, max_wait_ms: 60_000 },
      }],
    }
    const service = await openServiceOrchestra({
      dbFile: join(dir, 'orchestra.db'),
      secret: SECRET,
      phase: 'S3',
    })
    try {
      service.orchestra.catalog.load(def)
      withTx(service.orchestra.db, (tx) => {
        tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t9','无执行器','running',1,?,?)", [NOW, NOW])
        tx.run(
          "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('r9','t9','wf_ctl',1,?,'running',1,?,?)",
          [definitionHashOf(def), NOW, NOW],
        )
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr9','r9','wait_only',1,'wait',1,'queued',0,?,?)", [NOW, NOW])
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r9',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { wait_only: { tools: [] } },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr9', status: 'waiting', reason: 'wait_registered' })
      const registration = service.orchestra.db.raw.prepare("SELECT state FROM wait_registrations WHERE node_run_id = 'nr9'").get() as { state: string }
      expect(registration.state).toBe('active')
    } finally {
      await service.release()
    }
  })

  it('只有 agent 节点的 run：没有执行器时明确拒绝，不留下半截状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-noexec-agent-'))
    dirs.push(dir)
    const service = await openServiceOrchestra({
      dbFile: join(dir, 'orchestra.db'),
      secret: SECRET,
      phase: 'S3',
    })
    try {
      withTx(service.orchestra.db, (tx) => {
        tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t8','无执行器 agent','running',1,?,?)", [NOW, NOW])
        tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r8','t8','running',1,?,?)", [NOW, NOW])
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr8','r8','agent_one',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
      })
      await expect(service.orchestra.commands.dispatch({
        runId: 'r8',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { agent_one: { tools: [] } },
      })).rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' })
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr8'").get() as { status: string }
      expect(node.status).toBe('queued')
    } finally {
      await service.release()
    }
  })
})

describe('控制节点初始化失败必须收干净（审计 P2-2）', () => {
  it('引用的子流程版本未发布：节点落 failed、租约清空、run 能收口', async () => {
    const service = await boot()
    try {
      const broken = {
        workflow_id: 'wf_broken',
        workflow_version: '1',
        nodes: [{
          node_id: 'sub_broken',
          type: 'subworkflow' as const,
          subworkflow: { workflow_id: 'ghost', pinned_version: 1 },
        }],
      }
      service.orchestra.catalog.load(broken)
      withTx(service.orchestra.db, (tx) => {
        tx.run(
          "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('r7','t1','wf_broken',1,?,'running',1,?,?)",
          [definitionHashOf(broken), NOW, NOW],
        )
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr7','r7','sub_broken',1,'subworkflow',1,'queued',0,?,?)", [NOW, NOW])
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r7',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { sub_broken: { tools: [] } },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr7', status: 'failed', error_code: 'WORKFLOW_SUBWORKFLOW_VERSION_MISSING' })
      const node = service.orchestra.db.raw.prepare("SELECT status, lease_id, lease_expires_at FROM node_runs WHERE node_run_id = 'nr7'").get() as { status: string; lease_id: string | null; lease_expires_at: string | null }
      expect(node).toEqual({ status: 'failed', lease_id: null, lease_expires_at: null })
      const run = service.orchestra.db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r7'").get() as { status: string }
      expect(run.status).not.toBe('running')
      const event = service.orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr7' AND type = 'dispatch.failed'").get() as { n: number }
      expect(event.n).toBe(1)
    } finally {
      await service.release()
    }
  })
})

describe('没有执行实现的节点类型必须明确拒绝', () => {
  it('parallel 节点：拒绝派发、节点落 failed，不悄悄走 agent 路径', async () => {
    const service = await boot()
    try {
      withTx(service.orchestra.db, (tx) => {
        tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r5','t1','running',1,?,?)", [NOW, NOW])
        tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr5','r5','p_one',1,'parallel',1,'queued',0,?,?)", [NOW, NOW])
      })
      const out = await service.orchestra.commands.dispatch({
        runId: 'r5',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: { p_one: { tools: [] } },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr5', status: 'failed', error_code: 'SCHEMA_VERSION_UNSUPPORTED' })
      expect(out[0]!.reason).toMatch(/还没有执行实现/)
      const node = service.orchestra.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr5'").get() as { status: string }
      expect(node.status).toBe('failed')
    } finally {
      await service.release()
    }
  })
})
