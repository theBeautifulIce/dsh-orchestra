// 控制节点的生产入口：dispatch 不再只认 agent，wait/subworkflow 也走同一条装配命令
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../../src/executor/tools.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'

const SECRET = 'control-dispatch-secret'
const NOW = '2026-11-13T03:00:00.000Z'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

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
  withTx(service.orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','控制节点','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','wf',1,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_w','r1','wait_one',1,'wait',1,'queued',0,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_s','r1','sub_one',2,'subworkflow',1,'queued',0,?,?)", [NOW, NOW])
  })
  service.orchestra.catalog.load({ workflow_id: 'child', workflow_version: '1', nodes: [{ node_id: 'a', type: 'agent' }] })
  return service
}

describe('控制节点的生产派发', () => {
  it('wait 节点经 dispatch 拿租约、进 started，再登记等待并释放租约', async () => {
    const service = await boot()
    try {
      const out = await service.orchestra.commands.dispatch({
        runId: 'r1',
        now: NOW,
        ownerEpoch: service.orchestra.db.epoch,
        leaseTtlMs: 60_000,
        nodes: {
          wait_one: {
            tools: [],
            control: {
              kind: 'wait',
              waitKind: 'event',
              match: { type: 'build.finished' },
              idempotencyKey: 'wait-one',
              maxWaitMs: 60_000,
            },
          },
        },
      })
      expect(out[0]).toMatchObject({ node_run_id: 'nr_w', status: 'waiting', reason: 'wait_registered' })
      const node = service.orchestra.db.raw.prepare('SELECT status, lease_id, wait_started_at FROM node_runs WHERE node_run_id = ?').get('nr_w') as { status: string; lease_id: string | null; wait_started_at: string | null }
      expect(node.status).toBe('waiting')
      expect(node.lease_id).toBeNull()
      expect(node.wait_started_at).toBe(NOW)
      const registration = service.orchestra.db.raw.prepare("SELECT state, idempotency_key FROM wait_registrations WHERE node_run_id = 'nr_w'").get() as { state: string; idempotency_key: string }
      expect(registration).toEqual({ state: 'active', idempotency_key: 'wait-one' })
    } finally {
      await service.release()
    }
  })
})

describe('子流程控制节点', () => {
  it('subworkflow 节点经 dispatch 建子运行并让父节点进 waiting', async () => {
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
          },
        },
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
})