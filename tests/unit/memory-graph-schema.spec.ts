// S5 固定记忆图声明源（src/core/memory-graph-schema.ts）的 fail-closed 校验测试。
// 钉住：9 节点声明表与显式拓扑序、tool 端口白名单与能力声明、
// 非法声明（环 / 多入边 / 悬空边 / 重复 route / 未知端口 / 能力不符）一律抛既有错误码。
import { describe, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { MEMORY_PORT_CAPABILITIES, MEMORY_TOOLS, MEMORY_WRITE_TOOLS } from '../../src/core/memory-graph.ts'
import {
  MEMORY_GRAPH_NODES,
  MEMORY_GRAPH_PORT_CAPABILITIES,
  assertMemoryGraphTableValid,
  assertMemoryGraphValid,
  findMemoryNode,
  memoryGraphEdges,
  memoryGraphNodeSpecs,
  memoryGraphOrder,
  type MemoryGraphNode,
} from '../../src/core/memory-graph-schema.ts'

const NODE_IDS = [
  'mem_trigger',
  'mem_prepare',
  'mem_check',
  'mem_route',
  'mem_confirm',
  'mem_apply',
  'mem_report',
  'mem_report_empty',
  'mem_report_blocked',
] as const

const LEAF_IDS = ['mem_report', 'mem_report_empty', 'mem_report_blocked'] as const

function errOf(fn: () => unknown): OrchError {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err
    throw err
  }
  throw new Error('本应抛错却通过了')
}

/** 在固定声明表上打一个局部补丁，构造非法候选表（其余不变量保持不变）。 */
function withNodes(overrides: Record<string, Partial<MemoryGraphNode>>): readonly MemoryGraphNode[] {
  return MEMORY_GRAPH_NODES.map((node) => ({ ...node, ...(overrides[node.node_id] ?? {}) }))
}

/** 从 trigger 出发、按声明的 route 序做 DFS 前序：拓扑语义的执行序。 */
function dfsPreOrder(): string[] {
  const out = new Map<string, string[]>()
  for (const edge of memoryGraphEdges()) {
    const list = out.get(edge.from) ?? []
    list.push(edge.to)
    out.set(edge.from, list)
  }
  const order: string[] = []
  const visit = (id: string): void => {
    order.push(id)
    for (const next of out.get(id) ?? []) visit(next)
  }
  visit('mem_trigger')
  return order
}

describe('固定记忆图声明源', () => {
  it('9 个节点齐全，顺序即显式拓扑序', () => {
    expect(MEMORY_GRAPH_NODES).toHaveLength(9)
    expect(MEMORY_GRAPH_NODES.map((node) => node.node_id)).toEqual([...NODE_IDS])
    expect(memoryGraphOrder()).toEqual([...NODE_IDS])
  })

  it('声明序等于从 trigger 出发的 DFS 前序（拓扑语义，不是边表声明序）', () => {
    expect(memoryGraphOrder()).toEqual(dfsPreOrder())
  })

  it('每条边都从拓扑序靠前的节点指向靠后的节点', () => {
    const index = new Map(memoryGraphOrder().map((id, i) => [id, i]))
    for (const edge of memoryGraphEdges()) {
      expect(index.get(edge.from)!).toBeLessThan(index.get(edge.to)!)
    }
  })

  it('装载期校验对固定声明表放行', () => {
    expect(() => assertMemoryGraphValid()).not.toThrow()
  })

  it('tool 节点的端口都在固定三端口里，且能力声明与固定表一致', () => {
    const tools = MEMORY_GRAPH_NODES.filter((node) => node.kind === 'tool')
    expect(tools.map((node) => node.node_id)).toEqual(['mem_check', 'mem_apply'])
    for (const node of tools) {
      expect(Object.values(MEMORY_TOOLS)).toContain(node.port_ref)
      const fixed = MEMORY_GRAPH_PORT_CAPABILITIES[node.port_ref!]
      expect(fixed).toBeDefined()
      expect(node.port_capability).toBe(fixed!.capability)
      expect(node.port_irreversible).toBe(fixed!.irreversible)
    }
    expect(MEMORY_GRAPH_PORT_CAPABILITIES[MEMORY_TOOLS.evaluate]).toEqual({ capability: 'read_only', irreversible: false })
    expect(MEMORY_GRAPH_PORT_CAPABILITIES[MEMORY_TOOLS.applyGoverned]).toEqual({ capability: 'mutating', irreversible: true })
    expect(MEMORY_GRAPH_PORT_CAPABILITIES[MEMORY_TOOLS.inspectBatch]).toEqual({ capability: 'read_only', irreversible: false })
  })

  it('approval 节点只有 mem_confirm，审批 kind 是 audit_result', () => {
    const approvals = MEMORY_GRAPH_NODES.filter((node) => node.kind === 'approval')
    expect(approvals.map((node) => node.node_id)).toEqual(['mem_confirm'])
    expect(approvals[0]!.approval_kind).toBe('audit_result')
  })

  it('三个终态叶子互不相连，各唯一入边、没有出边', () => {
    const edges = memoryGraphEdges()
    for (const leaf of LEAF_IDS) {
      expect(edges.filter((edge) => edge.to === leaf)).toHaveLength(1)
      expect(edges.filter((edge) => edge.from === leaf)).toHaveLength(0)
      expect(findMemoryNode(leaf)!.terminal).toBe(true)
    }
    const leafSet = new Set<string>(LEAF_IDS)
    for (const edge of edges) {
      expect(leafSet.has(edge.from) && leafSet.has(edge.to)).toBe(false)
    }
  })

  it('agent 节点 allow 干净：没有写工具，且 allow 非空', () => {
    const agents = MEMORY_GRAPH_NODES.filter((node) => node.kind === 'agent')
    expect(agents.map((node) => node.node_id)).toEqual(['mem_prepare'])
    expect(agents[0]!.allow).toEqual(['memory.search', 'memory.get'])
    for (const node of agents) {
      expect(node.allow!.length).toBeGreaterThan(0)
      for (const ref of node.allow!) {
        expect(MEMORY_WRITE_TOOLS as readonly string[]).not.toContain(ref)
      }
    }
  })

  it('findMemoryNode 能查到节点，查不到返回 undefined', () => {
    expect(findMemoryNode('mem_route')!.kind).toBe('branch')
    expect(findMemoryNode('mem_nope')).toBeUndefined()
  })
})

describe('固定记忆图 fail-closed 校验', () => {
  it('未知端口 fail closed（TOOL_NOT_REGISTERED）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_check: { port_ref: 'memory_bridge:memory.unknown' } })))
    expect(err).toBeInstanceOf(OrchError)
    expect(err.code).toBe('TOOL_NOT_REGISTERED')
  })

  it('tool 节点没声明端口 fail closed（TOOL_NOT_REGISTERED）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_check: { port_ref: undefined } })))
    expect(err.code).toBe('TOOL_NOT_REGISTERED')
  })

  it('端口能力不符 fail closed（SIDE_EFFECT_UNDECLARED）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_check: { port_capability: 'mutating' } })))
    expect(err.code).toBe('SIDE_EFFECT_UNDECLARED')
    expect(err.details.expected_capability).toBe('read_only')
  })

  it('irreversible 标记不符 fail closed（SIDE_EFFECT_UNDECLARED）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_apply: { port_irreversible: false } })))
    expect(err.code).toBe('SIDE_EFFECT_UNDECLARED')
    expect(err.details.expected_irreversible).toBe(true)
  })

  it('端口能力没声明 fail closed（SIDE_EFFECT_UNDECLARED）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_apply: { port_irreversible: undefined } })))
    expect(err.code).toBe('SIDE_EFFECT_UNDECLARED')
  })

  it('出现环 fail closed（WORKFLOW_GRAPH_CYCLE）', () => {
    const err = errOf(() =>
      assertMemoryGraphTableValid(
        withNodes({
          mem_report: { terminal: false, next: 'mem_report_empty' },
          mem_report_empty: { terminal: false, next: 'mem_report' },
        }),
      ),
    )
    expect(err.code).toBe('WORKFLOW_GRAPH_CYCLE')
    expect(Array.isArray(err.details.cycle)).toBe(true)
  })

  it('节点多入边 fail closed（WORKFLOW_NODE_FANOUT_INVALID）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_check: { next: 'mem_report' } })))
    expect(err.code).toBe('WORKFLOW_NODE_FANOUT_INVALID')
    expect(err.details.node_id).toBe('mem_report')
  })

  it('悬空边 fail closed（WORKFLOW_EDGE_ENDPOINT_MISSING）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_apply: { next: 'mem_missing' } })))
    expect(err.code).toBe('WORKFLOW_EDGE_ENDPOINT_MISSING')
    expect(err.details.to).toBe('mem_missing')
  })

  it('重复 route fail closed（WORKFLOW_BRANCH_ROUTE_INVALID）', () => {
    const err = errOf(() =>
      assertMemoryGraphTableValid(
        withNodes({
          mem_route: {
            routes: [
              { route: 'ready', to: 'mem_confirm' },
              { route: 'ready', to: 'mem_report_empty' },
            ],
          },
        }),
      ),
    )
    expect(err.code).toBe('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(err.details.route).toBe('ready')
  })

  it('route 指向不存在的节点 fail closed（WORKFLOW_BRANCH_ROUTE_INVALID）', () => {
    const err = errOf(() =>
      assertMemoryGraphTableValid(
        withNodes({
          mem_route: {
            routes: [
              { route: 'ready', to: 'mem_confirm' },
              { route: 'empty', to: 'mem_ghost' },
              { route: 'blocked', to: 'mem_report_blocked' },
            ],
          },
        }),
      ),
    )
    expect(err.code).toBe('WORKFLOW_BRANCH_ROUTE_INVALID')
    expect(err.details.to).toBe('mem_ghost')
  })

  it('叶子多出边 fail closed（WORKFLOW_NODE_FANOUT_INVALID）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_report: { next: 'mem_report_empty' } })))
    expect(err.code).toBe('WORKFLOW_NODE_FANOUT_INVALID')
  })

  it('不可达节点 fail closed（WORKFLOW_NODE_UNREACHABLE）', () => {
    const table: readonly MemoryGraphNode[] = [
      { node_id: 'mem_trigger', kind: 'trigger', next: 'mem_report', terminal: false },
      { node_id: 'mem_report', kind: 'report', terminal: true },
      { node_id: 'mem_report_orphan', kind: 'report', terminal: true },
    ]
    const err = errOf(() => assertMemoryGraphTableValid(table))
    expect(err.code).toBe('WORKFLOW_NODE_UNREACHABLE')
    expect(err.details.node_id).toBe('mem_report_orphan')
  })

  it('agent allow 里出现写工具 fail closed（MEMORY_WRITE_TOOL_FORBIDDEN）', () => {
    const err = errOf(() => assertMemoryGraphTableValid(withNodes({ mem_prepare: { allow: ['memory.search', 'memory_write'] } })))
    expect(err.code).toBe('MEMORY_WRITE_TOOL_FORBIDDEN')
  })

  it('node_id 重复 fail closed（WORKFLOW_NODE_ID_DUPLICATE）', () => {
    const err = errOf(() => assertMemoryGraphTableValid([...MEMORY_GRAPH_NODES, MEMORY_GRAPH_NODES[0]!]))
    expect(err.code).toBe('WORKFLOW_NODE_ID_DUPLICATE')
  })

  it('端口能力表只有一份数值：固定图引用的是核心表同一个对象', () => {
    expect(MEMORY_GRAPH_PORT_CAPABILITIES).toBe(MEMORY_PORT_CAPABILITIES)
    expect(MEMORY_GRAPH_PORT_CAPABILITIES[MEMORY_TOOLS.evaluate]?.capability).toBe('read_only')
    expect(MEMORY_GRAPH_PORT_CAPABILITIES[MEMORY_TOOLS.applyGoverned]?.capability).toBe('mutating')
  })

  it('节点规格按显式拓扑序派生，node_type 取节点 kind', () => {
    const specs = memoryGraphNodeSpecs()
    expect(specs.map((spec) => spec.node_id)).toEqual([...memoryGraphOrder()])
    expect(specs.map((spec) => spec.node_type)).toEqual(
      [...memoryGraphOrder()].map((node_id) => findMemoryNode(node_id)?.kind),
    )
    expect([...new Set(specs.map((spec) => spec.node_type))].sort()).toEqual(
      ['agent', 'approval', 'branch', 'report', 'tool', 'trigger'],
    )
  })
})
