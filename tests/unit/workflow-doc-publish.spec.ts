// 发布层：图语义问题一次列全（S4 计划 Task 3）
import { describe, expect, it } from 'vitest'
import { validatePublishLayer, WORKFLOW_NODE_TYPES, type WorkflowDoc } from '../../src/core/workflow-doc.ts'

const node = (id: string, type = 'agent', config: Record<string, unknown> = {}) => ({
  node_id: id, type, title: id, position: { x: 0, y: 0 }, config,
})
const edge = (from: string, to: string, route?: Record<string, unknown>) => (route ? { from, to, route } : { from, to })

const ctx = (over: Partial<Parameters<typeof validatePublishLayer>[1]> = {}) => ({
  registeredNodeTypes: new Set<string>(WORKFLOW_NODE_TYPES),
  publishedVersions: () => true,
  ...over,
})

const run = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], over = {}) =>
  validatePublishLayer({ name: 'wf', nodes, edges } as WorkflowDoc, ctx(over))
const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code)

describe('发布层图语义校验', () => {
  it('最小合法图：trigger → agent，无 issue', () => {
    expect(run([node('t', 'trigger'), node('a')], [edge('t', 'a')])).toEqual([])
  })

  it('缺 trigger / 多 trigger / trigger 有入边', () => {
    expect(codes(run([node('a'), node('b')], [edge('a', 'b')]))).toContain('WORKFLOW_NO_TRIGGER')
    expect(codes(run([node('t1', 'trigger'), node('t2', 'trigger')], []))).toContain('WORKFLOW_MULTIPLE_TRIGGERS')
    expect(codes(run(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 't')],
    ))).toContain('WORKFLOW_TRIGGER_HAS_INBOUND')
  })

  it('出度纪律：trigger 必须恰好 1 条，普通节点最多 1 条，branch/parallel 至少 1 条', () => {
    expect(codes(run([node('t', 'trigger'), node('a'), node('b')], [edge('t', 'a'), edge('t', 'b')])))
      .toContain('WORKFLOW_TRIGGER_FANOUT')
    expect(codes(run([node('t', 'trigger'), node('a'), node('b'), node('c')], [
      edge('t', 'a'), edge('a', 'b'), edge('a', 'c'),
    ]))).toContain('WORKFLOW_NODE_FANOUT_INVALID')
    expect(codes(run([node('t', 'trigger'), node('p', 'parallel')], [edge('t', 'p')])))
      .toContain('WORKFLOW_NODE_FANOUT_INVALID')
  })

  it('不可达节点与有环各自报对应码', () => {
    expect(codes(run([node('t', 'trigger'), node('a'), node('orphan')], [edge('t', 'a')])))
      .toContain('WORKFLOW_NODE_UNREACHABLE')
    expect(codes(run([node('t', 'trigger'), node('a'), node('b')], [
      edge('t', 'a'), edge('a', 'b'), edge('b', 'a'),
    ]))).toContain('WORKFLOW_GRAPH_CYCLE')
  })

  it('branch：缺 route、priority 重复、多个默认分支', () => {
    expect(codes(run(
      [node('t', 'trigger'), node('b', 'branch'), node('x'), node('y')],
      [edge('t', 'b'), edge('b', 'x'), edge('b', 'y')],
    ))).toContain('WORKFLOW_BRANCH_ROUTE_INVALID')

    expect(codes(run(
      [node('t', 'trigger'), node('b', 'branch'), node('x'), node('y')],
      [edge('t', 'b'), edge('b', 'x', { priority: 1 }), edge('b', 'y', { priority: 1 })],
    ))).toContain('WORKFLOW_BRANCH_PRIORITY_DUPLICATE')

    expect(codes(run(
      [node('t', 'trigger'), node('b', 'branch'), node('x'), node('y')],
      [edge('t', 'b'), edge('b', 'x', { default: true }), edge('b', 'y', { default: true })],
    ))).toContain('WORKFLOW_BRANCH_DEFAULT_DUPLICATE')
  })

  it('节点类型未注册：按 NODE_NOT_SUPPORTED 拒', () => {
    const issues = run([node('t', 'trigger'), node('a', 'approval')], [edge('t', 'a')], {
      registeredNodeTypes: new Set(['trigger', 'agent']),
    })
    expect(codes(issues)).toContain('NODE_NOT_SUPPORTED')
  })

  it('wait / subworkflow 的必填 config', () => {
    expect(codes(run([node('t', 'trigger'), node('w', 'wait', { wait_kind: 'event', max_wait_ms: 0 })], [edge('t', 'w')])))
      .toContain('WORKFLOW_NODE_CONFIG_INVALID')
    expect(codes(run([node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'x' })], [edge('t', 's')])))
      .toContain('WORKFLOW_NODE_CONFIG_INVALID')
  })

  it('子流程 pin 未发布：WORKFLOW_SUBWORKFLOW_VERSION_MISSING', () => {
    const issues = run(
      [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'child', pinned_version: 3 })],
      [edge('t', 's')],
      { publishedVersions: (id: string, v: number) => !(id === 'child' && v === 3) },
    )
    expect(codes(issues)).toContain('WORKFLOW_SUBWORKFLOW_VERSION_MISSING')
  })

  it('子流程成环与超过 max_depth=2', () => {
    const leaf: WorkflowDoc = { name: 'leaf', nodes: [node('t', 'trigger'), node('a')], edges: [edge('t', 'a')] }
    const mid: WorkflowDoc = {
      name: 'mid', nodes: [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'leaf', pinned_version: 1 })],
      edges: [edge('t', 's')],
    }
    const root: WorkflowDoc = {
      name: 'root', nodes: [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'mid', pinned_version: 1 })],
      edges: [edge('t', 's')],
    }
    const depth3: WorkflowDoc = {
      name: 'depth3', nodes: [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'root', pinned_version: 1 })],
      edges: [edge('t', 's')],
    }
    const lookup = (id: string): WorkflowDoc | null => ({ leaf, mid, root, depth3 } as Record<string, WorkflowDoc>)[id] ?? null
    expect(codes(validatePublishLayer(depth3, ctx({ subworkflowOf: lookup })))).toContain('SUBWORKFLOW_DEPTH_EXCEEDED')

    const cyclic: WorkflowDoc = {
      name: 'a', nodes: [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'b', pinned_version: 1 })],
      edges: [edge('t', 's')],
    }
    const cyclicB: WorkflowDoc = {
      name: 'b', nodes: [node('t', 'trigger'), node('s', 'subworkflow', { workflow_id: 'a', pinned_version: 1 })],
      edges: [edge('t', 's')],
    }
    const cyclicLookup = (id: string): WorkflowDoc | null => (id === 'a' ? cyclic : id === 'b' ? cyclicB : null)
    expect(codes(validatePublishLayer(cyclic, ctx({ subworkflowOf: cyclicLookup })))).toContain('SUBWORKFLOW_CYCLE')
  })

  it('issue 的 path 指到具体下标，不是 id', () => {
    const issues = run([node('t', 'trigger'), node('a'), node('b')], [edge('t', 'a'), edge('a', 'b'), edge('a', 'b', {})])
    const fanout = issues.find((i) => i.code === 'WORKFLOW_NODE_FANOUT_INVALID')
    expect(fanout?.path).toBe('/nodes/1')
  })
})
