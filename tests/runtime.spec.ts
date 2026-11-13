// 生产路径端到端：命令装配 → 租约 → 执行 → 强证据 → 收口（审计 F-01）
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOrchestra } from '../src/index.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { ToolRegistry } from '../src/executor/tools.ts'
import { ReadOnlyToolRunner, type HostRunner } from '../src/executor/tools.ts'
import { runNode } from '../src/executor/run-node.ts'
import type { HostAgentFactory } from '../src/executor/session.ts'

const NOW = '2026-11-13T03:00:00.000Z'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-runtime-'))
  const orchestra = createOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 's3cr3t-runtime', phase: 'S2' })
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','生产路径','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r1','t1','wf',7,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_1','r1','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  orchestra.catalog.load({
    workflow_version: '7',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent' }],
  })
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  }
  const agents: HostAgentFactory = {
    create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }),
  }
  return { dir, orchestra, registry, agents, runner: new ReadOnlyToolRunner(registry, host, dir) }
}

const nodeRow = (db: any) => db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id='nrun_1'").get() as any

describe('生产路径跑通单节点', () => {
  it('queued → dispatched → started → verifying → done，落强证据', async () => {
    const { dir, orchestra, registry, agents, runner } = setup()
    const out = await runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, runner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {}, toolPolicy: { allow: [], deny: [], declaredPolicy: 'pure' },
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
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
    orchestra.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('判定条件不满足：exitCode 不是 0 就不许 done', async () => {
    const { dir, orchestra, registry, agents } = setup()
    const badRunner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }),
    }, dir)
    await expect(runNode(
      { runtime: orchestra.runtime, db: orchestra.db, secret: 's3cr3t-runtime', registry, agents, runner: badRunner },
      {
        nodeRunId: 'nrun_1', nodeId: 'check', attempt: 1, input: {}, outputSchema: {}, toolPolicy: { allow: [], deny: [], declaredPolicy: 'pure' },
        tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
        now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
      },
    )).rejects.toThrowError(/没过判定条件|verdict_unmet/)
    expect(nodeRow(orchestra.db).status).toBe('verifying')
    orchestra.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
