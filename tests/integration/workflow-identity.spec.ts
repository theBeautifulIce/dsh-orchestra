import { describe, expect, it } from 'vitest'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { createRun } from '../../src/service/runs.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import type { WorkflowDefinition } from '../../src/core/workflow-def.ts'

const NOW = '2026-11-14T10:00:00.000Z'

function def(id: string, nodeId: string): WorkflowDefinition {
  return {
    workflow_id: id,
    workflow_version: '1',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: nodeId, type: 'agent', tools: { allow: ['ro.echo'] } }],
  }
}

describe('run 绑定 workflow_id + version 复合身份', () => {
  it('两个工作流同版本各建各的 run，定义哈希与 workflow_id 都不串', () => {
    const { db } = freshLedger()
    const catalog = new WorkflowCatalog('S2', db)
    catalog.load(def('wf-a', 'a'))
    catalog.load(def('wf-b', 'b'))

    const a = createRun(db, catalog, { taskTitle: 'A', workflowId: 'wf-a', workflowVersion: '1', now: NOW })
    const b = createRun(db, catalog, { taskTitle: 'B', workflowId: 'wf-b', workflowVersion: '1', now: NOW })
    expect(a.workflow_id).toBe('wf-a')
    expect(b.workflow_id).toBe('wf-b')
    expect(a.nodes[0]!.node_id).toBe('a')
    expect(b.nodes[0]!.node_id).toBe('b')

    const rows = db.raw.prepare('SELECT run_id, workflow_id, workflow_definition_hash FROM runs ORDER BY created_at, run_id').all() as {
      run_id: string; workflow_id: string; workflow_definition_hash: string
    }[]
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.run_id === a.run_id)!.workflow_id).toBe('wf-a')
    expect(rows.find((r) => r.run_id === b.run_id)!.workflow_id).toBe('wf-b')
    expect(rows[0]!.workflow_definition_hash).not.toBe(rows[1]!.workflow_definition_hash)

    // 事件也不能只记版本号：恢复时得知道是哪个工作流
    const events = db.raw.prepare("SELECT payload_redacted AS payload_json FROM events WHERE type = 'run.created' ORDER BY seq ASC").all() as { payload_json: string }[]
    expect(events.map((e) => JSON.parse(e.payload_json).workflow_id)).toEqual(['wf-a', 'wf-b'])
  })

  it('两个工作流同版本时，省略 workflowId 建 run 被拒而不是猜一个', () => {
    const { db } = freshLedger()
    const catalog = new WorkflowCatalog('S2', db)
    catalog.load(def('wf-a', 'a'))
    catalog.load(def('wf-b', 'b'))
    expect(() => createRun(db, catalog, { taskTitle: 'amb', workflowVersion: '1', now: NOW }))
      .toThrowError(/必须带 workflow_id/)
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n)).toBe(0)
  })

  it('旧口径没有 workflow_id 时归 default，仍能建 run', () => {
    const { db } = freshLedger()
    const catalog = new WorkflowCatalog('S2', db)
    catalog.load({ workflow_version: '3', nodes: [{ node_id: 'legacy', type: 'agent' }] })
    const out = createRun(db, catalog, { taskTitle: 'legacy', workflowVersion: '3', now: NOW })
    expect(out.workflow_id).toBe('default')
    const row = db.raw.prepare('SELECT workflow_id FROM runs WHERE run_id = ?').get(out.run_id) as { workflow_id: string }
    expect(row.workflow_id).toBe('default')
  })
})
