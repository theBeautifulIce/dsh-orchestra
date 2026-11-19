import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import type { WorkflowDefinition } from '../core/workflow-def.ts'
import { validatePublishLayer, validateSaveLayer, type PublishContext, type WorkflowDoc } from '../core/workflow-doc.ts'
import { MODEL_COMPLEXITIES, type ModelRecommendation, type ModelRoutingContext } from '../executor/model-routing.ts'
import type { ToolRegistry } from '../executor/tools.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { ARTIFACT_MAX_BYTES, isArtifactFileName } from './artifact-store.ts'
import { startRun, startTrustedTaskLocalRun } from './commands/start-run.ts'
import { createWorkflow, publishContextFor, publishDraft, runtimeProjection, testWorkflowDraft } from './commands/workflows.ts'
import { withReadTx } from './queries/read-tx.ts'
import type { NodeSpec } from './dispatcher.ts'
import type { TriggerRunReady } from './task-trigger-dispatch.ts'
import { reserveTaskInTx } from './runs.ts'
import { definitionHashOf, type WorkflowCatalog } from './workflows.ts'

const claim = z.string().trim().min(1).max(500)
const key = z.string().min(1).max(128)
const goalIds = z.array(key).min(1).max(13)
const stepSchema = z.strictObject({
  node_id: key,
  description: claim,
  goal_ids: z.array(key).max(13),
  depends_on: z.array(key).max(100),
  tools: z.array(key).max(20),
  complexity: z.enum(MODEL_COMPLEXITIES),
  model_reason: z.string().trim().min(1).max(240),
})
const acceptance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), file_name: z.string().trim().min(1).max(240),
    minimum_bytes: z.number().int().min(1).max(ARTIFACT_MAX_BYTES) }),
  z.strictObject({ kind: z.literal('tool_evidence'), tool: key, exit_code: z.literal(0) }),
])
const proposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  workflow_id: key,
  workflow_version: z.string().regex(/^[1-9]\d{0,14}$/),
  steps: z.array(stepSchema).min(1).max(100),
  deliverables: z.array(z.strictObject({ title: claim, node_id: key, goal_ids: goalIds, acceptance })).min(1).max(20),
  risks: z.array(z.strictObject({ severity: z.enum(['low', 'medium', 'high']), description: claim, mitigation: claim,
    node_id: key.optional() })).max(20),
})
/**
 * 「没有可用的候选流程」信号：主脑判定候选池里没有一个适合这次任务时显式回这个分支，
 * 服务端据此自动生成任务专属流程（task_local）。用独立分支而不是空字符串或魔法值，
 * 免得和正常提案混淆。
 */
const noCandidateSchema = z.strictObject({
  kind: z.literal('no_candidate'),
  reason: z.string().trim().min(1).max(500),
})
type PlannerOutcome = { kind: 'proposal'; proposal: TaskPlanProposal } | { kind: 'no_candidate'; reason: string }

export const planInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(2000),
  requirements: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
})
export const planConfirmSchema = z.strictObject({
  plan_id: z.uuidv7(), content_hash: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true),
})

export type TaskPlanInput = z.infer<typeof planInputSchema>
export type TaskPlanProposal = z.infer<typeof proposalSchema>
export type PlanConfirm = z.infer<typeof planConfirmSchema>
type Goal = { id: string; text: string }
type PlanInput = { goal: string; requirements: Goal[] }
type WorkflowCandidate = {
  workflowId: string; version: string; title: string
  nodes: Array<{ id: string; type: string; dependsOn: string[]; toolAllow: string[]; declaredTools: string[] }>
}
type PublishedChoice = { workflow: WorkflowCandidate; hash: string }
export type TaskPlanningOptions = {
  propose(input: PlanInput & { workflows: WorkflowCandidate[] }, signal: AbortSignal): Promise<unknown>
  timeoutMs?: number
  /**
   * 自动生成任务专属流程的能力：没有可复用的合适流程时，由服务端生成 task_local 流程。
   * 不装配它就退回原来的口径：提示先发布至少一个可复用流程。
   */
  workflowGenerator?: (input: { goal: string }, signal: AbortSignal) => Promise<unknown>
  /** 运行时允许的节点类型（发布层校验用）；默认只认 agent / wait。 */
  runtimeNodeTypes?: ReadonlySet<string>
}
const checks = ['workflow', 'coverage', 'deliverables', 'tools', 'dependencies', 'risks'] as const
type PlanCheck = (typeof checks)[number]
export type PlanQuality = { ready: boolean; checks: Array<{ check: PlanCheck; passed: boolean; issues: string[] }> }
export type TaskPlanView = {
  plan_id: string
  content_hash: string
  brief: PlanInput
  proposal: TaskPlanProposal
  quality: PlanQuality
  created_at: string
  launch: { task_id: string; run_id: string } | null
  /** 自动生成的流程归属的预留任务号（只有自动生成的计划才有） */
  owner_task_id?: string | null
  /** 自动生成并发布的任务专属流程号（只有自动生成的计划才有） */
  auto_workflow_id?: string | null
}
type PlanRow = {
  plan_id: string; input_json: string; proposal_json: string; quality_json: string; content_hash: string
  workflow_hash: string | null; launch_operation_id: string; created_at: string
  task_id: string | null; run_id: string | null
  owner_task_id: string | null; auto_workflow_id: string | null
}
const PLAN_SELECT = `SELECT p.plan_id, p.input_json, p.proposal_json, p.quality_json, p.content_hash,
  p.workflow_hash, p.launch_operation_id, p.created_at, o.task_id, o.run_id,
  p.owner_task_id, p.auto_workflow_id
  FROM task_plans p LEFT JOIN start_run_operations o ON o.operation_id = p.launch_operation_id`

function toPlanView(row: PlanRow): TaskPlanView {
  return {
    plan_id: row.plan_id, content_hash: row.content_hash, brief: JSON.parse(row.input_json) as PlanInput,
    proposal: proposalSchema.parse(JSON.parse(row.proposal_json)), quality: JSON.parse(row.quality_json) as PlanQuality,
    created_at: row.created_at, launch: row.task_id && row.run_id ? { task_id: row.task_id, run_id: row.run_id } : null,
    owner_task_id: row.owner_task_id, auto_workflow_id: row.auto_workflow_id,
  }
}

type PublishedRow = { workflow_id: string; name: string; version: string; content_hash: string }
const PUBLISHED_SELECT = 'SELECT w.workflow_id, w.name, v.version, v.content_hash FROM workflows w '
  + "JOIN workflow_versions v ON v.workflow_id = w.workflow_id WHERE w.status = 'active' AND w.scope = 'reusable' "
  + 'AND v.published_by IS NOT NULL'
// 已启动的运行只认自己固定下来的版本：流程被停用、后来又发新版本，都不改变这次运行的绑定
const PINNED_VERSION_SELECT = 'SELECT w.workflow_id, w.name, v.version, v.content_hash FROM workflows w '
  + 'JOIN workflow_versions v ON v.workflow_id = w.workflow_id'

// 候选检索：先捞一个够大的池子，再按任务适配性排序，最后才截断给主脑。
// 原来按 updated_at 直接取 24 个，更新时间落后的合适流程会被挤掉。
const CANDIDATE_POOL_LIMIT = 200
const CANDIDATE_LIMIT = 24
type CandidateRow = PublishedRow & { doc_json: string | null }
const CANDIDATE_SELECT = 'SELECT w.workflow_id, w.name, v.version, v.content_hash, v.doc_json FROM workflows w '
  + "JOIN workflow_versions v ON v.workflow_id = w.workflow_id WHERE w.status = 'active' AND w.scope = 'reusable' "
  + 'AND v.published_by IS NOT NULL'
  + ' AND v.version = CAST(w.current_version AS TEXT) ORDER BY w.updated_at DESC, w.workflow_id LIMIT '
  + CANDIDATE_POOL_LIMIT

/** 分词：英文数字词（至少 2 个字符）+ 中文二元组。确定性切分，同样输入同样结果。 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    const word = match[0]
    if (word && word.length >= 2) tokens.push(word)
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** 这次任务的目标与要求里出现的词 */
function goalTokens(brief: PlanInput): Set<string> {
  const text = [brief.goal, ...brief.requirements.map((item) => item.text)].join(' ')
  return new Set(tokenize(text))
}

/** 流程文档里的节点标题与工具名：运行时投影不带标题，只能从 doc_json 取 */
function docSignals(docJson: string | null): { titles: string[]; tools: string[] } {
  const titles: string[] = []
  const tools: string[] = []
  if (!docJson) return { titles, tools }
  let parsed: { nodes?: Array<{ title?: unknown; config?: Record<string, unknown> }> }
  try { parsed = JSON.parse(docJson) as { nodes?: Array<{ title?: unknown; config?: Record<string, unknown> }> } }
  catch { return { titles, tools } }
  for (const node of parsed.nodes ?? []) {
    if (typeof node.title === 'string') titles.push(node.title)
    const allow = (node.config?.tools as { allow?: unknown } | undefined)?.allow
    if (Array.isArray(allow)) for (const tool of allow) if (typeof tool === 'string') tools.push(tool)
  }
  return { titles, tools }
}

/**
 * 任务适配性打分：流程名权重 3、节点标题权重 2、工具名权重 1。
 * 确定性：同样输入同样分数；分数并列时按 workflow_id 稳定排序。
 */
function relevanceScore(tokens: Set<string>, row: CandidateRow): number {
  const signals = docSignals(row.doc_json)
  const parts: Array<{ text: string; weight: number }> = [
    { text: row.name, weight: 3 },
    ...signals.titles.map((title) => ({ text: title, weight: 2 })),
    ...signals.tools.map((tool) => ({ text: tool, weight: 1 })),
  ]
  let score = 0
  for (const part of parts) {
    const hits = new Set(tokenize(part.text))
    for (const token of tokens) if (hits.has(token)) score += part.weight
  }
  return score
}

/** 并列时的稳定序：workflow_id 升序 */
function compareWorkflowIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function readChoice(catalog: WorkflowCatalog, registry: ToolRegistry | undefined, row: PublishedRow): PublishedChoice | null {
  const def = catalog.get(row.workflow_id, row.version)
  if (catalog.definitionHash(row.workflow_id, row.version) !== row.content_hash || def.nodes.length > 100) return null
  const nodes = def.nodes.map((node) => {
    const policy = catalog.toolPolicyFor(row.workflow_id, row.version, node.node_id)
    const declaredTools = [...new Set(policy.allow.filter((tool) => !policy.deny.includes(tool)))]
    return {
      id: node.node_id, type: node.type, dependsOn: (def.edges ?? []).filter((edge) => edge.to === node.node_id).map((edge) => edge.from),
      declaredTools, toolAllow: declaredTools.filter((tool) => registry?.lookup(tool)?.capability === 'read_only'),
    }
  })
  return { workflow: { workflowId: row.workflow_id, version: row.version, title: row.name, nodes }, hash: row.content_hash }
}

/** 版本没加载过时按"固定版本不可用"处理，不让内部错误码漏给调用方 */
function readChoiceSafe(catalog: WorkflowCatalog, registry: ToolRegistry | undefined, row: PublishedRow): PublishedChoice | null {
  try {
    return readChoice(catalog, registry, row)
  } catch (error) {
    if (error instanceof OrchError && error.code === 'NOT_FOUND') return null
    throw error
  }
}

type ToolViolation = { node_id: string; tool: string; cause: 'not_registered' | 'not_read_only' | 'not_allowed' }

/** 工具权限被撤的具体条目：运行期据此报权限阻断，而不是伪装成版本不匹配 */
function toolViolations(registry: ToolRegistry | undefined, proposal: TaskPlanProposal, workflow: WorkflowCandidate): ToolViolation[] {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const violations: ToolViolation[] = []
  for (const step of proposal.steps) {
    const node = nodes.get(step.node_id)
    if (!node) continue
    for (const tool of [...new Set([...node.declaredTools, ...step.tools])]) {
      if (node.toolAllow.includes(tool)) continue
      const declared = node.declaredTools.includes(tool)
      const found = registry?.lookup(tool)
      violations.push({
        node_id: step.node_id, tool,
        cause: declared ? (found ? 'not_read_only' : 'not_registered') : 'not_allowed',
      })
    }
  }
  return violations
}

function evaluate(brief: PlanInput, proposal: TaskPlanProposal, workflow: WorkflowCandidate | undefined): PlanQuality {
  const issues: Record<PlanCheck, string[]> = {
    workflow: [], coverage: [], deliverables: [], tools: [], dependencies: [], risks: [],
  }
  if (!workflow) issues.workflow.push('候选未选中本次提供的活跃、已发布流程版本。')
  const goals = [{ id: 'goal', text: brief.goal }, ...brief.requirements]
  const expectedGoals = new Set(goals.map((item) => item.id))
  const nodes = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]))
  const steps = new Map(proposal.steps.map((step) => [step.node_id, step]))
  if (steps.size !== proposal.steps.length) issues.dependencies.push('计划中有重复步骤。')
  if (workflow && (steps.size !== nodes.size || [...nodes.keys()].some((id) => !steps.has(id)))) {
    issues.dependencies.push('计划必须覆盖固定流程中的每个实际步骤。')
  }
  for (const step of proposal.steps) {
    const node = nodes.get(step.node_id)
    if (!node && workflow) issues.dependencies.push('未在当前流程找到步骤 ' + step.node_id)
    if (node && (step.depends_on.length !== node.dependsOn.length || new Set(step.depends_on).size !== step.depends_on.length
      || step.depends_on.some((id) => !node.dependsOn.includes(id)))) {
      issues.dependencies.push(step.node_id + ' 的前置依赖与已发布流程不一致。')
    }
    if (step.goal_ids.some((id) => !expectedGoals.has(id))) issues.coverage.push(step.node_id + ' 引用了未登记的目标。')
    if (node && [...new Set([...node.declaredTools, ...step.tools])].some((tool) => !node.toolAllow.includes(tool))) {
      issues.tools.push(step.node_id + ' 的工具未注册、超出授权或无法用于只读执行。')
    }
    if (node?.type === 'subworkflow') issues.dependencies.push(step.node_id + ' 使用子流程，需另行校验子流程的目标、工具和验收。')
    if (node?.type === 'wait' && !proposal.risks.some((risk) => risk.node_id === node.id)) {
      issues.risks.push(step.node_id + ' 是等待节点，须说明超时风险和应对措施。')
    }
  }
  for (const deliverable of proposal.deliverables) {
    const step = steps.get(deliverable.node_id)
    const rule = deliverable.acceptance
    if (!step || nodes.get(deliverable.node_id)?.type !== 'agent'
      || deliverable.goal_ids.some((id) => !expectedGoals.has(id) || !step.goal_ids.includes(id))) {
      issues.deliverables.push(deliverable.title + ' 必须引用同一流程内承担相应目标的执行节点。')
    }
    if (rule.kind === 'tool_evidence' && !step?.tools.includes(rule.tool)) {
      issues.deliverables.push(deliverable.title + ' 的验收工具须列在生产步骤中。')
    }
    if (rule.kind === 'artifact' && !isArtifactFileName(rule.file_name)) {
      issues.deliverables.push(deliverable.title + ' 的验收文件名必须是普通文件名。')
    }
  }
  for (const goal of goals) {
    if (!proposal.steps.some((step) => step.goal_ids.includes(goal.id))
      || !proposal.deliverables.some((item) => item.goal_ids.includes(goal.id))) {
      issues.coverage.push(goal.id + ' 缺少执行步骤或可核验交付物。')
    }
  }
  for (const risk of proposal.risks) {
    if (risk.severity === 'high') issues.risks.push('存在高风险事项，需调整计划后重新评估。')
    if (risk.node_id !== undefined && !steps.has(risk.node_id)) issues.risks.push('风险引用了不存在的计划步骤。')
  }
  const results = checks.map((check) => ({ check, passed: issues[check].length === 0, issues: [...new Set(issues[check])] }))
  return { ready: results.every((result) => result.passed), checks: results }
}

function planHash(view: Pick<TaskPlanView, 'brief' | 'proposal' | 'quality'>, workflowHash: string | null): string {
  return sha256Hex(canonicalJson({ schema: 1, ...view, workflow_hash: workflowHash }))
}

function assertApprovedPlan(row: PlanRow, workflowId: string | null, workflowVersion: string | null): TaskPlanView {
  const view = toPlanView(row)
  const { brief, proposal, quality } = view
  if (!quality.ready || proposal.workflow_id !== workflowId || proposal.workflow_version !== workflowVersion
    || row.content_hash !== planHash({ brief, proposal, quality }, row.workflow_hash)) {
    throw new OrchError('CONFIRMATION_MISMATCH', '已启动任务的规划内容或固定流程绑定不符')
  }
  return view
}

// 自动生成的流程只认这几种节点：evaluate 会把 subworkflow 节点记成阻断项，所以这里只放 trigger / agent / wait
const GENERATED_NODE_TYPES = new Set(['trigger', 'agent', 'wait'])
/** 默认运行时允许的节点类型（发布层校验用） */
const DEFAULT_RUNTIME_NODE_TYPES: ReadonlySet<string> = new Set(['agent', 'wait'])

const generatedDocSchema = z.object({
  name: z.string().trim().min(1).max(80),
  nodes: z.array(z.object({
    node_id: z.string().trim().min(1).max(64),
    type: z.string().trim().min(1).max(32).optional(),
    title: z.string().trim().max(80).optional(),
    position: z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) }).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(50),
  // route 由发布层校验（branch 才需要 route 对象），主脑草案里的 route 一律丢弃
  edges: z.array(z.object({
    from: z.string().trim().min(1).max(64),
    to: z.string().trim().min(1).max(64),
  })).max(200).default([]),
})

/** 节点号必须合法且唯一：/^[a-z][a-z0-9_]{0,63}$/ */
function sanitizeNodeId(raw: string, used: Set<string>): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64)
  const base = /^[a-z]/.test(cleaned) ? cleaned : 'n_' + cleaned
  let candidate = base
  let index = 2
  while (used.has(candidate)) {
    candidate = (base.slice(0, 58) + '_' + index).slice(0, 64)
    index += 1
  }
  used.add(candidate)
  return candidate
}

/** 只留服务端登记过的只读工具：发布层不允许未注册或可写的工具 */
function allowedReadOnlyTools(config: Record<string, unknown> | undefined, registry: ToolRegistry | undefined): string[] {
  const allow = (config?.tools as { allow?: unknown } | undefined)?.allow
  if (!Array.isArray(allow)) return []
  const kept: string[] = []
  for (const tool of allow) {
    if (typeof tool !== 'string') continue
    if (registry?.lookup(tool)?.capability !== 'read_only') continue
    if (!kept.includes(tool)) kept.push(tool)
  }
  return kept
}

/** 等待节点的配置必须完整，否则这个节点没法发布，直接丢掉 */
function validWaitConfig(config: Record<string, unknown> | undefined): boolean {
  const kind = config?.wait_kind
  const match = config?.match as { type?: unknown } | undefined
  const maxWait = config?.max_wait_ms
  return (kind === 'event' || kind === 'timer')
    && typeof match?.type === 'string' && match.type.length > 0
    && typeof maxWait === 'number' && Number.isInteger(maxWait) && maxWait > 0
}

/** 图语义不合法时退化成的直线流程：trigger → 各个 agent */
function linearize(doc: WorkflowDoc): WorkflowDoc {
  const trigger = doc.nodes.find((node) => node.type === 'trigger')
    ?? { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 }, config: {} }
  const chain = [trigger, ...doc.nodes.filter((node) => node.type === 'agent')]
  const edges = chain.slice(1).map((node, index) => ({ from: chain[index]!.node_id, to: node.node_id }))
  return { name: doc.name, nodes: chain, edges }
}

/** 把主脑给的流程草案整理成可保存、可发布的流程文档 */
function buildAutoDoc(draft: unknown, registry: ToolRegistry | undefined, runtimeNodeTypes: ReadonlySet<string>): WorkflowDoc {
  const parsed = generatedDocSchema.safeParse(draft)
  if (!parsed.success) {
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程不符合约定结构', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 12),
    })
  }
  const source = parsed.data
  const used = new Set<string>()
  const idMap = new Map<string, string>()
  const nodes: WorkflowDoc['nodes'] = []
  source.nodes.forEach((node, index) => {
    const type = node.type ?? 'agent'
    if (!GENERATED_NODE_TYPES.has(type)) return
    const id = sanitizeNodeId(node.node_id, used)
    idMap.set(node.node_id, id)
    if (type === 'wait' && !validWaitConfig(node.config)) return
    const config: Record<string, unknown> = {}
    if (type === 'wait') Object.assign(config, node.config ?? {})
    if (type === 'agent') {
      const tools = allowedReadOnlyTools(node.config, registry)
      if (tools.length > 0) config.tools = { allow: tools }
    }
    nodes.push({
      node_id: id, type,
      title: node.title && node.title.length > 0 ? node.title : id,
      position: node.position ?? { x: 100 * (index + 1), y: 0 },
      config,
    })
  })
  // 恰好一个 trigger：多了丢掉多余的，少了补一个起点
  const triggers = nodes.filter((node) => node.type === 'trigger')
  for (const extra of triggers.slice(1)) nodes.splice(nodes.indexOf(extra), 1)
  if (!nodes.some((node) => node.type === 'trigger')) {
    nodes.unshift({ node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 }, config: {} })
  }
  const existing = new Set(nodes.map((node) => node.node_id))
  const edges: WorkflowDoc['edges'] = []
  const seen = new Set<string>()
  for (const edge of source.edges) {
    const from = idMap.get(edge.from)
    const to = idMap.get(edge.to)
    if (!from || !to || from === to || !existing.has(from) || !existing.has(to)) continue
    if (nodes.find((node) => node.node_id === to)?.type === 'trigger') continue
    const key = from + '->' + to
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from, to })
  }
  const doc: WorkflowDoc = { name: source.name, nodes, edges }
  const saved = validateSaveLayer(doc, { expectedName: source.name })
  if (saved.report.errors.length > 0) {
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程没有通过保存层校验', {
      fields: saved.report.errors.slice(0, 12).map((issue) => issue.path + ': ' + issue.code),
    })
  }
  const ctx: PublishContext = { registeredNodeTypes: runtimeNodeTypes, publishedVersions: () => true }
  if (validatePublishLayer(doc, ctx).length > 0) {
    const chain = linearize(doc)
    const chainSaved = validateSaveLayer(chain, { expectedName: source.name })
    if (chainSaved.report.errors.length > 0 || validatePublishLayer(chain, ctx).length > 0) {
      throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程无法整理成可发布的图')
    }
    return chain
  }
  return doc
}

/** 运行时投影 → 规划器看到的候选流程 */
function candidateFromRuntime(def: WorkflowDefinition, title: string, registry: ToolRegistry | undefined): WorkflowCandidate {
  const nodes = def.nodes.map((node) => {
    const deny = node.tools?.deny ?? []
    const allow = [...new Set((node.tools?.allow ?? []).filter((tool) => !deny.includes(tool)))]
    return {
      id: node.node_id, type: node.type,
      dependsOn: (def.edges ?? []).filter((edge) => edge.to === node.node_id).map((edge) => edge.from),
      declaredTools: allow,
      toolAllow: allow.filter((tool) => registry?.lookup(tool)?.capability === 'read_only'),
    }
  })
  return { workflowId: def.workflow_id ?? '', version: String(def.workflow_version), title, nodes }
}

export function createTaskPlanningHost(db: Db, catalog: WorkflowCatalog, registry: ToolRegistry | undefined, options?: TaskPlanningOptions) {
  const timeout = options?.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120_000) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑规划时限必须在 1 到 120 秒之间')
  }
  const get = (planId: string, actor: string) => withReadTx(db, ({ tx, as_of_seq }) => {
    const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE p.plan_id = ? AND p.created_by = ?', [planId, actor])
    if (!row) throw new OrchError('NOT_FOUND', '没有对应的任务计划')
    return { row, view: toPlanView(row), as_of_seq }
  })
  /** 调主脑：统一的超时与错误口径 */
  const callPlanner = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    messages: { timeout: string; failure: string },
  ): Promise<T> => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new OrchError('OPERATION_TIMEOUT', messages.timeout))
          controller.abort()
        }, timeout)
        timer.unref()
      })
      return await Promise.race([run(controller.signal), expired])
    } catch (error) {
      if (error instanceof OrchError && error.code === 'OPERATION_TIMEOUT') throw error
      throw new OrchError('SERVICE_UNAVAILABLE', messages.failure)
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  /** 主脑提案：完整提案，或者显式的「没有可用候选」信号 */
  const askPlanner = async (brief: PlanInput, workflows: WorkflowCandidate[]): Promise<PlannerOutcome> => {
    const planner = options?.propose
    if (!planner) throw new OrchError('VERDICT_UNSUPPORTED', 'DSH 宿主尚未装配主脑规划服务')
    const offered = structuredClone({ ...brief, workflows })
    const candidate = await callPlanner(
      (signal) => planner(offered, signal),
      { timeout: '主脑没有在时限内生成计划', failure: '主脑暂时未能产出计划' },
    )
    const parsed = proposalSchema.safeParse(candidate)
    if (parsed.success) return { kind: 'proposal', proposal: parsed.data }
    const none = noCandidateSchema.safeParse(candidate)
    if (none.success) return { kind: 'no_candidate', reason: none.data.reason }
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑返回的计划不符合约定结构', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 12),
    })
  }
  /**
   * 没有可复用的合适流程时：生成任务专属流程（task_local），再基于它产出一份完整计划。
   * 预留任务 + 建流程 + 发布 + 落计划在同一笔事务里：失败不留孤儿流程，也不留悬空预留任务。
   */
  const proposeAuto = async (brief: PlanInput, actor: string, now: string): Promise<ReturnType<typeof get>> => {
    const generator = options?.workflowGenerator
    if (!generator) {
      throw new OrchError('VERDICT_UNSUPPORTED', '主脑判定没有可用流程，但服务端没有装配流程生成能力')
    }
    const runtimeNodeTypes = options?.runtimeNodeTypes ?? DEFAULT_RUNTIME_NODE_TYPES
    const goal = [brief.goal, ...brief.requirements.map((item) => item.text)].join('；')
    // 1) 主脑出流程草案：放在事务外，主脑耗时不能占着写锁
    const draft = await callPlanner(
      (signal) => generator({ goal }, signal),
      { timeout: '主脑没有在时限内生成流程', failure: '主脑暂时未能生成流程' },
    )
    const doc = buildAutoDoc(draft, registry, runtimeNodeTypes)
    const workflowId = 'tl_' + uuidv7().replace(/-/g, '')
    const runtime = runtimeProjection(workflowId, '1', doc)
    const workflowHash = definitionHashOf(runtime)
    const autoCandidate = candidateFromRuntime(runtime, doc.name, registry)
    // 2) 再让主脑基于新生成的流程产出一份完整计划（steps / deliverables / risks）
    const outcome = await askPlanner(brief, [autoCandidate])
    if (outcome.kind !== 'proposal') {
      throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑没有基于新生成的流程产出完整计划')
    }
    const { proposal } = outcome
    if (proposal.workflow_id !== autoCandidate.workflowId || proposal.workflow_version !== autoCandidate.version) {
      throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑返回的计划没有选择本次生成的流程版本')
    }
    const quality = evaluate(brief, proposal, autoCandidate)
    const hash = planHash({ brief, proposal, quality }, workflowHash)
    const id = uuidv7()
    // 3) 预留任务 + 建流程 + 发布 + 落计划：同一笔事务
    const published = withTx(db, (tx) => {
      const ctx = publishContextFor(tx, runtimeNodeTypes)
      const reserved = reserveTaskInTx(tx, { title: brief.goal, actor, now, operationId: uuidv7() })
      createWorkflow(tx, {
        workflowId, name: doc.name, definition: doc, scope: 'task_local', ownerTaskId: reserved.task_id, actor, now,
      })
      const test = testWorkflowDraft(tx, { workflowId, revision: 1, now }, ctx, registry)
      if (!test.passed) {
        throw new OrchError('WORKFLOW_VALIDATION_FAILED', '自动生成的流程未通过结构与模拟流转测试', { issues: test.issues.errors.slice(0, 12) })
      }
      const result = publishDraft(tx, {
        workflowId, revision: 1, baseVersion: 0, note: '自动生成的任务专属流程', actor, now,
      }, ctx, { requireTest: true, tools: registry, catalog })
      tx.run('INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, content_hash, launch_operation_id, created_at, owner_task_id, auto_workflow_id)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, actor, JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), workflowHash, hash, uuidv7(), now, reserved.task_id, workflowId])
      appendEvent(tx, {
        type: 'task_plan.proposed',
        payload: { plan_id: id, content_hash: hash, quality_ready: quality.ready, auto_workflow_id: workflowId },
      })
      return { definition: result.definition, definition_hash: result.definition_hash }
    })
    // 4) 发布提交后把定义装进目录，后续 confirm / run 才找得到这条流程
    catalog.adopt(published.definition, published.definition_hash)
    return get(id, actor)
  }
  return {
    enabled: options !== undefined,
    get,
    getForTask(taskId: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE o.task_id = ? AND p.created_by = ?', [taskId, actor])
        return { item: row ? toPlanView(row) : null, as_of_seq }
      })
    },
    async propose(input: TaskPlanInput, actor: string, now: string) {
      if (!options?.propose) throw new OrchError('VERDICT_UNSUPPORTED', 'DSH 宿主尚未装配主脑规划服务')
      const brief = { goal: input.goal, requirements: input.requirements.map((text, index) => ({ id: 'R' + (index + 1), text })) }
      // 候选检索：先捞一个较大的池子，再按任务适配性排序，最后才截断
      const choices = withReadTx(db, ({ tx }) => {
        const rows = tx.all<CandidateRow>(CANDIDATE_SELECT)
        const tokens = goalTokens(brief)
        const scored = rows.flatMap((row) => {
          const choice = readChoice(catalog, registry, row)
          return choice ? [{ choice, score: relevanceScore(tokens, row) }] : []
        })
        scored.sort((left, right) => right.score - left.score
          || compareWorkflowIds(left.choice.workflow.workflowId, right.choice.workflow.workflowId))
        return scored.slice(0, CANDIDATE_LIMIT).map((item) => item.choice)
      })
      // 候选池里一个都没有：走自动生成；没有生成能力就还是让调用方先去发布流程
      if (choices.length === 0) {
        if (!options.workflowGenerator) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '请先发布至少一个可复用流程')
        return proposeAuto(brief, actor, now)
      }
      const outcome = await askPlanner(brief, choices.map((item) => item.workflow))
      // 主脑判定候选池里没有一个适合这次任务：走同一条自动生成路径
      if (outcome.kind === 'no_candidate') return proposeAuto(brief, actor, now)
      const proposal = outcome.proposal
      const selected = choices.find(({ workflow }) => workflow.workflowId === proposal.workflow_id && workflow.version === proposal.workflow_version)
      const quality = evaluate(brief, proposal, selected?.workflow)
      const workflowHash = selected?.hash ?? null
      const hash = planHash({ brief, proposal, quality }, workflowHash)
      const id = uuidv7()
      withTx(db, (tx) => {
        tx.run('INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, content_hash, launch_operation_id, created_at, owner_task_id, auto_workflow_id)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
          [id, actor, JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), workflowHash, hash, uuidv7(), now])
        appendEvent(tx, { type: 'task_plan.proposed', payload: { plan_id: id, content_hash: hash, quality_ready: quality.ready } })
      })
      return get(id, actor)
    },
    confirm(input: PlanConfirm, actor: string, now: string) {
      const { row, view } = get(input.plan_id, actor)
      const { brief, proposal, quality } = view
      if (input.confirmed !== true) throw new OrchError('CONFIRMATION_REQUIRED', '请核对计划后确认启动')
      if (input.content_hash !== row.content_hash || row.content_hash !== planHash({ brief, proposal, quality }, row.workflow_hash)) {
        throw new OrchError('CONFIRMATION_MISMATCH', '待确认计划的内容已发生变化')
      }
      if (view.launch) return { ...view.launch, replayed: true }
      if (!quality.ready) throw new OrchError('VERDICT_POLICY_UNMET', '计划质量检查存在阻断项')
      const check = withReadTx(db, ({ tx }) => {
        const meta = tx.get<{ scope: string; status: string; owner_task_id: string | null }>(
          'SELECT scope, status, owner_task_id FROM workflows WHERE workflow_id = ?', [proposal.workflow_id]) ?? null
        // 任务专属流程查固定版本：版本有没有发布由可信启动自己判（未发布版本必须报 WORKFLOW_NOT_PUBLISHED）
        const published = meta && meta.status === 'active'
          ? tx.get<PublishedRow>((meta.scope === 'task_local' ? PINNED_VERSION_SELECT : PUBLISHED_SELECT)
            + ' AND w.workflow_id = ? AND v.version = ?', [proposal.workflow_id, proposal.workflow_version])
          : undefined
        return { meta, published }
      })
      const current = check.published ? readChoice(catalog, registry, check.published) : null
      // 新根运行准入：流程被停用就拒启动，错误要和"版本不匹配"分得开
      if (check.meta !== null && check.meta.status !== 'active') {
        throw new OrchError('FORBIDDEN', 'Workflow 已停用，无法启动新任务', { workflow_id: proposal.workflow_id })
      }
      if (!current || current.hash !== row.workflow_hash || !evaluate(brief, proposal, current.workflow).ready) {
        throw new OrchError('CONFIRMATION_MISMATCH', '固定流程版本或工具授权已变化，请重新规划')
      }
      // 自动生成的是任务专属流程：只走服务端可信编排路径。
      // 任务号取自服务端落库的计划行，不来自请求体，客户端伪造不了。
      if (check.meta?.scope === 'task_local') {
        const ownerTaskId = row.owner_task_id
        if (!ownerTaskId) {
          throw new OrchError('FORBIDDEN', '任务专属流程缺少归属任务', { workflow_id: proposal.workflow_id })
        }
        const started = withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
          taskId: ownerTaskId, workflowId: proposal.workflow_id, workflowVersion: proposal.workflow_version,
          taskTitle: proposal.title, autonomy: 'supervised', operationId: row.launch_operation_id, allowReplay: true, now,
        }))
        return { task_id: started.task_id, run_id: started.run_id, replayed: started.replayed }
      }
      // The persisted operation ID is only visible here. The start receipt back-links the approved plan in the same commit as the new run.
      const started = startRun(db, catalog, { taskTitle: proposal.title, workflowId: proposal.workflow_id,
        workflowVersion: proposal.workflow_version, autonomy: 'supervised', triggerKind: 'manual', operationId: row.launch_operation_id, now })
      return { task_id: started.task_id, run_id: started.run_id, replayed: started.replayed }
    },
  }
}

export type TaskPlanningHost = ReturnType<typeof createTaskPlanningHost>

/** The executor calls this inside its dispatch transaction, after the plan was confirmed and started. */
export function getTaskPlanRecommendation(db: Db, context: ModelRoutingContext): ModelRecommendation | null {
  const row = db.raw.prepare(PLAN_SELECT + ' WHERE o.task_id = ? AND o.run_id = ?').get(context.taskId, context.runId) as PlanRow | undefined
  if (!row) return null
  const { proposal } = assertApprovedPlan(row, context.workflowId, context.workflowVersion)
  const step = proposal.steps.find((item) => item.node_id === context.nodeId)
  if (!step) throw new OrchError('CONFIRMATION_MISMATCH', '已启动计划未登记该节点的复杂度建议')
  return { complexity: step.complexity, reason: step.model_reason }
}

/** Build bounded dispatch specs using only the approved version and its current registered tools. */
export function resolveApprovedPlanNodeSpecs(
  db: Db, catalog: WorkflowCatalog, registry: ToolRegistry, run: TriggerRunReady,
): Record<string, NodeSpec> | undefined {
  return withReadTx(db, ({ tx }) => {
    const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE o.task_id = ? AND o.run_id = ?', [run.task_id, run.run_id])
    if (!row) return undefined
    const { brief, proposal } = assertApprovedPlan(row, run.workflow_id, run.workflow_version)
    // 已启动的运行只认自己固定下来的版本：流程被停用、后来又发了新版本，都不改变这次运行的绑定
    const pinned = tx.get<PublishedRow>(PINNED_VERSION_SELECT + ' WHERE w.workflow_id = ? AND v.version = ?',
      [run.workflow_id, run.workflow_version])
    const choice = pinned ? readChoiceSafe(catalog, registry, pinned) : null
    if (!choice || choice.hash !== row.workflow_hash) {
      throw new OrchError('CONFIRMATION_MISMATCH', '已批准计划的固定流程版本已不可用')
    }
    const quality = evaluate(brief, proposal, choice.workflow)
    if (!quality.ready) {
      // 工具权限被撤是运行期阻断，不能伪装成版本不匹配
      const violations = toolViolations(registry, proposal, choice.workflow)
      if (violations.length > 0) {
        throw new OrchError('TOOL_NOT_ALLOWED', '运行期工具权限已被撤销，无法继续派发', { violations })
      }
      throw new OrchError('CONFIRMATION_MISMATCH', '已批准计划的固定流程或工具授权已变化')
    }
    return Object.fromEntries(proposal.steps.map((step) => [step.node_id, {
      tools: step.tools.map((command) => ({ command, args: [], cwd: '.', timeoutMs: 15_000 })),
      input: {
        task_goal: brief.goal,
        requirements: brief.requirements.filter(({ id }) => step.goal_ids.includes(id)),
        step: step.description,
        deliverables: proposal.deliverables.filter((item) => item.node_id === step.node_id),
        risks: proposal.risks.filter((item) => item.node_id === step.node_id || item.node_id === undefined),
      },
    }]))
  })
}
