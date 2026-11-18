// 流程画布的纯逻辑：九种节点类型、定义读写、连线规则、按拓扑整理。
// 规则与 src/core/workflow-doc.ts 的保存层/发布层对齐：前端不产生服务端会拒的图。
// 这里只 import type（编译期擦除），不会把 zod 打进客户端包。
import type { WorkflowDocNodeType } from '../../core/workflow-doc.ts'

/** 九种节点类型（规格 8.5 行 657 的「九种节点」）。 */
export const CANVAS_NODE_TYPES = [
  'trigger', 'agent', 'tool', 'policy', 'branch', 'approval', 'parallel', 'wait', 'subworkflow',
] as const

type AssertNever<T extends never> = T
/** 清单必须与 core 的九值完全一致：少一个就编译不过。 */
export type AllNodeTypesCovered = AssertNever<Exclude<WorkflowDocNodeType, (typeof CANVAS_NODE_TYPES)[number]>>

/** 节点类型的中文说法：节点条、画布标签、检查提示都用它。 */
export const NODE_TYPE_LABEL: Record<string, string> = {
  trigger: '触发',
  agent: '智能体',
  tool: '工具',
  policy: '策略',
  branch: '分支',
  approval: '审批',
  parallel: '并行',
  wait: '等待',
  subworkflow: '子流程',
}

/** branch / parallel 可以有多条出边，其余节点最多一条。 */
export const MULTI_OUT_TYPES: ReadonlySet<string> = new Set(['branch', 'parallel'])

/** position 的取值范围与 PositionSchema 一致。 */
export const POSITION_MAX = 20000

export type CanvasNode = {
  node_id: string
  type: string
  title: string
  position: { x: number; y: number }
  /** 节点原始字段：config / contract 等原样带回，画布改动不许把契约丢掉。 */
  raw: Record<string, unknown>
}

export type CanvasEdge = {
  from: string
  to: string
  route?: { priority?: number; default?: boolean }
  raw: Record<string, unknown>
}

export type CanvasDoc = {
  name: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** 定义里除 nodes / edges 之外的字段：workflow_id、scope、schema_version 等原样带回。 */
  extra: Record<string, unknown>
}

export function clampCoordinate(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(POSITION_MAX, Math.max(0, Math.round(number)))
}

function readPosition(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { x: 0, y: 0 }
  const raw = value as Record<string, unknown>
  return { x: clampCoordinate(raw.x), y: clampCoordinate(raw.y) }
}

function readRoute(value: unknown): { priority?: number; default?: boolean } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const route: { priority?: number; default?: boolean } = {}
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) route.priority = Math.round(raw.priority)
  if (raw.default === true) route.default = true
  return Object.keys(route).length > 0 ? route : undefined
}

/** 把定义读成画布能画的形状；不是对象就返回 null（画布先不显示）。 */
export function readCanvasDoc(definition: unknown): CanvasDoc | null {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null
  const source = definition as Record<string, unknown>
  const nodes: CanvasNode[] = []
  if (Array.isArray(source.nodes)) {
    for (const item of source.nodes) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const raw = item as Record<string, unknown>
      const nodeId = typeof raw.node_id === 'string' ? raw.node_id : ''
      if (!nodeId) continue
      nodes.push({
        node_id: nodeId,
        type: typeof raw.type === 'string' ? raw.type : 'agent',
        title: typeof raw.title === 'string' ? raw.title : nodeId,
        position: readPosition(raw.position),
        raw,
      })
    }
  }
  const edges: CanvasEdge[] = []
  if (Array.isArray(source.edges)) {
    for (const item of source.edges) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const raw = item as Record<string, unknown>
      const from = typeof raw.from === 'string' ? raw.from : ''
      const to = typeof raw.to === 'string' ? raw.to : ''
      if (!from || !to) continue
      edges.push({ from, to, route: readRoute(raw.route), raw })
    }
  }
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'nodes' || key === 'edges') continue
    extra[key] = value
  }
  return {
    name: typeof source.name === 'string' ? source.name : '',
    nodes,
    edges,
    extra,
  }
}

/** 画布改动写回定义：只换 nodes / edges，其余字段原样带回。 */
export function serializeCanvasDoc(doc: CanvasDoc): Record<string, unknown> {
  return {
    ...doc.extra,
    nodes: doc.nodes.map((node) => ({
      ...node.raw,
      node_id: node.node_id,
      type: node.type,
      title: node.title,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: doc.edges.map((edge) => {
      const next: Record<string, unknown> = { ...edge.raw, from: edge.from, to: edge.to }
      if (edge.route) next.route = { ...edge.route }
      else delete next.route
      return next
    }),
  }
}

/** 新节点的身份：node_id 合 NODE_ID_RE 且唯一，标题说人话。 */
export function nextNodeIdentity(doc: CanvasDoc, type: string): { nodeId: string; title: string } {
  const base = type.replace(/[^a-z0-9_]/g, '') || 'node'
  let index = 1
  while (doc.nodes.some((node) => node.node_id === base + '_' + String(index))) index += 1
  const label = NODE_TYPE_LABEL[type] ?? type
  const serial = doc.nodes.filter((node) => node.type === type).length + 1
  return { nodeId: base + '_' + String(index), title: label + ' ' + String(serial) }
}

/** 连线能不能建：自环、重复边、单出边越界都在前端拦住。 */
export function canConnect(
  doc: CanvasDoc,
  from: string,
  to: string,
): { ok: true } | { ok: false; message: string } {
  if (from === to) return { ok: false, message: '不能连到自己：节点之间不许自环。' }
  if (doc.edges.some((edge) => edge.from === from && edge.to === to)) {
    return { ok: false, message: '这两个节点之间已经有一条连线了。' }
  }
  const source = doc.nodes.find((node) => node.node_id === from)
  if (!source) return { ok: false, message: '找不到起点节点。' }
  if (!doc.nodes.some((node) => node.node_id === to)) return { ok: false, message: '找不到终点节点。' }
  if (!MULTI_OUT_TYPES.has(source.type)) {
    const outCount = doc.edges.filter((edge) => edge.from === from).length
    if (outCount >= 1) {
      return { ok: false, message: source.title + ' 最多只能有一条出边。' }
    }
  }
  return { ok: true }
}

/** branch 的出边必须带 route；画布给新边补一个不重复的 priority，免得定义发不出去。 */
export function routeForNewEdge(doc: CanvasDoc, from: string): { priority?: number; default?: boolean } | undefined {
  const source = doc.nodes.find((node) => node.node_id === from)
  if (!source || source.type !== 'branch') return undefined
  const taken = new Set<number>()
  for (const edge of doc.edges) {
    if (edge.from !== from) continue
    const priority = edge.route?.priority
    if (typeof priority === 'number') taken.add(priority)
  }
  let priority = 0
  while (taken.has(priority)) priority += 1
  return { priority }
}

export type TopologyResult =
  | { ok: true; order: string[]; layer: Map<string, number> }
  | { ok: false; message: string }

/** 拓扑序 + 分层：迭代实现，不递归；图里有环就明确拒绝，不静默乱排。 */
export function topologicalOrder(doc: CanvasDoc): TopologyResult {
  const index = new Map<string, number>()
  doc.nodes.forEach((node, position) => index.set(node.node_id, position))
  const indegree = new Map<string, number>()
  for (const node of doc.nodes) indegree.set(node.node_id, 0)
  const adjacency = new Map<string, string[]>()
  for (const edge of doc.edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  const ready = doc.nodes.map((node) => node.node_id).filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0))
    const current = ready.shift()!
    order.push(current)
    for (const next of adjacency.get(current) ?? []) {
      const rest = (indegree.get(next) ?? 0) - 1
      indegree.set(next, rest)
      if (rest === 0) ready.push(next)
    }
  }
  if (order.length !== doc.nodes.length) {
    return { ok: false, message: '图里有环，没法按拓扑整理：先断开环上的连线再整理。' }
  }
  const layer = new Map<string, number>()
  for (const id of order) {
    let depth = 0
    for (const edge of doc.edges) {
      if (edge.to !== id) continue
      const from = layer.get(edge.from)
      if (from === undefined) continue
      depth = Math.max(depth, from + 1)
    }
    layer.set(id, depth)
  }
  return { ok: true, order, layer }
}

export const ARRANGE_ORIGIN = 40
export const ARRANGE_COLUMN_X = 240
export const ARRANGE_ROW_Y = 140

/** 整理：按拓扑序重新生成 position。有环就拒绝并给提示。 */
export function arrangePositions(
  doc: CanvasDoc,
): { ok: true; nodes: CanvasNode[] } | { ok: false; message: string } {
  const topology = topologicalOrder(doc)
  if (!topology.ok) return { ok: false, message: topology.message }
  const rows = new Map<number, string[]>()
  for (const id of topology.order) {
    const depth = topology.layer.get(id) ?? 0
    const list = rows.get(depth) ?? []
    list.push(id)
    rows.set(depth, list)
  }
  const positions = new Map<string, { x: number; y: number }>()
  for (const [depth, ids] of rows) {
    ids.forEach((id, row) => {
      positions.set(id, {
        x: ARRANGE_ORIGIN + depth * ARRANGE_COLUMN_X,
        y: ARRANGE_ORIGIN + row * ARRANGE_ROW_Y,
      })
    })
  }
  return {
    ok: true,
    nodes: doc.nodes.map((node) => ({
      ...node,
      position: positions.get(node.node_id) ?? node.position,
    })),
  }
}
