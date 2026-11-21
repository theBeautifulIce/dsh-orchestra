// src/core/workflow-def.ts —— 定义校验与阶段兼容（规格 2.4 行 122、11.1 行 930-937）
import { OrchError } from './errors.ts'
import { PHASE_CAPABILITIES, type Phase } from './config.ts'
import { assertNoMemoryWriteTool } from './memory-graph.ts'
import { RELEASE_CHECK_WORKFLOW_ID } from './release-workflow-ids.ts'
import { validateBranchEdges, validatePolicy, type BranchEdge, type PassCondition, type PolicyCondition } from './policy.ts'

export type NodeType = 'agent' | 'parallel' | 'subworkflow' | 'decision' | 'wait' | 'policy' | 'approval' | 'branch' | 'tool'

export type PolicyNodeConfig = { condition: PolicyCondition; rule_id?: string }
export type ApprovalNodeConfig = { prompt: string; on_timeout: 'fail' }
export type ToolNodeConfig = { command: string; cwd: string; timeout_ms: number }
export type ParallelNodeConfig = { join: 'all' | 'any' | 'quorum'; quorum?: number; allow_irreversible_children?: boolean; timeout_ms?: number }

export function isDispatcherWorkflowNode(type: string): boolean {
  return type === 'policy' || type === 'approval' || type === 'branch' || type === 'tool' || type === 'parallel'
}

export function isControlWorkflowNode(type: string): boolean {
  return type === 'wait' || type === 'subworkflow' || isDispatcherWorkflowNode(type)
}

export function assertPolicyNodeConfig(config: unknown): asserts config is PolicyNodeConfig {
  const cfg = config as Partial<PolicyNodeConfig> | undefined
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Object.hasOwn(cfg, 'condition')
      || (cfg.rule_id !== undefined && (typeof cfg.rule_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(cfg.rule_id)))) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'policy 节点需要 condition，rule_id 必须是有效标识')
  }
  validatePolicy(cfg.condition as PolicyCondition)
}

export function assertApprovalNodeConfig(config: unknown): asserts config is ApprovalNodeConfig {
  const cfg = config as Partial<ApprovalNodeConfig> | undefined
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.prompt !== 'string'
      || !cfg.prompt.trim() || cfg.prompt.length > 800 || cfg.on_timeout !== 'fail') {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'approval 节点需要有效的 prompt 与 on_timeout=fail')
  }
}

export function assertToolNodeConfig(config: unknown): asserts config is ToolNodeConfig {
  const cfg = config as Partial<ToolNodeConfig> | undefined
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)
      || typeof cfg.command !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(cfg.command)
      || typeof cfg.cwd !== 'string' || !cfg.cwd.length || cfg.cwd.length > 240
      || /[\x00-\x1f:]|^[\\/]/.test(cfg.cwd) || cfg.cwd.split(/[\\/]/).includes('..')
      || typeof cfg.timeout_ms !== 'number' || !Number.isInteger(cfg.timeout_ms) || cfg.timeout_ms < 1 || cfg.timeout_ms > 120_000
      || Object.hasOwn(cfg, 'args')) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'tool 节点需要注册命令、相对工作区目录和毫秒超时，参数由注册表固定')
  }
  assertNoMemoryWriteTool([cfg.command])
  if (cfg.command === RELEASE_CHECK_WORKFLOW_ID) throw new OrchError('FORBIDDEN', '发布检查只能由专用发布入口调用')
}

export function assertParallelNodeConfig(config: unknown, members: number): asserts config is ParallelNodeConfig {
  const cfg = config as Partial<ParallelNodeConfig> | undefined
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !['all', 'any', 'quorum'].includes(cfg.join ?? '')
      || (cfg.join === 'quorum' ? typeof cfg.quorum !== 'number' || !Number.isInteger(cfg.quorum) || cfg.quorum < 1 || cfg.quorum > members : cfg.quorum !== undefined)
      || (cfg.allow_irreversible_children !== undefined && typeof cfg.allow_irreversible_children !== 'boolean')
      || (cfg.timeout_ms !== undefined && (!Number.isInteger(cfg.timeout_ms) || cfg.timeout_ms < 1 || cfg.timeout_ms > 604_800_000))) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'parallel 需要 all、any 或 quorum 汇合，quorum 必须在成员数内')
  }
}

// 子流程嵌套深度上限：根为 0，能挂两层子流程
export const SUBWORKFLOW_MAX_DEPTH = 2

// 等待节点的执行配置：属于已签名定义的一部分，派发请求不能覆盖。
// wait_kind / match / max_wait_ms 决定这个节点等什么、等多久（规格 5.8 行 507-513）。
export type WaitNodeConfig = {
  wait_kind: 'event' | 'timer'
  match: { type: string; path?: string; equals?: unknown }
  max_wait_ms: number
  from_seq?: number
}

// 子流程节点的执行配置：目标工作流与版本同样在定义里固定，派发时不许换目标。
export type SubworkflowNodeConfig = {
  workflow_id: string
  pinned_version: number
  resume_from?: string | null
}

export type WorkflowNodeDef = {
  node_id: string
  type: NodeType
  side_effect_policy?: 'pure' | 'compensable' | 'irreversible'
  tools?: { allow?: string[]; deny?: string[] }
  verifier?: { toolPolicy?: { allow?: string[]; deny?: string[] } }
  // 节点自带的通过条件；和模板条件取 AND（规格 6.1 行 837）
  pass_conditions?: PassCondition[]
  // 节点要求的必留哈希；和模板要求取并集（规格 4.7 行 380）
  required_hashes?: string[]
  // 控制节点配置：只有 wait / subworkflow 节点能有，其余类型带上就是定义错误
  wait?: WaitNodeConfig
  subworkflow?: SubworkflowNodeConfig
  policy?: PolicyNodeConfig
  approval?: ApprovalNodeConfig
  tool?: ToolNodeConfig
  parallel?: ParallelNodeConfig
}

export type WorkflowDefinition = {
  // 工作流命名空间；省略即 default（旧定义与旧 run 的兼容口径）
  workflow_id?: string
  workflow_version: string
  // 模板级通过条件，作为基线（规格 6.1 行 838）
  pass_conditions?: PassCondition[]
  // 模板级必留哈希；不可逆节点的通过凭据（规格 4.7 行 380）
  required_hashes?: string[]
  verifier?: WorkflowNodeDef['verifier']
  nodes: WorkflowNodeDef[]
  // 执行拓扑：B 必须等 A 时给一条 a→b。没有边 = 全部可并行（旧定义兼容）。
  edges?: WorkflowEdge[]
}

export type WorkflowEdge = { from: string; to: string; route?: Omit<BranchEdge, 'to'> }

export function branchEdgesOf(def: WorkflowDefinition, nodeId: string): BranchEdge[] {
  return (def.edges ?? []).filter(edge => edge.from === nodeId).map(edge => ({ ...edge.route, to: edge.to }))
}

export function parallelMemberIds(edges: readonly WorkflowEdge[], nodeId: string): string[] {
  return edges.filter(edge => edge.from === nodeId).map(edge => edge.to)
}

export function assertParallelTopology(edges: readonly WorkflowEdge[], nodeId: string, config: ParallelNodeConfig): void {
  const members = parallelMemberIds(edges, nodeId)
  const memberIds = new Set(members)
  if (!members.length || memberIds.size !== members.length || edges.some(edge => memberIds.has(edge.to) && edge.from !== nodeId)) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'parallel 的直接成员必须归属同一并行组，且不能同时有其他前置')
  }
  if (config.join !== 'all') {
    const continuation = edges.filter(edge => memberIds.has(edge.from))
    const targets = new Set(continuation.map(edge => edge.to))
    if (targets.size > 1 || (targets.size === 1 && continuation.length !== members.length)) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'any 和 quorum 并行组的成员需要连接到同一汇合节点，或都作为末端')
    }
  }
}

// 节点类型对应的能力名
export const NODE_CAPABILITY: Record<NodeType, string> = {
  agent: 'agent_node',
  parallel: 'parallel',
  subworkflow: 'subworkflow',
  decision: 'decision',
  wait: 'wait',
  policy: 'all_nodes',
  approval: 'approval',
  branch: 'all_nodes',
  tool: 'all_nodes',
}

export function isKnownNodeType(type: string): type is NodeType {
  return Object.prototype.hasOwnProperty.call(NODE_CAPABILITY, type)
}

// 必留哈希是逐个键核对的：同一层里写重复键名会让要求数量看起来比实际多，
// 以前由 Set 静默折叠（S2 第二十八轮 P2-2）。模板层与节点层各自不许重复，跨层取并集不变。
function assertNoDuplicateRequiredHashes(owner: string, keys: readonly string[] | undefined): void {
  const seen = new Set<string>()
  for (const key of keys ?? []) {
    if (seen.has(key)) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', '必留哈希键名重复，要求会被静默折叠', { owner, key })
    }
    seen.add(key)
  }
}

// 定义里的等待配置由发布者签名固定：派发请求不能改写等待谓词或子流程目标（审计 P1-1）。
// 这里做的是形状校验；能不能跑由阶段能力与运行期 graph 闸决定。
const DEFINITION_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000

function assertWaitConfig(node: WorkflowNodeDef): void {
  const cfg = node.wait
  if (!cfg) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'wait 节点必须在定义里写明等待配置', { node_id: node.node_id })
  }
  if (cfg.wait_kind !== 'event' && cfg.wait_kind !== 'timer') {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'wait_kind 只能是 event 或 timer', {
      node_id: node.node_id,
      wait_kind: cfg.wait_kind,
    })
  }
  if (!cfg.match || typeof cfg.match.type !== 'string' || cfg.match.type.length === 0) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '等待谓词缺少事件类型', { node_id: node.node_id })
  }
  if (cfg.match.path !== undefined && typeof cfg.match.path !== 'string') {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '等待谓词 path 必须是字符串', { node_id: node.node_id })
  }
  if (!Number.isInteger(cfg.max_wait_ms) || cfg.max_wait_ms <= 0 || cfg.max_wait_ms > MAX_WAIT_MS) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'max_wait_ms 必须是 0 到 7 天之间的正整数', {
      node_id: node.node_id,
      max_wait_ms: cfg.max_wait_ms,
    })
  }
  if (cfg.from_seq !== undefined && (!Number.isInteger(cfg.from_seq) || cfg.from_seq < 0)) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'from_seq 必须是非负整数', {
      node_id: node.node_id,
      from_seq: cfg.from_seq,
    })
  }
}

function assertSubworkflowConfig(node: WorkflowNodeDef): void {
  const cfg = node.subworkflow
  if (!cfg) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'subworkflow 节点必须在定义里写明目标工作流与固定版本', {
      node_id: node.node_id,
    })
  }
  if (typeof cfg.workflow_id !== 'string' || !DEFINITION_IDENTITY_PATTERN.test(cfg.workflow_id)) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '子流程 workflow_id 不合法', {
      node_id: node.node_id,
      workflow_id: cfg.workflow_id,
    })
  }
  if (!Number.isInteger(cfg.pinned_version) || cfg.pinned_version < 1) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程必须 pin 一个正整数版本，不能跟随最新', {
      node_id: node.node_id,
      pinned_version: cfg.pinned_version,
    })
  }
  if (cfg.resume_from !== undefined && cfg.resume_from !== null && typeof cfg.resume_from !== 'string') {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'resume_from 必须是字符串或 null', { node_id: node.node_id })
  }
}

// 控制配置只能长在对应类型的节点上：agent/parallel/decision 带上它就是定义被写错了。
// 旧定义里若还带着请求体形态的 control，也在这里拒掉，避免“看起来配了、实际没生效”。
function assertControlConfigShape(node: WorkflowNodeDef): void {
  if (node.type === 'policy') assertPolicyNodeConfig(node.policy)
  else if (node.policy !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '只有 policy 节点能声明 policy 配置', { node_id: node.node_id })
  }
  if (node.type === 'approval') assertApprovalNodeConfig(node.approval)
  else if (node.approval !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '只有 approval 节点能声明 approval 配置', { node_id: node.node_id })
  }
  if (node.type === 'tool') {
    assertToolNodeConfig(node.tool)
    if (node.tools !== undefined || node.required_hashes?.length) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', '独立工具节点的工具和结果哈希由注册表执行结果决定', { node_id: node.node_id })
    }
  } else if (node.tool !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '只有 tool 节点能声明工具配置', { node_id: node.node_id })
  }
  if (node.type !== 'parallel' && node.parallel !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '只有 parallel 节点能声明并行配置', { node_id: node.node_id })
  }
  if (node.side_effect_policy !== undefined && (node.type !== 'agent' || !['pure','compensable','irreversible'].includes(node.side_effect_policy))) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '智能体步骤的副作用声明无效', { node_id: node.node_id })
  }
  const raw = node as WorkflowNodeDef & { control?: unknown }
  if (raw.control !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '控制节点配置必须写成 wait / subworkflow 字段，不接受 control', {
      node_id: node.node_id,
    })
  }
  if (node.type === 'wait') {
    assertWaitConfig(node)
    if (node.subworkflow !== undefined) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'wait 节点不能同时声明 subworkflow 配置', { node_id: node.node_id })
    }
    return
  }
  if (node.type === 'subworkflow') {
    assertSubworkflowConfig(node)
    if (node.wait !== undefined) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'subworkflow 节点不能同时声明 wait 配置', { node_id: node.node_id })
    }
    return
  }
  if (node.wait !== undefined || node.subworkflow !== undefined) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', '只有 wait / subworkflow 节点能带控制配置', {
      node_id: node.node_id,
      type: node.type,
    })
  }
}

// 加载期按 min_phase 拒越阶段能力：S2 加载 parallel 节点必须被拒（规格 2.4 行 122）
export function assertDefinitionAllowed(def: WorkflowDefinition, phase: Phase): void {
  assertNoDuplicateRequiredHashes('template', def.required_hashes)
  for (const node of def.nodes) {
    assertNoDuplicateRequiredHashes(node.node_id, node.required_hashes)
    assertNoMemoryWriteTool(node.tools?.allow ?? [])
    if (!isKnownNodeType(node.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '未知节点类型', { node_id: node.node_id, type: node.type })
    }
    const capability = NODE_CAPABILITY[node.type]
    if (!PHASE_CAPABILITIES[phase].includes(capability)) {
      throw new OrchError('FORBIDDEN', '当前阶段不提供这个能力', {
        phase,
        needed: capability,
        node_id: node.node_id,
        allowed: PHASE_CAPABILITIES[phase].slice(),
      })
    }
    // 阶段闸先判：S2 下的 subworkflow 节点是因为能力不够被拒，而不是配置缺字段
    assertControlConfigShape(node)
    if (node.type === 'tool' && def.required_hashes?.length) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', '含独立工具的工作流须使用工具自带的系统取证格式', { node_id: node.node_id })
    }
    if (node.type === 'parallel' && node.parallel !== undefined) {
      const edges = def.edges ?? []
      const members = parallelMemberIds(edges, node.node_id)
      assertParallelNodeConfig(node.parallel, members.length)
      assertParallelTopology(edges, node.node_id, node.parallel)
      if (!node.parallel.allow_irreversible_children && def.nodes.some(member => members.includes(member.node_id) && member.side_effect_policy === 'irreversible')) {
        throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'parallel 需要显式允许不可逆成员', { node_id: node.node_id })
      }
    }
    if (node.type === 'branch') {
      const routes = branchEdgesOf(def, node.node_id)
      if (!routes.length || new Set(routes.flatMap(route => route.priority === undefined ? [] : [route.priority])).size !== routes.filter(route => route.priority !== undefined).length) {
        throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'branch 必须有出边，且 priority 不可重复', { node_id: node.node_id })
      }
      validateBranchEdges(routes)
      for (const route of routes) {
        if (route.default === true) continue
        if (route.when === undefined) throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'branch 的非默认出边必须声明条件', { node_id: node.node_id, to: route.to })
        validatePolicy(route.when)
      }
    }
  }
}

// 命令越过阶段的闸：能力不在当前阶段的清单里就拒（规格 2.4 行 122）
export function assertCommandAllowed(command: string, phase: Phase, needed: string): void {
  const caps = PHASE_CAPABILITIES[phase]
  if (!caps.includes(needed)) {
    throw new OrchError('FORBIDDEN', '当前阶段不许做这件事', {
      command,
      phase,
      needed,
      allowed: caps.slice(),
    })
  }
}
