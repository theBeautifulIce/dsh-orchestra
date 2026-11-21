// src/core/workflow-doc.ts —— S4 定义文档与两层校验（规格 3.8 / 6.1–6.3，计划 Task 1–3）
//
// 分工写死在类型里：
// - 保存层只拒结构性问题（形状、id、边端点、自环、重复边、长度、体积），其余进 hints 不算阻断；
// - 发布层拒图语义问题（入口、可达、环、出度、branch 路由、子流程 pin）。
// 两层都返回同一种 issue 形状，path 是 RFC 6901 JSON Pointer，最多 100 条。
import { z } from 'zod'
import { OrchError } from './errors.ts'
import { assertApprovalNodeConfig, assertPolicyNodeConfig } from './workflow-def.ts'

export const WORKFLOW_DOC_MAX_BYTES = 1024 * 1024
export const VALIDATION_LIMIT = 100
export const SUBWORKFLOW_DEPTH_MAX = 2

export type ValidationIssue = { path: string; code: string; message: string }
export type ValidationReport = { errors: ValidationIssue[]; truncated: boolean; total: number }

export const WORKFLOW_NODE_TYPES = [
  'trigger', 'agent', 'tool', 'policy', 'branch', 'approval', 'parallel', 'wait', 'subworkflow',
] as const
export type WorkflowDocNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

/** 内建图结构节点：不依赖运行时能力注册，trigger 永远允许 */
export const BUILTIN_GRAPH_TYPES: ReadonlySet<string> = new Set(['trigger'])

/** branch 和 parallel 控制节点必须有后续步骤。 */
const MULTI_OUT_DEGREE: ReadonlySet<WorkflowDocNodeType> = new Set(['branch', 'parallel'])

const NODE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/

const CANVAS_LIMIT = 20000
const PositionSchema = z.object({
  x: z.number().int().min(0).max(CANVAS_LIMIT),
  y: z.number().int().min(0).max(CANVAS_LIMIT),
})

// Model-generated diagrams may use a relative origin. Fit each axis separately,
// preserving spacing whenever the diagram fits without scaling.
export function fitGeneratedWorkflowLayout(draft: unknown): unknown {
  if (byteLength(draft) > WORKFLOW_DOC_MAX_BYTES) return draft
  const layout = z.looseObject({
    nodes: z.array(z.looseObject({
      position: z.object({ x: z.int(), y: z.int() }).optional(),
    })),
  }).safeParse(draft)
  if (!layout.success) return draft
  const { nodes } = layout.data
  const positions = nodes.flatMap(node => node.position ? [node.position] : [])
  if (positions.every(p => PositionSchema.safeParse(p).success)) return draft
  const fitAxis = (axis: 'x' | 'y') => {
    const min = positions.reduce((lowest, p) => Math.min(lowest, p[axis]), Infinity)
    const max = positions.reduce((highest, p) => Math.max(highest, p[axis]), -Infinity)
    const span = max - min
    if (span > CANVAS_LIMIT) return (value: number) => Math.round((value - min) / span * CANVAS_LIMIT)
    const offset = min < 0 ? -min : Math.min(0, CANVAS_LIMIT - max)
    return (value: number) => value + offset
  }
  const fitX = fitAxis('x')
  const fitY = fitAxis('y')
  return { ...layout.data, nodes: nodes.map(node => node.position
    ? { ...node, position: { x: fitX(node.position.x), y: fitY(node.position.y) } }
    : node) }
}

// priority 不在这里卡 0–999：越界属于图语义问题，要作为发布层 issue 返回，
// 不能在解析阶段就把草稿判死（审计 P2-1）
const RouteSchema = z.object({
  priority: z.number().int().optional(),
  default: z.boolean().optional(),
})

const NodeSchema = z.object({
  node_id: z.string(),
  type: z.string(),
  title: z.string(),
  position: PositionSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  // 规格 3.8 的节点契约：先原样保留，S4 不解释它的语义，但不能在保存时丢掉
  contract: z.record(z.string(), z.unknown()).optional(),
})

const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  route: RouteSchema.optional(),
})

export const WorkflowDocSchema = z.object({
  // 文档格式版本：不写就按当前版本处理，写错也不阻断保存，交给发布层提示
  schema_version: z.string().optional(),
  workflow_id: z.string().optional(),
  name: z.string(),
  scope: z.enum(['reusable', 'task_local']).optional(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
})

export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>

const pointer = (base: string, ...parts: Array<string | number>): string =>
  base + parts.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('')

/** 100 条封顶：超出时把总数留在 total 里，别让一张烂图把响应撑爆 */
export function report(issues: ValidationIssue[]): ValidationReport {
  return { errors: issues.slice(0, VALIDATION_LIMIT), truncated: issues.length > VALIDATION_LIMIT, total: issues.length }
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

/**
 * 保存层：结构性问题阻断，图语义问题只作提示。
 * 体积超限按规格抛 413（这是命令层要直接拒的，不进 issue 列表）。
 */
export function validateSaveLayer(
  input: unknown,
  opts: { expectedName?: string } = {},
): { saved: WorkflowDoc | null; report: ValidationReport; hints: ValidationReport } {
  if (byteLength(input) > WORKFLOW_DOC_MAX_BYTES) {
    throw new OrchError('WORKFLOW_DEFINITION_TOO_LARGE', '定义超过 1 MiB，先拆小', {
      limit_bytes: WORKFLOW_DOC_MAX_BYTES,
      actual_bytes: byteLength(input),
    })
  }
  const parsed = WorkflowDocSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: pointer('', ...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))),
      code: 'WORKFLOW_DEFINITION_INVALID',
      message: issue.message,
    }))
    return { saved: null, report: report(issues), hints: report([]) }
  }

  const doc = parsed.data
  const issues: ValidationIssue[] = []
  const hints: ValidationIssue[] = []

  if (doc.name.trim().length === 0 || doc.name.length > 80) {
    issues.push({ path: '/name', code: 'WORKFLOW_NAME_INVALID', message: '流程名必须是 1–80 字' })
  }
  if (opts.expectedName !== undefined && opts.expectedName !== doc.name) {
    issues.push({ path: '/name', code: 'WORKFLOW_NAME_INVALID', message: '请求体 name 与定义里的 name 不一致' })
  }

  const seen = new Set<string>()
  doc.nodes.forEach((node, index) => {
    const at = pointer('/nodes', index)
    if (!NODE_ID_RE.test(node.node_id)) {
      issues.push({ path: pointer(at, 'node_id'), code: 'WORKFLOW_NODE_ID_INVALID', message: 'node_id 必须是 ^[a-z][a-z0-9_]{0,63}$' })
    }
    if (seen.has(node.node_id)) {
      issues.push({ path: pointer(at, 'node_id'), code: 'WORKFLOW_NODE_ID_DUPLICATE', message: '同一版本里 node_id 必须唯一' })
    }
    seen.add(node.node_id)
    if (node.title.length === 0 || node.title.length > 80) {
      issues.push({ path: pointer(at, 'title'), code: 'WORKFLOW_TITLE_INVALID', message: '节点标题必须是 1–80 字' })
    }
  })

  const ids = new Set(doc.nodes.map((n) => n.node_id))
  const edgeSeen = new Set<string>()
  doc.edges.forEach((edge, index) => {
    const at = pointer('/edges', index)
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push({ path: at, code: 'WORKFLOW_EDGE_ENDPOINT_MISSING', message: '边的两端都必须在本版本节点里' })
    }
    if (edge.from === edge.to) {
      issues.push({ path: at, code: 'WORKFLOW_EDGE_SELF_LOOP', message: '边不许自环' })
    }
    const key = edge.from + '->' + edge.to
    if (edgeSeen.has(key)) {
      issues.push({ path: at, code: 'WORKFLOW_EDGE_DUPLICATE', message: '同一对节点之间只能有一条边' })
    }
    edgeSeen.add(key)
  })

  // 图语义只作提示：保存允许「还没连完」的草稿
  for (const issue of validatePublishLayer(doc, { registeredNodeTypes: new Set(WORKFLOW_NODE_TYPES), publishedVersions: () => true })) {
    hints.push(issue)
  }
  return { saved: doc, report: report(issues), hints: report(hints) }
}

export type PublishContext = {
  /** 当前阶段已注册的节点类型（阶段能力表决定，不是定义自报） */
  registeredNodeTypes: ReadonlySet<string>
  /** 目标工作流某个版本是否已发布；子流程 pin 需要它 */
  publishedVersions: (workflowId: string, version: number) => boolean
  /** 取子流程定义用于环与深度检查；取不到就只做 pin 校验 */
  subworkflowOf?: (workflowId: string, version: number) => WorkflowDoc | null
}


/** 节点/边在文档里的真实位置：JSON Pointer 必须指到数组下标，不能拿 node_id 当路径 */
const nodePath = (doc: WorkflowDoc, id: string): string => {
  const index = doc.nodes.findIndex((n) => n.node_id === id)
  return index >= 0 ? pointer('/nodes', index) : '/nodes'
}
const edgePath = (doc: WorkflowDoc, from: string, to: string): string => {
  const index = doc.edges.findIndex((e) => e.from === from && e.to === to)
  return index >= 0 ? pointer('/edges', index) : '/edges'
}

const outDegreeIssues = (doc: WorkflowDoc): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const out = new Map<string, number>()
  for (const edge of doc.edges) out.set(edge.from, (out.get(edge.from) ?? 0) + 1)
  for (const node of doc.nodes) {
    const degree = out.get(node.node_id) ?? 0
    if (node.type === 'trigger') {
      if (degree === 0) {
        issues.push({ path: nodePath(doc, node.node_id), code: 'WORKFLOW_TRIGGER_FANOUT', message: 'trigger 至少要有一条出边' })
      }
      continue
    }
    const multi = MULTI_OUT_DEGREE.has(node.type as WorkflowDocNodeType)
    if (multi && degree < 1) {
      issues.push({ path: nodePath(doc, node.node_id), code: 'WORKFLOW_NODE_FANOUT_INVALID', message: node.type + ' 至少要有一条出边' })
    }
    if (!multi && node.type !== 'agent' && degree > 1) {
      issues.push({ path: nodePath(doc, node.node_id), code: 'WORKFLOW_NODE_FANOUT_INVALID', message: node.type + ' 最多只能有一条出边' })
    }
  }
  return issues
}

const branchIssues = (doc: WorkflowDoc): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  for (const node of doc.nodes) {
    if (node.type !== 'branch') continue
    const edges = doc.edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.from === node.node_id)
    const priorities = new Set<number>()
    let defaults = 0
    for (const { edge, index } of edges) {
      const at = pointer('/edges', index, 'route')
      const route = edge.route
      const hasPriority = route?.priority !== undefined
      const isDefault = route?.default === true
      if (!route) {
        issues.push({ path: at, code: 'WORKFLOW_BRANCH_ROUTE_INVALID', message: 'branch 的每条出边都要带 route' })
        continue
      }
      if (hasPriority && isDefault) {
        issues.push({ path: at, code: 'WORKFLOW_BRANCH_ROUTE_INVALID', message: 'route 只能二选一：priority 或 default=true' })
        continue
      }
      if (!hasPriority && !isDefault) {
        issues.push({ path: at, code: 'WORKFLOW_BRANCH_ROUTE_INVALID', message: 'route 必须给 priority(0–999) 或 default=true' })
        continue
      }
      if (hasPriority) {
        const priority = route!.priority!
        if (priority < 0 || priority > 999) {
          issues.push({ path: at, code: 'WORKFLOW_BRANCH_ROUTE_INVALID', message: 'priority 必须在 0–999' })
          continue
        }
        if (priorities.has(priority)) {
          issues.push({ path: at, code: 'WORKFLOW_BRANCH_PRIORITY_DUPLICATE', message: '同一条 branch 的 priority 不许重复' })
        }
        priorities.add(priority)
        continue
      }
      defaults++
      if (defaults > 1) {
        issues.push({ path: at, code: 'WORKFLOW_BRANCH_DEFAULT_DUPLICATE', message: '同一条 branch 只能有一个默认分支' })
      }
    }
  }
  return issues
}

const reachabilityIssues = (doc: WorkflowDoc): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const trigger = doc.nodes.find((n) => n.type === 'trigger')
  if (!trigger) return issues
  const adjacency = new Map<string, string[]>()
  for (const edge of doc.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  const seen = new Set<string>([trigger.node_id])
  const queue = [trigger.node_id]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  for (const node of doc.nodes) {
    if (!seen.has(node.node_id)) {
      issues.push({ path: nodePath(doc, node.node_id), code: 'WORKFLOW_NODE_UNREACHABLE', message: '从 trigger 出发不可达' })
    }
  }
  return issues
}

/** 环检测用迭代 DFS：图可能很深，递归会把栈吃光 */
const cycleIssues = (doc: WorkflowDoc): ValidationIssue[] => {
  const adjacency = new Map<string, string[]>()
  for (const edge of doc.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  const state = new Map<string, 0 | 1 | 2>()
  const issues: ValidationIssue[] = []
  for (const start of doc.nodes.map((n) => n.node_id)) {
    if (state.get(start) === 2) continue
    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }]
    state.set(start, 1)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const next = adjacency.get(top.id) ?? []
      if (top.index >= next.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const child = next[top.index]!
      top.index++
      const st = state.get(child) ?? 0
      if (st === 1) {
        issues.push({ path: edgePath(doc, top.id, child), code: 'WORKFLOW_GRAPH_CYCLE', message: '图里有环：' + top.id + ' → ' + child })
        continue
      }
      if (st === 0) {
        state.set(child, 1)
        stack.push({ id: child, index: 0 })
      }
    }
  }
  return issues
}

const configIssues = (doc: WorkflowDoc): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  for (const node of doc.nodes) {
    const cfg = (node.config ?? {}) as Record<string, unknown>
    if (node.type === 'policy' || node.type === 'approval') {
      try {
        if (node.type === 'policy') assertPolicyNodeConfig(cfg)
        else assertApprovalNodeConfig(cfg)
      } catch (error) {
        issues.push({ path: pointer(nodePath(doc, node.node_id), 'config'), code: 'WORKFLOW_NODE_CONFIG_INVALID', message: (error as Error).message })
      }
    } else if (node.type === 'wait') {
      const kind = cfg.wait_kind
      const maxWait = cfg.max_wait_ms
      const match = cfg.match as Record<string, unknown> | undefined
      if ((kind !== 'event' && kind !== 'timer') || !match || typeof match.type !== 'string'
        || typeof maxWait !== 'number' || !Number.isInteger(maxWait) || maxWait <= 0) {
        issues.push({ path: pointer(nodePath(doc, node.node_id), 'config'), code: 'WORKFLOW_NODE_CONFIG_INVALID', message: 'wait 节点需要 wait_kind / match.type / 正整数 max_wait_ms' })
      }
    } else if (node.type === 'subworkflow') {
      const target = cfg.workflow_id
      const pinned = cfg.pinned_version
      if (typeof target !== 'string' || target.length === 0 || typeof pinned !== 'number' || !Number.isInteger(pinned) || pinned < 1) {
        issues.push({ path: pointer(nodePath(doc, node.node_id), 'config'), code: 'WORKFLOW_NODE_CONFIG_INVALID', message: 'subworkflow 节点需要 workflow_id 与正整数 pinned_version' })
      }
    }
  }
  return issues
}

const subworkflowIssues = (doc: WorkflowDoc, ctx: PublishContext): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const walk = (current: WorkflowDoc, depth: number, path: string[]): void => {
    for (const [index, node] of current.nodes.entries()) {
      if (node.type !== 'subworkflow') continue
      const cfg = (node.config ?? {}) as Record<string, unknown>
      const target = typeof cfg.workflow_id === 'string' ? cfg.workflow_id : ''
      const pinned = typeof cfg.pinned_version === 'number' ? cfg.pinned_version : 0
      if (!target || pinned < 1) continue
      if (!ctx.publishedVersions(target, pinned)) {
        issues.push({
          path: pointer('/nodes', index, 'config', 'pinned_version'),
          code: 'WORKFLOW_SUBWORKFLOW_VERSION_MISSING',
          message: '子流程 pin 的版本不存在或未发布：' + target + ' v' + String(pinned),
        })
        continue
      }
      if (path.includes(target + '@' + String(pinned))) {
        issues.push({ path: pointer('/nodes', index, 'config'), code: 'SUBWORKFLOW_CYCLE', message: '子流程引用成环：' + [...path, target + '@' + String(pinned)].join(' → ') })
        continue
      }
      // path 是「已经进来的层数」：根为 0，挂到第 3 层才算超限
      if (path.length >= SUBWORKFLOW_DEPTH_MAX) {
        issues.push({
          path: pointer('/nodes', index, 'config'),
          code: 'SUBWORKFLOW_DEPTH_EXCEEDED',
          message: '子流程嵌套超过 max_depth=' + String(SUBWORKFLOW_DEPTH_MAX),
        })
        continue
      }
      const child = ctx.subworkflowOf?.(target, pinned) ?? null
      if (child) walk(child, depth + 1, [...path, target + '@' + String(pinned)])
    }
  }
  walk(doc, 0, [])
  return issues
}

/** 命令层统一用它封顶：保存错误、保存提示、发布错误都走同一个 100 条规则（审计 P2-4） */
export function toReport(issues: ValidationIssue[]): ValidationReport {
  return report(issues)
}

/** 发布层：全部图语义问题一次列全，不阻断保存 */
export function validatePublishLayer(doc: WorkflowDoc, ctx: PublishContext): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const triggers = doc.nodes.filter((n) => n.type === 'trigger')
  if (triggers.length === 0) {
    issues.push({ path: '/nodes', code: 'WORKFLOW_NO_TRIGGER', message: '必须恰好有一个 trigger 节点' })
  } else if (triggers.length > 1) {
    issues.push({ path: '/nodes', code: 'WORKFLOW_MULTIPLE_TRIGGERS', message: '必须恰好有一个 trigger 节点' })
  }
  const triggerIds = new Set(triggers.map((t) => t.node_id))
  for (const edge of doc.edges) {
    if (triggerIds.has(edge.to)) {
      issues.push({ path: edgePath(doc, edge.from, edge.to), code: 'WORKFLOW_TRIGGER_HAS_INBOUND', message: 'trigger 不许有入边' })
    }
  }
  for (const node of doc.nodes) {
    if (BUILTIN_GRAPH_TYPES.has(node.type)) continue
    if (!ctx.registeredNodeTypes.has(node.type)) {
      issues.push({ path: nodePath(doc, node.node_id), code: 'NODE_NOT_SUPPORTED', message: '节点类型未注册：' + node.type })
    }
  }
  issues.push(...outDegreeIssues(doc))
  issues.push(...branchIssues(doc))
  issues.push(...reachabilityIssues(doc))
  issues.push(...cycleIssues(doc))
  issues.push(...configIssues(doc))
  issues.push(...subworkflowIssues(doc, ctx))
  return issues
}
