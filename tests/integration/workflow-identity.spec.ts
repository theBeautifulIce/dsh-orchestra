import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowCatalog, definitionHashOf } from '../../src/service/workflows.ts'
import { createRun } from '../../src/service/runs.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
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

  it('工作流身份只收有界标识：首尾空白、控制字符、空串都拒在落库之前', () => {
    const { db } = freshLedger()
    const catalog = new WorkflowCatalog('S2', db)
    for (const bad of [' wf-a', 'wf-a ', 'wf\na', '', ':wf']) {
      expect(() => catalog.load(def(bad, 'a'))).toThrow(/工作流身份不合法/)
    }
    expect(() => catalog.load({ ...def('wf-a', 'a'), workflow_version: '1\n' })).toThrow(/工作流身份不合法/)
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get() as { n: number }).n)).toBe(0)
  })

  it('hydrate 交叉校验行键与快照：行被改成 default 但快照仍是 wf-a 时拒绝', () => {
    const { db } = freshLedger()
    new WorkflowCatalog('S2', db).load(def('wf-a', 'a'))
    db.raw.prepare("UPDATE workflow_versions SET workflow_id = 'default' WHERE workflow_id = 'wf-a'").run()
    const broken = new WorkflowCatalog('S2', db)
    expect(() => broken.hydrate()).toThrow(/行键与快照身份不一致/)
  })

  it('011 升级把旧表单键数据完整归入 default，hydrate 后哈希与内容不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-wf011-'))
    try {
      const db = openDb(join(dir, 'orchestra.db'))
      const steps = loadSteps(defaultMigrationsDir())
      applySteps(db, steps.filter((s) => s.version <= 10))
      const legacy = { workflow_version: '7', nodes: [{ node_id: 'old', type: 'agent' as const }] }
      const hash = definitionHashOf(legacy)
      db.raw.prepare('INSERT INTO workflow_versions (version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?)')
        .run('7', hash, JSON.stringify(legacy), NOW)
      applySteps(db, loadSteps(defaultMigrationsDir()).filter((s) => s.version >= 11))

      const row = db.raw.prepare('SELECT workflow_id, version, content_hash, definition_json FROM workflow_versions').get() as {
        workflow_id: string; version: string; content_hash: string; definition_json: string
      }
      expect(row).toMatchObject({ workflow_id: 'default', version: '7', content_hash: hash })
      expect(JSON.parse(row.definition_json)).toEqual(legacy)

      const catalog = new WorkflowCatalog('S2', db)
      expect(catalog.hydrate()).toBe(1)
      expect(catalog.get('default', '7').nodes[0]!.node_id).toBe('old')
      expect(catalog.definitionHash('default', '7')).toBe(hash)
      db.raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
