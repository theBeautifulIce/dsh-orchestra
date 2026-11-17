// S5 固定记忆图的唯一声明源：节点表 + 显式拓扑序 + 装载期 fail-closed 校验。
// 规格 §9.3 固定图：docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md:692-703
// 计划 Task 11 步骤 3：docs/superpowers/plans/2026-11-12-dsh-orchestra-s5-panel-memory.md:1639
// 纯数据 + 纯校验：不接运行时、不碰数据库、不碰 dispatcher；
// 只 import core/errors.ts（OrchError）与 core/memory-graph.ts（端口常量与写工具禁令）。
import { OrchError } from './errors.ts'
import { MEMORY_TOOLS, assertNoMemoryWriteTool } from './memory-graph.ts'

/** 节点种类：规格 §9.3 括注。 */
export type MemoryNodeKind = 'trigger' | 'agent' | 'tool' | 'branch' | 'approval' | 'report'

/** 端口能力：与 src/executor/tools.ts:26-30 的固定表同口径。 */
export type MemoryPortCapability = 'read_only' | 'mutating'

/** 分支路由：route 名字 → 目标节点。 */
export type MemoryRoute = { route: string; to: string }

/** 由节点表派生的一条边（边不再单独声明）。 */
export type MemoryGraphEdge = { from: string; to: string; route?: string }

export type MemoryGraphNode = {
  node_id: string
  kind: MemoryNodeKind
  /** 线性后继：非 branch 节点声明唯一后继；branch 节点改用 routes。 */
  next?: string
  /** tool 节点的端口引用：只能是 MEMORY_TOOLS 的三个常量之一。 */
  port_ref?: string
  /** tool 节点声明的端口能力：必须与固定能力表一致。 */
  port_capability?: MemoryPortCapability
  /** tool 节点声明的不可逆标记：必须与固定能力表一致。 */
  port_irreversible?: boolean
  /** branch 节点的分支路由表。 */
  routes?: readonly MemoryRoute[]
  /** agent 节点的工具 allow 表。 */
  allow?: readonly string[]
  /** approval 节点的审批 kind（mem_confirm = audit_result）。 */
  approval_kind?: string
  /** 终态叶子标记。 */
  terminal: boolean
}

/**
 * 端口固定能力表（src/executor/tools.ts:26-30 的镜像）。
 * 本文件只允许 import core/errors.ts 与 core/memory-graph.ts，故此处留一份副本。
 * 风险：两份副本可能漂移；后续切片应把固定表提到 src/core/memory-graph.ts 统一（本包不动那个文件）。
 */
export const MEMORY_GRAPH_PORT_CAPABILITIES: Readonly<Record<string, { capability: MemoryPortCapability; irreversible: boolean }>> = {
  [MEMORY_TOOLS.evaluate]: { capability: 'read_only', irreversible: false },
  [MEMORY_TOOLS.applyGoverned]: { capability: 'mutating', irreversible: true },
  [MEMORY_TOOLS.inspectBatch]: { capability: 'read_only', irreversible: false },
}

/**
 * 固定记忆图的唯一声明表；数组顺序即显式拓扑序（执行序）：
 * mem_trigger → mem_prepare → mem_check → mem_route → mem_confirm → mem_apply → mem_report，
 * 再接 mem_report_empty 与 mem_report_blocked（mem_route 的 empty / blocked 分支终点）。
 * 该顺序 = 从 trigger 出发、按 route 声明序（ready, empty, blocked）做的 DFS 前序；
 * 不用 src/core/memory-graph.ts 的边表首次出现序（那是声明序，不是拓扑序）。
 */
export const MEMORY_GRAPH_NODES: readonly MemoryGraphNode[] = [
  { node_id: 'mem_trigger', kind: 'trigger', next: 'mem_prepare', terminal: false },
  { node_id: 'mem_prepare', kind: 'agent', allow: ['memory.search', 'memory.get'], next: 'mem_check', terminal: false },
  {
    node_id: 'mem_check',
    kind: 'tool',
    port_ref: MEMORY_TOOLS.evaluate,
    port_capability: 'read_only',
    port_irreversible: false,
    next: 'mem_route',
    terminal: false,
  },
  {
    node_id: 'mem_route',
    kind: 'branch',
    routes: [
      { route: 'ready', to: 'mem_confirm' },
      { route: 'empty', to: 'mem_report_empty' },
      { route: 'blocked', to: 'mem_report_blocked' },
    ],
    terminal: false,
  },
  { node_id: 'mem_confirm', kind: 'approval', approval_kind: 'audit_result', next: 'mem_apply', terminal: false },
  {
    node_id: 'mem_apply',
    kind: 'tool',
    port_ref: MEMORY_TOOLS.applyGoverned,
    port_capability: 'mutating',
    port_irreversible: true,
    next: 'mem_report',
    terminal: false,
  },
  { node_id: 'mem_report', kind: 'report', terminal: true },
  { node_id: 'mem_report_empty', kind: 'report', terminal: true },
  { node_id: 'mem_report_blocked', kind: 'report', terminal: true },
]

/** 显式拓扑序：节点表顺序冻结下来的唯一执行序。 */
const MEMORY_GRAPH_ORDER: readonly string[] = MEMORY_GRAPH_NODES.map((node) => node.node_id)

/** 显式拓扑序（节点 id 数组）。 */
export function memoryGraphOrder(): readonly string[] {
  return MEMORY_GRAPH_ORDER
}

/** 按 node_id 查节点；查不到返回 undefined。 */
export function findMemoryNode(node_id: string): MemoryGraphNode | undefined {
  return MEMORY_GRAPH_NODES.find((node) => node.node_id === node_id)
}

/** 由节点表派生边：branch 节点走 routes，其余节点走 next。 */
export function memoryGraphEdges(nodes: readonly MemoryGraphNode[] = MEMORY_GRAPH_NODES): readonly MemoryGraphEdge[] {
  const edges: MemoryGraphEdge[] = []
  for (const node of nodes) {
    if (node.kind === 'branch') {
      for (const route of node.routes ?? []) edges.push({ from: node.node_id, to: route.to, route: route.route })
      continue
    }
    if (node.next !== undefined) edges.push({ from: node.node_id, to: node.next })
  }
  return edges
}

function assertNodeIds(nodes: readonly MemoryGraphNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.node_id.length === 0) {
      throw new OrchError('WORKFLOW_NODE_ID_INVALID', '记忆图节点 node_id 不能为空', { node_id: node.node_id })
    }
    if (seen.has(node.node_id)) {
      throw new OrchError('WORKFLOW_NODE_ID_DUPLICATE', '记忆图节点 node_id 重复', { node_id: node.node_id })
    }
    seen.add(node.node_id)
  }
}

function assertSingleTrigger(nodes: readonly MemoryGraphNode[]): MemoryGraphNode {
  const triggers = nodes.filter((node) => node.kind === 'trigger')
  if (triggers.length === 0) {
    throw new OrchError('WORKFLOW_NO_TRIGGER', '固定记忆图必须有 trigger 节点', { node_count: nodes.length })
  }
  if (triggers.length > 1) {
    throw new OrchError('WORKFLOW_MULTIPLE_TRIGGERS', '固定记忆图只能有一个 trigger 节点', { trigger_count: triggers.length })
  }
  const trigger = triggers[0]!
  return trigger
}

function assertNodeConfig(node: MemoryGraphNode): void {
  if (node.kind === 'branch') {
    if (node.next !== undefined) {
      throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '分支节点不许声明线性后继', { node_id: node.node_id })
    }
    const routes = node.routes ?? []
    if (routes.length < 2) {
      throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支节点至少要两条 route', { node_id: node.node_id, route_count: routes.length })
    }
    const names = new Set<string>()
    for (const route of routes) {
      if (route.route.length === 0) {
        throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支 route 名不能为空', { node_id: node.node_id })
      }
      if (names.has(route.route)) {
        throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支 route 名重复', { node_id: node.node_id, route: route.route })
      }
      names.add(route.route)
    }
    return
  }
  if (node.routes !== undefined) {
    throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '非分支节点不许声明 routes', { node_id: node.node_id })
  }
  if (node.kind === 'approval') {
    if (!node.approval_kind) {
      throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', 'approval 节点必须声明 approval_kind', { node_id: node.node_id })
    }
    return
  }
  if (node.approval_kind !== undefined) {
    throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '非 approval 节点不许声明 approval_kind', { node_id: node.node_id })
  }
}

function assertPortDeclaration(node: MemoryGraphNode): void {
  if (node.kind !== 'tool') {
    if (node.port_ref !== undefined || node.port_capability !== undefined || node.port_irreversible !== undefined) {
      throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '非 tool 节点不许声明端口', { node_id: node.node_id })
    }
    return
  }
  const ref = node.port_ref
  if (ref === undefined) {
    throw new OrchError('TOOL_NOT_REGISTERED', 'tool 节点没声明端口引用', { node_id: node.node_id })
  }
  const fixed = MEMORY_GRAPH_PORT_CAPABILITIES[ref]
  if (fixed === undefined) {
    throw new OrchError('TOOL_NOT_REGISTERED', '记忆端口不在固定注册表里', { node_id: node.node_id, tool: ref })
  }
  if (node.port_capability === undefined || node.port_irreversible === undefined) {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', 'tool 节点没声明端口能力', {
      node_id: node.node_id,
      tool: ref,
      expected_capability: fixed.capability,
      expected_irreversible: fixed.irreversible,
    })
  }
  if (node.port_capability !== fixed.capability || node.port_irreversible !== fixed.irreversible) {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', '记忆端口能力声明与固定策略不一致', {
      node_id: node.node_id,
      tool: ref,
      expected_capability: fixed.capability,
      expected_irreversible: fixed.irreversible,
      declared_capability: node.port_capability,
      declared_irreversible: node.port_irreversible,
    })
  }
}

function assertAgentAllow(node: MemoryGraphNode): void {
  if (node.kind !== 'agent') {
    if (node.allow !== undefined) {
      throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', '非 agent 节点不许声明 allow', { node_id: node.node_id })
    }
    return
  }
  const allow = node.allow ?? []
  if (allow.length === 0) {
    throw new OrchError('WORKFLOW_NODE_CONFIG_INVALID', 'agent 节点必须声明 allow', { node_id: node.node_id })
  }
  assertNoMemoryWriteTool(allow)
}

function assertEdgeIntegrity(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  const ids = new Set(nodes.map((node) => node.node_id))
  const seen = new Set<string>()
  for (const edge of edges) {
    if (edge.from === edge.to) {
      throw new OrchError('WORKFLOW_EDGE_SELF_LOOP', '记忆图不许自环', { node_id: edge.from })
    }
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) {
      throw new OrchError('WORKFLOW_EDGE_DUPLICATE', '记忆图边重复', { from: edge.from, to: edge.to })
    }
    seen.add(key)
    if (!ids.has(edge.to)) {
      if (edge.route !== undefined) {
        throw new OrchError('WORKFLOW_BRANCH_ROUTE_INVALID', '分支 route 指向不存在的节点', {
          from: edge.from,
          route: edge.route,
          to: edge.to,
        })
      }
      throw new OrchError('WORKFLOW_EDGE_ENDPOINT_MISSING', '记忆图边指向不存在的节点', { from: edge.from, to: edge.to })
    }
  }
}

function findCycle(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): string[] | undefined {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from)
    if (list) list.push(edge.to)
    else adjacency.set(edge.from, [edge.to])
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let cycle: string[] | undefined
  const visit = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'visiting') {
      const start = stack.indexOf(id)
      cycle = [...stack.slice(start), id]
      return true
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) return true
    }
    stack.pop()
    state.set(id, 'done')
    return false
  }
  for (const node of nodes) {
    if (visit(node.node_id)) return cycle
  }
  return undefined
}

function assertTriggerShape(trigger: MemoryGraphNode, edges: readonly MemoryGraphEdge[]): void {
  const inbound = edges.filter((edge) => edge.to === trigger.node_id)
  if (inbound.length > 0) {
    throw new OrchError('WORKFLOW_TRIGGER_HAS_INBOUND', 'trigger 节点不许有入边', {
      node_id: trigger.node_id,
      in_degree: inbound.length,
    })
  }
  const outbound = edges.filter((edge) => edge.from === trigger.node_id)
  if (outbound.length !== 1) {
    throw new OrchError('WORKFLOW_TRIGGER_FANOUT', 'trigger 节点只能有一条出边', {
      node_id: trigger.node_id,
      fanout: outbound.length,
    })
  }
}

/** 入边唯一：规格 §9.3 的三个终态叶子各唯一入边、不合并；本表整体是树。 */
function assertFanIn(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  for (const node of nodes) {
    const inbound = edges.filter((edge) => edge.to === node.node_id)
    if (inbound.length > 1) {
      throw new OrchError('WORKFLOW_NODE_FANOUT_INVALID', '记忆图节点只允许一条入边', {
        node_id: node.node_id,
        in_degree: inbound.length,
      })
    }
  }
}

/** 出边唯一：叶子没有出边，非分支节点恰好一条出边。 */
function assertFanOut(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  for (const node of nodes) {
    const outbound = edges.filter((edge) => edge.from === node.node_id)
    if (node.terminal) {
      if (outbound.length > 0) {
        throw new OrchError('WORKFLOW_NODE_FANOUT_INVALID', '终态叶子不许有出边', {
          node_id: node.node_id,
          fanout: outbound.length,
        })
      }
      continue
    }
    if (node.kind === 'branch') continue
    if (outbound.length !== 1) {
      throw new OrchError('WORKFLOW_NODE_FANOUT_INVALID', '非分支节点必须恰好一条出边', {
        node_id: node.node_id,
        fanout: outbound.length,
      })
    }
  }
}

function assertReachable(trigger: MemoryGraphNode, nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from)
    if (list) list.push(edge.to)
    else adjacency.set(edge.from, [edge.to])
  }
  const reached = new Set<string>()
  const stack: string[] = [trigger.node_id]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const next of adjacency.get(id) ?? []) stack.push(next)
  }
  for (const node of nodes) {
    if (!reached.has(node.node_id)) {
      throw new OrchError('WORKFLOW_NODE_UNREACHABLE', '记忆图节点从 trigger 不可达', { node_id: node.node_id })
    }
  }
}

/** 声明序必须是拓扑序：每条边都从靠前节点指向靠后节点。 */
function assertDeclaredOrderIsTopological(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  const index = new Map<string, number>()
  nodes.forEach((node, i) => index.set(node.node_id, i))
  for (const edge of edges) {
    const from = index.get(edge.from) ?? -1
    const to = index.get(edge.to) ?? -1
    if (from >= to) {
      throw new OrchError('WORKFLOW_NODE_UNREACHABLE', '声明序不是拓扑序：目标节点排在来源之前', {
        from: edge.from,
        to: edge.to,
      })
    }
  }
}

/**
 * 对任意候选声明表做全量 fail-closed 校验；任何违规抛 OrchError（既有错误码，不新增）。
 * 校验顺序固定：node_id → trigger 计数 → 节点配置 → 端口 → allow → 边完整性 → 环 → 入度 → 出度 → 可达 → 拓扑序。
 */
export function assertMemoryGraphTableValid(nodes: readonly MemoryGraphNode[]): void {
  assertNodeIds(nodes)
  const trigger = assertSingleTrigger(nodes)
  for (const node of nodes) {
    assertNodeConfig(node)
    assertPortDeclaration(node)
    assertAgentAllow(node)
  }
  const edges = memoryGraphEdges(nodes)
  assertEdgeIntegrity(nodes, edges)
  const cycle = findCycle(nodes, edges)
  if (cycle) {
    throw new OrchError('WORKFLOW_GRAPH_CYCLE', '记忆图出现环', { cycle })
  }
  assertTriggerShape(trigger, edges)
  assertFanIn(nodes, edges)
  assertFanOut(nodes, edges)
  assertReachable(trigger, nodes, edges)
  assertDeclaredOrderIsTopological(nodes, edges)
}

/** 装载期校验：对固定声明表做全量 fail-closed 校验。 */
export function assertMemoryGraphValid(): void {
  assertMemoryGraphTableValid(MEMORY_GRAPH_NODES)
}

// 装载即校验：能 import 这个模块，就说明固定声明表已经过了 fail-closed 校验。
assertMemoryGraphValid()
