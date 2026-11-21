// S4 接入前事项：草稿生命周期字段、scope 归属、trigger 内建、REPLACE 覆盖保护
import { describe, expect, it } from 'vitest'
import { freshLedger } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { validatePublishLayer, validateSaveLayer } from '../../src/core/workflow-doc.ts'

const NOW = '2026-11-16T15:00:00.000Z'
const RUNTIME_TYPES = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])

const node = (id: string, type = 'agent') => ({ node_id: id, type, title: id, position: { x: 0, y: 0 }, config: {} })
const doc = (nodes: ReturnType<typeof node>[], edges: { from: string; to: string; route?: Record<string, unknown> }[]) =>
  ({ name: 'wf', nodes, edges })

describe('草稿生命周期与归属（028）', () => {
  it('workflows 带 scope 与 owner_task_id：默认 reusable，任务专属可登记 owner', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflows (workflow_id, name, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['wf_r', '发布流程', 'human:me', 'human:me', NOW, NOW])
      tx.run('INSERT INTO workflows (workflow_id, name, scope, owner_task_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['wf_t', '一次性调研', 'task_local', 'task_1', 'brain', 'brain', NOW, NOW])
    })
    const rows = db.raw.prepare('SELECT workflow_id, scope, owner_task_id FROM workflows ORDER BY workflow_id').all() as
      { workflow_id: string; scope: string; owner_task_id: string | null }[]
    expect(rows).toEqual([
      { workflow_id: 'wf_r', scope: 'reusable', owner_task_id: null },
      { workflow_id: 'wf_t', scope: 'task_local', owner_task_id: 'task_1' },
    ])
    db.raw.close()
  })

  it('草稿记录基础版本、定义哈希与消费标记', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflows (workflow_id, name, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['wf1', '发布流程', 'human:me', 'human:me', NOW, NOW])
      tx.run('INSERT INTO workflow_drafts (workflow_id, revision, doc_json, updated_by, updated_at, based_on_version, definition_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['wf1', 1, '{"name":"wf"}', 'human:me', NOW, null, 'h1'])
    })
    // 发布后只标记，不删行
    withTx(db, (tx) => tx.run("UPDATE workflow_drafts SET published_version = '1' WHERE workflow_id = 'wf1'"))
    const draft = db.raw.prepare('SELECT revision, published_version, based_on_version, definition_hash FROM workflow_drafts WHERE workflow_id = ?').get('wf1') as
      { revision: number; published_version: string | null; based_on_version: string | null; definition_hash: string }
    expect(draft).toEqual({ revision: 1, published_version: '1', based_on_version: null, definition_hash: 'h1' })
    db.raw.close()
  })

  it('INSERT OR REPLACE 覆盖已发布版本被拒（recursive_triggers 默认关掉也拦得住）', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => {
      tx.run('INSERT INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ['wf1', '1', 'h1', '{"nodes":[]}', NOW])
    })
    expect(() => withTx(db, (tx) => {
      tx.run('INSERT OR REPLACE INTO workflow_versions (workflow_id, version, content_hash, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ['wf1', '1', 'h2', '{"nodes":[]}', NOW])
    })).toThrowError(/不可覆盖/)
    const row = db.raw.prepare('SELECT content_hash FROM workflow_versions WHERE workflow_id = ? AND version = ?').get('wf1', '1') as { content_hash: string }
    expect(row.content_hash).toBe('h1')
    db.raw.close()
  })
})

describe('trigger 是内建图节点（P1-2）', () => {
  it('只注册五种运行时类型时，trigger → agent 仍能通过发布校验', () => {
    const issues = validatePublishLayer(
      doc([node('t', 'trigger'), node('a')], [{ from: 't', to: 'a' }]) as never,
      { registeredNodeTypes: RUNTIME_TYPES, publishedVersions: () => true },
    )
    expect(issues).toEqual([])
  })

  it('运行时没注册的类型仍被拒，且一次列全', () => {
    const issues = validatePublishLayer(
      doc([node('t', 'trigger'), node('b', 'branch'), node('p', 'approval')], [{ from: 't', to: 'b' }]) as never,
      { registeredNodeTypes: RUNTIME_TYPES, publishedVersions: () => true },
    )
    expect(issues.filter((i) => i.code === 'NODE_NOT_SUPPORTED').map((i) => i.path)).toEqual(['/nodes/1', '/nodes/2'])
  })
})

describe('branch 路由细则（P2-1）', () => {
  const branchDoc = (route: Record<string, unknown>) => doc(
    [node('t', 'trigger'), node('b', 'branch'), node('x')],
    [{ from: 't', to: 'b' }, { from: 'b', to: 'x', route }],
  )
  const run = (route: Record<string, unknown>) => validatePublishLayer(
    branchDoc(route) as never,
    { registeredNodeTypes: new Set(['trigger', 'agent', 'branch']), publishedVersions: () => true },
  )

  it('空 route 不合格：必须给 priority 或 default', () => {
    const issue = run({}).find((i) => i.code === 'WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(issue?.path).toBe('/edges/1/route')
  })

  it('priority 超范围与 priority+default 同给都不合格', () => {
    expect(run({ priority: 1000 }).map((i) => i.code)).toContain('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(run({ priority: 1, default: true }).map((i) => i.code)).toContain('WORKFLOW_BRANCH_ROUTE_INVALID')
  })

  it('合法的 priority 或 default 通过', () => {
    expect(run({ priority: 1, when: { path: 'ready', op: 'exists' } })).toEqual([])
    expect(run({ default: true })).toEqual([])
    expect(run({ priority: 1 })).toContainEqual(expect.objectContaining({ path: '/edges/1/route/when', code: 'WORKFLOW_BRANCH_ROUTE_INVALID' }))
  })

  it('priority 超范围不会让保存层整份解析失败，只作提示', () => {
    const out = validateSaveLayer(branchDoc({ priority: 5000 }))
    expect(out.saved).not.toBeNull()
    expect(out.report.errors).toEqual([])
    expect(out.hints.errors.map((i) => i.code)).toContain('WORKFLOW_BRANCH_ROUTE_INVALID')
  })
})

describe('文档字段保留（P2-3）', () => {
  it('schema_version 与节点 contract 保存后不丢', () => {
    const out = validateSaveLayer({
      schema_version: '1',
      name: 'wf',
      nodes: [{ ...node('t', 'trigger'), contract: { outputs: ['x'] } }, node('a')],
      edges: [{ from: 't', to: 'a' }],
    })
    expect(out.report.errors).toEqual([])
    expect(out.saved?.schema_version).toBe('1')
    expect((out.saved?.nodes[0] as { contract?: unknown }).contract).toEqual({ outputs: ['x'] })
  })

  it('scope 随文档保留：task_local 能被后续命令读到', () => {
    const out = validateSaveLayer({ name: 'wf', scope: 'task_local', nodes: [node('t', 'trigger')], edges: [] })
    expect(out.saved?.scope).toBe('task_local')
  })
})
