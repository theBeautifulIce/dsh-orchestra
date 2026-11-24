import { requirementsContractSchema, constraintBindingSchema, mergeRequirementsContracts, type RequirementsContract } from '../core/task-requirements.ts'
import { requirementIssues } from './task-requirement-checks.ts'
import { assertDraftActive, discardDraft, draftReferenceSchema, finishDraftRevision, readDraftEnding, type DraftRevision } from './task-plan-drafts.ts'
import { decodeCursor, encodeCursor, makeCursor } from './queries/cursor.ts'
import { textResultFileName } from './text-result.ts'
import { saveMaterials, bindMaterials, revokeMaterial, materialGrant, type PlanMaterial } from './plan-materials.ts'
import { readPlanningProgress, bindPlanningProgress } from './chat-planning-progress.ts'
import { runIdempotentCommand, requestHashOf } from './commands/idempotency.ts'
import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { assertApprovalNodeConfig, type WorkflowDefinition } from '../core/workflow-def.ts'
import { fitGeneratedWorkflowLayout, validatePublishLayer, validateSaveLayer, type PublishContext, type WorkflowDoc } from '../core/workflow-doc.ts'
import { MODEL_COMPLEXITIES, MODEL_REF_RE, selectExecutionModel,
  type ModelPlanningProfile, type ModelRecommendation, type ModelRoutingContext } from '../executor/model-routing.ts'
import type { ToolRegistry } from '../executor/tools.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { ARTIFACT_MAX_BYTES, isArtifactFileName } from './artifact-store.ts'
import { nativeTextFormat, nativeTextFormats, nativeTextLimits } from './native-text-capability.ts'
import { bindChatPlan, findChatPlan, type ChatTaskOrigin } from './chat-task-receipts.ts'
import { assertSubworkflowGraphFor } from './commands/subworkflow.ts'
import { startTrustedTaskLocalRun } from './commands/start-run.ts'
import { createWorkflow, publishContextFor, publishDraft, runtimeProjection, testWorkflowDraft } from './commands/workflows.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { createPlanningSettingsHost, withPlanningBudget, type PlanningTimeoutSnapshot } from './planning-settings.ts'
import type { NodeSpec } from './dispatcher.ts'
import type { TriggerRunReady } from './task-trigger-dispatch.ts'
import { reserveTaskInTx, createRunInTx } from './runs.ts'
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
  preferred_model_ref: z.string().regex(MODEL_REF_RE).optional(),
})
const acceptance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), file_name: z.string().trim().min(1).max(240),
    minimum_bytes: z.number().int().min(1).max(ARTIFACT_MAX_BYTES) }),
  z.strictObject({ kind: z.literal('tool_evidence'), tool: key, exit_code: z.literal(0) }),
  z.strictObject({ kind: z.literal('chat/text_result') }),
])
const legacyProposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  workflow_id: key,
  workflow_version: z.string().regex(/^[1-9]\d{0,14}$/),
  steps: z.array(stepSchema).min(1).max(100),
  deliverables: z.array(z.strictObject({ title: claim, node_id: key, goal_ids: goalIds, acceptance })).min(1).max(20),
  risks: z.array(z.strictObject({ severity: z.enum(['low', 'medium', 'high']), description: claim, mitigation: claim,
    node_id: key.optional() })).max(20),
})
const proposalSchema = legacyProposalSchema.extend({
  constraint_bindings: z.array(constraintBindingSchema).max(40).optional(),
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
  revises: draftReferenceSchema.optional(),
  requirements_contract: requirementsContractSchema.optional(),
  // 用户明确指定流程时，约束进结构化字段，而不是让主脑再猜一次（P02）。
  workflow_id: z.string().trim().min(1).max(120).optional(),
  workflow_version: z.string().regex(/^[1-9]\d{0,14}$/u).optional(),
}).refine(input => input.workflow_version === undefined || input.workflow_id !== undefined, {
  path: ['workflow_id'], message: '指定版本还需要流程 ID',
})
export const planConfirmSchema = z.strictObject({
  plan_id: z.uuidv7(), content_hash: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true),
})

export const materialGrantSchema = z.strictObject({
  operation_id: z.uuidv7(), plan_id: z.uuidv7(), content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  nodes: z.array(key).min(1).max(100),
  items: z.array(z.strictObject({ name: z.string().max(120), body: z.string().max(65536) })).min(1).max(8),
})
export const materialRevokeSchema = z.strictObject({
  plan_id: z.uuidv7(), content_hash: z.string().regex(/^[0-9a-f]{64}$/u), material_id: z.uuidv7(),
})

export type TaskPlanInput = z.infer<typeof planInputSchema>
export type TaskPlanProposal = z.infer<typeof proposalSchema>
export type PlanConfirm = z.infer<typeof planConfirmSchema>
type Goal = { id: string; text: string }
type PlanInput = { goal: string; requirements: Goal[]; workflow_id?: string; workflow_version?: string; materials?: PlanMaterial[]; requirements_contract?: RequirementsContract }
type WorkflowCandidate = {
  workflowId: string; version: string; title: string
  nodes: Array<{ id: string; type: string; title?: string; description?: string; approvalPrompt?: string; sideEffectPolicy?: string; dependsOn: string[]; toolAllow: string[]; declaredTools: string[]; subflowTools?: string[] }>
}
type PublishedChoice = { workflow: WorkflowCandidate; hash: string }
export type TaskPlanningOptions = {
  /** A tool-free adapter may interpret unstructured panel input before any plan or workflow is persisted. */
  interpret?: (input: TaskPlanInput, signal: AbortSignal, previous?: Pick<PlanInput, 'goal' | 'requirements' | 'requirements_contract' | 'workflow_id' | 'workflow_version'>) => Promise<unknown>
  propose(input: PlanInput & { workflows: WorkflowCandidate[]; model_profiles?: readonly ModelPlanningProfile[] }, signal: AbortSignal, onProgress?: () => void): Promise<unknown>
  timeoutMs?: number
  /** This planner reports nonempty provider output through onProgress. */
  streamProgress?: boolean
  /**
   * 自动生成任务专属流程的能力：没有可复用的合适流程时，由服务端生成 task_local 流程。
   * 不装配它就退回原来的口径：提示先发布至少一个可复用流程。
   */
  workflowGenerator?: (input: { goal: string; requirements_contract?: RequirementsContract }, signal: AbortSignal, onProgress?: () => void) => Promise<unknown>
  workflowStreamProgress?: boolean
  /** 运行时允许的节点类型（发布层校验用）。 */
  runtimeNodeTypes?: ReadonlySet<string>
}
const checks = ['workflow', 'coverage', 'deliverables', 'tools', 'dependencies', 'risks'] as const
type PlanCheck = (typeof checks)[number]
export type PlanQuality = { ready: boolean; checks: Array<{ check: PlanCheck; passed: boolean; issues: string[] }> }
export type TaskPlanView = {
  plan_id: string
  contract_version?: 1 | 2
  content_hash: string
  brief: PlanInput
  proposal: TaskPlanProposal
  quality: PlanQuality
  created_at: string
  material_recipients?: string[]
  material_states?: Array<{ id: string; state: 'active' | 'revoked' | 'expired'; expires_ms: number }>
  launch: { task_id: string; run_id: string } | null
  /** 自动生成的流程归属的预留任务号（只有自动生成的计划才有） */
  owner_task_id?: string | null
  /** 自动生成并发布的任务专属流程号（只有自动生成的计划才有） */
  auto_workflow_id?: string | null
}
type PlanRow = {
  contract_version: 1 | 2
  plan_id: string; input_json: string; proposal_json: string; quality_json: string; content_hash: string
  workflow_hash: string | null; launch_operation_id: string; created_at: string
  task_id: string | null; run_id: string | null
  owner_task_id: string | null; auto_workflow_id: string | null
}
const PLAN_SELECT = `SELECT p.contract_version, p.plan_id, p.input_json, p.proposal_json, p.quality_json, p.content_hash,
  p.workflow_hash, p.launch_operation_id, p.created_at, o.task_id, o.run_id,
  p.owner_task_id, p.auto_workflow_id
  FROM task_plans p LEFT JOIN start_run_operations o ON o.operation_id = p.launch_operation_id`

function toPlanView(row: PlanRow): TaskPlanView {
  if (row.contract_version !== 1 && row.contract_version !== 2) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '无法读取这份计划的需求契约版本')
  }
  const brief = JSON.parse(row.input_json) as PlanInput
  if ((row.contract_version === 2) !== (brief.requirements_contract !== undefined)) {
    throw new OrchError('CONFIRMATION_MISMATCH', '计划的需求契约与版本不一致')
  }
  if (row.contract_version === 2 && !requirementsContractSchema.safeParse(brief.requirements_contract).success) {
    throw new OrchError('CONFIRMATION_MISMATCH', '计划的结构化需求无法校验')
  }
  const proposal = (row.contract_version === 1 ? legacyProposalSchema : proposalSchema).parse(JSON.parse(row.proposal_json))
  return {
    plan_id: row.plan_id, contract_version: row.contract_version, content_hash: row.content_hash, brief, proposal,
    quality: JSON.parse(row.quality_json) as PlanQuality,
    created_at: row.created_at, launch: row.task_id && row.run_id ? { task_id: row.task_id, run_id: row.run_id } : null,
    owner_task_id: row.owner_task_id, auto_workflow_id: row.auto_workflow_id,
  }
}

type PublishedRow = { workflow_id: string; name: string; version: string; content_hash: string }
const PUBLISHED_SELECT = 'SELECT w.workflow_id, w.name, v.version, v.content_hash, v.doc_json FROM workflows w '
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

function readChoice(catalog: WorkflowCatalog, registry: ToolRegistry | undefined, row: PublishedRow, tx: ReadTx, ownerTaskId: string | null): PublishedChoice | null {
  const def = catalog.get(row.workflow_id, row.version)
  if (catalog.definitionHash(row.workflow_id, row.version) !== row.content_hash || def.nodes.length > 100) return null
  const nodes = def.nodes.map((node) => {
    const policy = catalog.toolPolicyFor(row.workflow_id, row.version, node.node_id)
    const declaredTools = [...new Set(policy.allow.filter((tool) => !policy.deny.includes(tool)))]
    return {
      id: node.node_id, type: node.type, approvalPrompt: node.approval?.prompt, sideEffectPolicy: node.side_effect_policy,
      dependsOn: (def.edges ?? []).filter((edge) => edge.to === node.node_id).map((edge) => edge.from),
      declaredTools, toolAllow: declaredTools.filter((tool) => registry?.lookup(tool)?.capability === 'read_only'),
      // 子流程声明的只读工具在计划期就摊开，便于递归校验（P06）。
      ...(node.type === 'subworkflow' && node.subworkflow
        ? { subflowTools: declaredToolsOfSubflow(tx, catalog, registry, node.subworkflow.workflow_id, node.subworkflow.pinned_version, ownerTaskId) }
        : {}),
    }
  })
  return { workflow: { workflowId: row.workflow_id, version: row.version, title: row.name, nodes }, hash: row.content_hash }
}

/** Descendant tools describe work performed by the fixed children, never by their parent control node. */
function declaredToolsOfSubflow(tx: ReadTx, catalog: WorkflowCatalog, registry: ToolRegistry | undefined,
  workflowId: string, version: number, ownerTaskId: string | null): string[] {
  const ref = { workflowId, pinnedVersion: version }
  assertSubworkflowGraphFor(catalog, ref, { requirePublished: true, rootDepth: 1 })
  const found = new Set<string>()
  const visited = new Set<string>()
  function collect(id: string, pin: number): void {
    const key = JSON.stringify([id, pin])
    if (visited.has(key)) return
    visited.add(key)
    const target = tx.get<{ scope: string; owner_task_id: string | null }>(
      'SELECT w.scope, w.owner_task_id FROM workflows w JOIN workflow_versions v USING(workflow_id) '
      + 'WHERE w.workflow_id=? AND v.version=? AND v.published_by IS NOT NULL', [id, String(pin)])
    if (!target) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '找不到已发布的子流程固定版本')
    if (target.scope === 'task_local' && (!ownerTaskId || ownerTaskId !== target.owner_task_id)) {
      throw new OrchError('FORBIDDEN', '该子流程属于另一项任务')
    }
    for (const n of catalog.get(id, pin).nodes) {
      if (n.subworkflow) collect(n.subworkflow.workflow_id, n.subworkflow.pinned_version)
      const policy = catalog.toolPolicyFor(id, pin, n.node_id)
      for (const tool of policy.allow) {
        if (policy.deny.includes(tool)) continue
        if (registry?.lookup(tool)?.capability !== 'read_only') {
          throw new OrchError('TOOL_NOT_ALLOWED', '子流程工具未登记为只读', { workflow_id: id, tool })
        }
        found.add(tool)
      }
    }
  }
  collect(workflowId, version)
  return [...found].sort()
}

/** 版本没加载过时按"固定版本不可用"处理，不让内部错误码漏给调用方 */
function readChoiceSafe(catalog: WorkflowCatalog, registry: ToolRegistry | undefined, row: PublishedRow, tx: ReadTx, ownerTaskId: string | null): PublishedChoice | null {
  try {
    return readChoice(catalog, registry, row, tx, ownerTaskId)
  } catch (error) {
    if (error instanceof OrchError && [
      'NOT_FOUND', 'WORKFLOW_NOT_PUBLISHED', 'TOOL_NOT_ALLOWED', 'FORBIDDEN',
      'WORKFLOW_SUBWORKFLOW_VERSION_MISSING', 'SUBWORKFLOW_DEPTH_EXCEEDED', 'SUBWORKFLOW_CYCLE',
    ].includes(error.code)) return null
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

function requestedApprovalSteps(brief: PlanInput): string[] {
  const namedApprovals = [brief.goal, ...brief.requirements.map((item) => item.text)].flatMap((text) =>
    [...text.matchAll(/(?:^|[，,。；;\n])\s*(?:请\s*)?(?:设置|添加|加入|安排|设立|创建|新增)(?:\s*(?:一个|一道))?(?:\s*独立的?)?\s*人工审批(?:步骤|节点)\s*[「“]([^」”\r\n]{1,80})[」”]/gu)]
      .map((match) => match[1]!.trim()).filter(Boolean))
  return [...new Set(namedApprovals)]
}

function missingApprovalSteps(namedApprovals: string[], workflow: WorkflowCandidate): string[] {
  if (!namedApprovals.length) return []
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const ancestors = new Set<string>()
  const pending = workflow.nodes.filter((node) => node.type === 'agent').flatMap((node) => node.dependsOn)
  while (pending.length) {
    const id = pending.pop()!
    if (ancestors.has(id)) continue
    ancestors.add(id)
    pending.push(...(nodes.get(id)?.dependsOn ?? []))
  }
  return namedApprovals.filter((name) => !workflow.nodes.some((node) =>
    node.type === 'approval' && node.approvalPrompt === name && ancestors.has(node.id)))
}

// 个人宿主的原生生产器只写 UTF-8 文本。能力声明收敛到 native-text-capability，
// 计划、确认启动与原生发布共用同一份，避免三处各列一张黑名单（D01/D02）。
export const NATIVE_PRODUCER = {
  files_per_node: nativeTextLimits.files,
  bytes_per_file: nativeTextLimits.bytes,
  supported_formats: nativeTextFormats(),
} as const

/** 交付能力核对：格式、单份字节与同一节点的件数都要是当前宿主真能产出的。 */
export function deliveryCapabilityIssues(deliverables: readonly { node_id: string; acceptance: { kind: string; file_name?: string; minimum_bytes?: number } }[]): string[] {
  const issues: string[] = []
  // 件数按不同文件名去重后按节点统计；会话正文按交付项独立计数（D02）。
  const perNode = new Map<string, { files: Set<string>; texts: number }>()
  for (const [index,item] of deliverables.entries()) {
    const rule = item.acceptance
    if (rule.kind !== 'artifact' && rule.kind !== 'chat/text_result') continue
    const slot = perNode.get(item.node_id) ?? { files: new Set<string>(), texts: 0 }
    perNode.set(item.node_id, slot)
    if (rule.kind === 'chat/text_result') {
      slot.texts += 1
      if (deliverables.some(other=>other.node_id===item.node_id && other.acceptance.kind==='artifact'
        && other.acceptance.file_name===textResultFileName(index))) {
        issues.push(`「${textResultFileName(index)}」用于本步骤的会话正文，请为普通文件另取名称。`)
      }
      continue
    }
    if (!rule.file_name) continue
    slot.files.add(rule.file_name)
    if (!nativeTextFormat(rule.file_name)) {
      issues.push(`「${rule.file_name}」不是当前宿主能写出的文本格式。请改成 ${NATIVE_PRODUCER.supported_formats.slice(0, 4).join('、')} 等已登记格式，或改用工具执行证据验收。`)
    }
    const minimum = rule.minimum_bytes ?? 0
    if (minimum > nativeTextLimits.bytes) {
      issues.push(`「${rule.file_name}」要求至少 ${minimum} 字节，当前宿主单份文本最多 ${nativeTextLimits.bytes} 字节。请拆成多份或降低字节要求。`)
    }
  }
  for (const [nodeId, slot] of perNode) {
    if (slot.files.size > nativeTextLimits.files) {
      issues.push(`${nodeId} 需要 ${slot.files.size} 份不同文件，当前宿主同一节点最多交付 ${nativeTextLimits.files} 份。请拆到多个步骤。`)
    }
    if (slot.texts > nativeTextLimits.files) {
      issues.push(`${nodeId} 安排了 ${slot.texts} 段会话正文，当前宿主同一节点最多交付 ${nativeTextLimits.files} 段。请拆到多个步骤。`)
    }
  }
  return issues
}

function evaluate(brief: PlanInput, proposal: TaskPlanProposal, workflow: WorkflowCandidate | undefined): PlanQuality {
  const issues: Record<PlanCheck, string[]> = {
    workflow: [], coverage: [], deliverables: [], tools: [], dependencies: [], risks: [],
  }
  if (brief.workflow_id !== undefined
    && (proposal.workflow_id !== brief.workflow_id
      || (brief.workflow_version !== undefined && proposal.workflow_version !== brief.workflow_version))) {
    issues.workflow.push('计划没有使用你指定的流程版本，请重新规划。')
  }
  if (!workflow) issues.workflow.push('候选未选中本次提供的活跃、已发布流程版本。')
  else if (!brief.requirements_contract) for (const name of missingApprovalSteps(requestedApprovalSteps(brief), workflow)) {
    issues.dependencies.push(`缺少作为执行前置条件的人工审批「${name}」。请检查流程后重新规划。`)
  }
  const goals = [{ id: 'goal', text: brief.goal }, ...brief.requirements]
  const prohibitsWritingFiles = !brief.requirements_contract && goals.some(({ text }) => /(?:^|[，,。；;\n])\s*(?:不要|不得|不允许|禁止)\s*(?:读写|写入|写出|写|生成|创建)\s*(?:任何\s*)?文件/u.test(text))
  if (prohibitsWritingFiles && proposal.deliverables.some(({ acceptance }) => acceptance.kind === 'artifact')) {
    issues.deliverables.push('任务要求不写文件，但计划安排了文件交付。请调整交付方式后重新规划。')
  }
  if (brief.requirements_contract && workflow) {
    issues.dependencies.push(...requirementIssues(brief.requirements_contract, proposal, workflow.nodes))
  }
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
    if (node?.type === 'subworkflow' && step.tools.length) {
      issues.tools.push(step.node_id + ' 是调度子流程的控制步骤，不直接执行工具；请将该步骤的 tools 留空。')
    }
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
  issues.deliverables.push(...deliveryCapabilityIssues(proposal.deliverables))
  for (const goal of goals) {
    if (!proposal.steps.some((step) => step.goal_ids.includes(goal.id))
      || !proposal.deliverables.some((item) => item.goal_ids.includes(goal.id))) {
      issues.coverage.push(goal.id + ' 缺少执行步骤或可核验交付物。')
    }
  }
  for (const risk of proposal.risks) {
    if (risk.severity === 'high') issues.risks.push(`执行条件未满足：${risk.description}；处理方式：${risk.mitigation}`)
    if (risk.node_id !== undefined && !steps.has(risk.node_id)) issues.risks.push('风险引用了不存在的计划步骤。')
  }
  const results = checks.map((check) => ({ check, passed: issues[check].length === 0, issues: [...new Set(issues[check])] }))
  return { ready: results.every((result) => result.passed), checks: results }
}

function planHash(view: Pick<TaskPlanView, 'brief' | 'proposal' | 'quality'>, workflowHash: string | null,
  version: 1 | 2 = view.brief.requirements_contract ? 2 : 1): string {
  return sha256Hex(canonicalJson({ schema: version, ...view, workflow_hash: workflowHash }))
}

function assertApprovedPlan(row: PlanRow, workflowId: string | null, workflowVersion: string | null): TaskPlanView {
  const view = toPlanView(row)
  const { brief, proposal, quality } = view
  if (!quality.ready || proposal.workflow_id !== workflowId || proposal.workflow_version !== workflowVersion
    || row.content_hash !== planHash({ brief, proposal, quality }, row.workflow_hash, row.contract_version)) {
    throw new OrchError('CONFIRMATION_MISMATCH', '已启动任务的规划内容或固定流程绑定不符')
  }
  return view
}

/** Exact artifact obligations of a started, approved task step with no planned tools. */
export function approvedArtifactRequirements(tx: ReadTx, runId: string, nodeId: string) {
  const run = tx.get<{ task_id: string; workflow_id: string; version: string; workflow_definition_hash: string }>(
    'SELECT task_id,workflow_id,CAST(workflow_version AS TEXT) AS version,workflow_definition_hash FROM runs WHERE run_id=?', [runId],
  )
  if (!run?.workflow_definition_hash) return null
  const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE o.run_id=? AND o.task_id=?', [runId, run.task_id])
  if (!row || row.workflow_hash !== run.workflow_definition_hash) return null
  try {
    const { proposal } = assertApprovedPlan(row, run.workflow_id, run.version)
    const step = proposal.steps.find((item) => item.node_id === nodeId)
    if (!step || step.tools.length > 0) return null
    const rules: Array<{ file_name: string; minimum_bytes: number; textIndex?: number }> = []
    for (const [index, item] of proposal.deliverables.entries()) {
      if (item.node_id !== nodeId) continue
      if (item.acceptance.kind === 'artifact') rules.push(item.acceptance)
      else if (item.acceptance.kind === 'chat/text_result') {
        rules.push({ file_name: textResultFileName(index), minimum_bytes: 1, textIndex: index })
      } else return null
    }
    if (!rules.length) return null
    return { planId: row.plan_id, contentHash: row.content_hash, rules }
  } catch {
    return null
  }
}

const GENERATED_NODE_TYPES = new Set(['trigger', 'agent', 'wait', 'approval'])
/** 默认运行时允许的节点类型（发布层校验用） */
const DEFAULT_RUNTIME_NODE_TYPES: ReadonlySet<string> = new Set(['agent', 'wait', 'approval'])

const generatedDocSchema = z.object({
  name: z.string().trim().min(1).max(80),
  nodes: z.array(z.object({
    node_id: z.string().trim().min(1).max(64),
    type: z.string().trim().min(1).max(32).optional(),
    title: z.string().trim().max(80).optional(),
    position: z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) }).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    contract: z.object({ description: z.string().trim().min(1).max(2000).optional() }).optional(),
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

/** 把主脑给的流程草案整理成可保存、可发布的流程文档 */
function buildAutoDoc(draft: unknown, registry: ToolRegistry | undefined, runtimeNodeTypes: ReadonlySet<string>): WorkflowDoc {
  const parsed = generatedDocSchema.safeParse(fitGeneratedWorkflowLayout(draft))
  if (!parsed.success) {
    const { issues } = parsed.error
    const layoutOnly = issues.length > 0 && issues.every(({ path }) => {
      const [nodes, index, position, axis] = path
      return nodes === 'nodes' && typeof index === 'number' && position === 'position'
        && (path.length === 3 || (path.length === 4 && (axis === 'x' || axis === 'y')))
    })
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程不符合约定结构', {
      fields: issues.slice(0, 12).map((issue) => issue.path.join('.')),
      ...(layoutOnly && { planning_issue: 'layout' }),
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
    if (type === 'approval') {
      const approval = node.config
      assertApprovalNodeConfig(approval)
      Object.assign(config, { prompt: approval.prompt.trim(), on_timeout: approval.on_timeout })
    }
    if (type === 'agent') {
      const tools = allowedReadOnlyTools(node.config, registry)
      config.side_effect_policy = 'pure'
      if (tools.length > 0) config.tools = { allow: tools }
    }
    nodes.push({
      node_id: id, type,
      title: node.title && node.title.length > 0 ? node.title : id,
      position: node.position ?? { x: 100 * (index + 1), y: 0 },
      config,
      ...(node.contract?.description ? { contract: { description: node.contract.description } } : {}),
    })
  })
  // 恰好一个 trigger：多了丢掉多余的，少了补一个起点
  const triggers = nodes.filter((node) => node.type === 'trigger')
  for (const extra of triggers.slice(1)) nodes.splice(nodes.indexOf(extra), 1)
  const inferredTrigger = triggers.length === 0 ? sanitizeNodeId('start', used) : null
  if (inferredTrigger) nodes.unshift({ node_id: inferredTrigger, type: 'trigger', title: '开始', position: { x: 0, y: 0 }, config: {} })
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
  if (inferredTrigger) {
    const incoming = new Set(edges.map((edge) => edge.to))
    for (const node of nodes) {
      if (node.node_id !== inferredTrigger && !incoming.has(node.node_id)) edges.push({ from: inferredTrigger, to: node.node_id })
    }
  }
  const doc: WorkflowDoc = { name: source.name, nodes, edges }
  const saved = validateSaveLayer(doc, { expectedName: source.name })
  if (saved.report.errors.length > 0) {
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程没有通过保存层校验', {
      fields: saved.report.errors.slice(0, 12).map((issue) => issue.path + ': ' + issue.code),
    })
  }
  const ctx: PublishContext = { registeredNodeTypes: runtimeNodeTypes, publishedVersions: () => true }
  const issues = validatePublishLayer(doc, ctx)
  if (issues.length > 0) {
    throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑生成的流程无法发布，请检查步骤和依赖', { issues: issues.slice(0, 12) })
  }
  return doc
}

/** 运行时投影 → 规划器看到的候选流程 */
function candidateFromRuntime(def: WorkflowDefinition, doc: WorkflowDoc, registry: ToolRegistry | undefined): WorkflowCandidate {
  const docs = new Map(doc.nodes.map((node) => [node.node_id, node]))
  const nodes = def.nodes.map((node) => {
    const deny = node.tools?.deny ?? []
    const allow = [...new Set((node.tools?.allow ?? []).filter((tool) => !deny.includes(tool)))]
    return {
      id: node.node_id, type: node.type,
      approvalPrompt: node.approval?.prompt,
      sideEffectPolicy: node.side_effect_policy,
      title: docs.get(node.node_id)?.title,
      description: docs.get(node.node_id)?.contract?.description as string | undefined,
      dependsOn: (def.edges ?? []).filter((edge) => edge.to === node.node_id).map((edge) => edge.from),
      declaredTools: allow,
      toolAllow: allow.filter((tool) => registry?.lookup(tool)?.capability === 'read_only'),
    }
  })
  return { workflowId: def.workflow_id ?? '', version: String(def.workflow_version), title: doc.name, nodes }
}

export async function callPlanningStage<T>(run: (signal: AbortSignal, onProgress?: () => void) => Promise<T>, caller: AbortSignal | undefined,
  messages: { timeout: string; failure: string }, maximumMs = 120_000, idleMs: number | null = 30_000): Promise<T> {
  caller?.throwIfAborted()
  const controller = new AbortController()
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
  const expire = (boundary: 'inactivity' | 'maximum') => controller.abort(new OrchError('OPERATION_TIMEOUT', messages.timeout, { boundary }))
  const maximum = setTimeout(() => expire('maximum'), maximumMs)
  const idle = idleMs === null ? undefined : setTimeout(() => expire('inactivity'), idleMs)
  maximum.unref()
  idle?.unref()
  let onAbort: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const operation = idle ? run(signal, () => { if (!signal.aborted) idle.refresh() }) : run(signal)
    const value = await Promise.race([operation, stopped])
    signal.throwIfAborted()
    return value
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof OrchError) throw error
    throw new OrchError('SERVICE_UNAVAILABLE', messages.failure)
  } finally {
    clearTimeout(maximum)
    clearTimeout(idle)
    signal.removeEventListener('abort', onAbort)
  }
}

export function createTaskPlanningHost(db: Db, catalog: WorkflowCatalog, registry: ToolRegistry | undefined,
  options?: TaskPlanningOptions, planningProfiles?: () => readonly ModelPlanningProfile[] | Promise<readonly ModelPlanningProfile[]>,
  readTimeouts = createPlanningSettingsHost(db, {
    task: options ? options.streamProgress ? 'streaming' : 'fixed' : 'unavailable',
    automatic_workflow: options?.workflowGenerator ? options.workflowStreamProgress ? 'streaming' : 'fixed' : 'unavailable',
    standalone_workflow: 'unavailable',
  }, options?.timeoutMs).snapshot) {
  withTx(db,tx=>tx.run("UPDATE chat_planning_progress SET stage='failed' WHERE stage='planning'"))
  const explicitTimeout = options?.timeoutMs
  if (explicitTimeout !== undefined && (!Number.isSafeInteger(explicitTimeout) || explicitTimeout < 1000 || explicitTimeout > 120_000)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑规划时限必须在 1 到 120 秒之间')
  }
  const viewOf = (row: PlanRow, tx: ReadTx, timestamp = Date.now()): TaskPlanView => {
    const view = toPlanView(row)
    view.material_states = (view.brief.materials ?? []).map(material => {
      const stored = tx.get<{ revoked: number; expires_ms: number }>(
        'SELECT revoked,expires_ms FROM plan_materials WHERE id=?', [material.id])
      return { id: material.id, expires_ms: stored?.expires_ms ?? material.expires_ms,
        state: !stored || stored.revoked ? 'revoked' : stored.expires_ms <= timestamp ? 'expired' : 'active' }
    })
    try {
      const definition = catalog.get(view.proposal.workflow_id, view.proposal.workflow_version)
      view.material_recipients = definition.nodes.filter(node => node.type === 'agent').map(node => node.node_id)
    } catch (error) {
      if (!(error instanceof OrchError) || error.code !== 'NOT_FOUND' || view.quality.ready) throw error
      view.material_recipients = []
    }
    return view
  }
  const get = (planId: string, actor: string) => withReadTx(db, ({ tx, as_of_seq }) => {
    const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE p.plan_id = ? AND p.created_by = ?', [planId, actor])
    if (!row) throw new OrchError('NOT_FOUND', '没有对应的任务计划')
    return { row, view: viewOf(row, tx), as_of_seq }
  })
  /** 主脑提案：完整提案，或者显式的「没有可用候选」信号 */
  const askPlanner = async (brief: PlanInput, workflows: WorkflowCandidate[], budget: PlanningTimeoutSnapshot, caller: AbortSignal): Promise<PlannerOutcome> => {
    const planner = options?.propose
    if (!planner) throw new OrchError('VERDICT_UNSUPPORTED', 'DSH 宿主尚未装配主脑规划服务')
    const profiles = await planningProfiles?.() ?? []
    const offered = structuredClone({ ...brief, workflows, ...(profiles.length > 0 ? { model_profiles: profiles } : {}) })
    const candidate = await callPlanningStage(
      (signal, onProgress) => onProgress ? planner(offered, signal, onProgress) : planner(offered, signal), caller,
      { timeout: '主脑没有在时限内生成计划', failure: '主脑暂时未能产出计划' },
      options?.streamProgress ? budget.taskStage : budget.task, options?.streamProgress ? budget.idle : null,
    )
    const parsed = (brief.requirements_contract ? proposalSchema : legacyProposalSchema).safeParse(candidate)
    if (parsed.success) {
      for (const step of parsed.data.steps) {
        if (step.preferred_model_ref === undefined) continue
        selectExecutionModel(profiles, { complexity: step.complexity, reason: step.model_reason,
          preferredModel: step.preferred_model_ref })
      }
      return { kind: 'proposal', proposal: parsed.data }
    }
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
  const proposeAuto = async (brief: PlanInput, actor: string, now: string, budget: PlanningTimeoutSnapshot, caller: AbortSignal, origin?: ChatTaskOrigin, revision?: DraftRevision): Promise<ReturnType<typeof get>> => {
    const generator = options?.workflowGenerator
    if (!generator) {
      throw new OrchError('VERDICT_UNSUPPORTED', '主脑判定没有可用流程，但服务端没有装配流程生成能力')
    }
    const runtimeNodeTypes = options?.runtimeNodeTypes ?? DEFAULT_RUNTIME_NODE_TYPES
    const goal = [brief.goal, ...brief.requirements.map((item) => item.text)].join('；')
    const generationInput = { goal, ...(brief.requirements_contract && { requirements_contract: brief.requirements_contract }) }
    // 1) 主脑出流程草案：放在事务外，主脑耗时不能占着写锁
    const draft = await callPlanningStage(
      (signal, onProgress) => onProgress ? generator(generationInput, signal, onProgress) : generator(generationInput, signal), caller,
      { timeout: '主脑没有在时限内生成流程', failure: '主脑暂时未能生成流程' },
      options?.workflowStreamProgress ? budget.taskStage : budget.task, options?.workflowStreamProgress ? budget.idle : null,
    )
    const doc = buildAutoDoc(draft, registry, runtimeNodeTypes)
    const workflowId = 'tl_' + uuidv7().replace(/-/g, '')
    const runtime = runtimeProjection(workflowId, '1', doc)
    const workflowHash = definitionHashOf(runtime)
    const autoCandidate = candidateFromRuntime(runtime, doc, registry)
    // 2) 再让主脑基于新生成的流程产出一份完整计划（steps / deliverables / risks）
    const outcome = await askPlanner(brief, [autoCandidate], budget, caller)
    if (outcome.kind !== 'proposal') {
      throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑没有基于新生成的流程产出完整计划')
    }
    const { proposal } = outcome
    if (proposal.workflow_id !== autoCandidate.workflowId || proposal.workflow_version !== autoCandidate.version) {
      throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑返回的计划没有选择本次生成的流程版本')
    }
    const quality = evaluate(brief, proposal, autoCandidate)
    const hash = planHash({ brief, proposal, quality }, workflowHash)
    const version = brief.requirements_contract ? 2 : 1
    const id = uuidv7()
    caller?.throwIfAborted()
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
      tx.run('INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, content_hash, launch_operation_id, created_at, owner_task_id, auto_workflow_id, contract_version)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, actor, JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), workflowHash, hash, uuidv7(), now, reserved.task_id, workflowId, version])
      finishDraftRevision(tx, revision, id, actor, now)
      bindChatPlan(tx, origin, id)
      if (origin) bindPlanningProgress(tx, origin.requestKey, id, proposal.title, Date.parse(now))
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
  const propose = async (input: TaskPlanInput, actor: string, now: string, requestSignal?: AbortSignal, origin?: ChatTaskOrigin) => {
      const callerSignal = requestSignal && origin ? AbortSignal.any([requestSignal, origin.signal]) : requestSignal ?? origin?.signal
      callerSignal?.throwIfAborted()
      origin?.assertCurrent()
      const existing = origin && findChatPlan(db, origin)
      if (existing) return get(existing, actor)
      const parsedInput = planInputSchema.safeParse(input)
      if (!parsedInput.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '任务需求格式不正确', {
        fields: parsedInput.error.issues.slice(0, 12).map(issue => issue.path.join('.')),
      })
      input = parsedInput.data
      let previous: Pick<PlanInput, 'goal' | 'requirements' | 'requirements_contract' | 'workflow_id' | 'workflow_version'> | undefined
      const revision = input.revises ? { reference: input.revises,
        requestHash: requestHashOf('task_plan.revise', input) } : undefined
      if (revision) {
        const end = withReadTx(db, ({ tx }) => {
          const ending = readDraftEnding(tx, revision.reference, actor)
          if (!ending) assertDraftActive(tx, revision.reference, actor)
          return ending
        })
        if (end) {
          if (end.successor_id && end.request_hash === revision.requestHash) return get(end.successor_id, actor)
          throw new OrchError('CONFIRMATION_MISMATCH', '这份计划已调整或放弃，请读取当前计划')
        }
        const original = get(revision.reference.plan_id, actor).view.brief
        previous = { goal: original.goal, requirements: original.requirements,
          ...(original.workflow_id && { workflow_id: original.workflow_id }),
          ...(original.workflow_version && { workflow_version: original.workflow_version }),
          ...(original.requirements_contract && { requirements_contract: original.requirements_contract }) }
        if (original.requirements_contract && !input.requirements_contract && !options?.interpret) {
          throw new OrchError('PAYLOAD_SCHEMA_INVALID', '调整这份计划需要完整的结构化约束，请保留或明确更新原要求')
        }
      }
      if (!options?.propose) throw new OrchError('VERDICT_UNSUPPORTED', 'DSH 宿主尚未装配主脑规划服务')
      const budget = readTimeouts()
      return withPlanningBudget(budget.request, callerSignal, async (caller) => {
        let normalized = input
        if (!input.requirements_contract && options.interpret) {
          const interpreted = await callPlanningStage(signal => options.interpret!(structuredClone(input), signal, previous && structuredClone(previous)), caller,
            { timeout: '需求解释超过处理时限', failure: '暂时未能解释任务需求' }, budget.task)
          const result = planInputSchema.safeParse(interpreted)
          if (!result.success || !result.data.requirements_contract) {
            throw new OrchError('PAYLOAD_SCHEMA_INVALID', '需求解释缺少完整的结构化约束，请补充后重新规划')
          }
          if ((input.workflow_id !== undefined && result.data.workflow_id !== input.workflow_id)
            || (input.workflow_version !== undefined && result.data.workflow_version !== input.workflow_version)) {
            throw new OrchError('CONFIRMATION_MISMATCH', '面板选择的流程与文字需求中的流程不一致，请确认具体版本')
          }
          normalized = result.data
        }
        if (previous?.requirements_contract) {
          const next = normalized.requirements_contract ?? previous.requirements_contract
          try {
            normalized = { ...normalized, requirements_contract: mergeRequirementsContracts(previous.requirements_contract, next) }
          } catch {
            throw new OrchError('PAYLOAD_SCHEMA_INVALID', '修订需求的来源或约束不一致，请重新核对原要求')
          }
        }
        if ((previous?.workflow_id && normalized.workflow_id && previous.workflow_id !== normalized.workflow_id)
          || (previous?.workflow_version && normalized.workflow_version && previous.workflow_version !== normalized.workflow_version)) {
          throw new OrchError('CONFIRMATION_MISMATCH', '修订须保留已明确指定的流程版本，改变流程请新建任务并重新确认')
        }
        normalized = { ...normalized,
          ...(previous?.workflow_id && { workflow_id: previous.workflow_id }),
          ...(previous?.workflow_version && { workflow_version: previous.workflow_version }) }
        const brief: PlanInput = { goal: normalized.goal, requirements: normalized.requirements.map((text, index) => ({ id: 'R' + (index + 1), text })),
          ...(normalized.workflow_id === undefined ? {} : { workflow_id: normalized.workflow_id }),
          ...(normalized.workflow_version === undefined ? {} : { workflow_version: normalized.workflow_version }),
          ...(normalized.requirements_contract && { requirements_contract: normalized.requirements_contract }) }
        // 候选检索：先捞一个较大的池子，再按任务适配性排序，最后才截断
        const choices = withReadTx(db, ({ tx }) => {
          const rows = brief.workflow_id
            ? tx.all<CandidateRow>(PUBLISHED_SELECT + ' AND w.workflow_id = ? AND v.version = '
              + (brief.workflow_version ? '?' : 'CAST(w.current_version AS TEXT)'),
              brief.workflow_version ? [brief.workflow_id, brief.workflow_version] : [brief.workflow_id])
            : tx.all<CandidateRow>(CANDIDATE_SELECT)
          const tokens = goalTokens(brief)
          const approvals = brief.requirements_contract ? [] : requestedApprovalSteps(brief)
          const scored = rows.flatMap((row) => {
            const choice = brief.workflow_id ? readChoice(catalog, registry, row, tx, null)
              : readChoiceSafe(catalog, registry, row, tx, null)
            return choice && missingApprovalSteps(approvals, choice.workflow).length === 0
              ? [{ choice, score: relevanceScore(tokens, row) }]
              : []
          })
          scored.sort((left, right) => right.score - left.score
            || compareWorkflowIds(left.choice.workflow.workflowId, right.choice.workflow.workflowId))
          // 指定了流程就只在这个流程（及版本）里选，不把别候选混进池子（P02）。
          const pinned = brief.workflow_id === undefined ? scored : scored.filter((item) =>
            item.choice.workflow.workflowId === brief.workflow_id
            && (brief.workflow_version === undefined || item.choice.workflow.version === brief.workflow_version))
          return pinned.slice(0, CANDIDATE_LIMIT).map((item) => item.choice)
        })
        if (brief.workflow_id !== undefined && choices.length === 0) {
          throw new OrchError('WORKFLOW_NOT_PUBLISHED', '你指定的流程没有可用的已发布版本，请确认流程名与版本', {
            workflow_id: brief.workflow_id, workflow_version: brief.workflow_version ?? null,
          })
        }
        // 候选池里一个都没有：走自动生成；没有生成能力就还是让调用方先去发布流程
        if (choices.length === 0) {
          if (!options.workflowGenerator) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '请先发布至少一个可复用流程')
          return proposeAuto(brief, actor, now, budget, caller, origin, revision)
        }
        const outcome = await askPlanner(brief, choices.map((item) => item.workflow), budget, caller)
        // 主脑判定候选池里没有一个适合这次任务：走同一条自动生成路径
        if (outcome.kind === 'no_candidate') {
          if (brief.workflow_id) throw new OrchError('VERDICT_POLICY_UNMET', '所选固定流程不适用于本次目标，请调整目标或另选流程')
          return proposeAuto(brief, actor, now, budget, caller, origin, revision)
        }
        const proposal = outcome.proposal
        const selected = choices.find(({ workflow }) => workflow.workflowId === proposal.workflow_id && workflow.version === proposal.workflow_version)
        if (brief.workflow_id && !selected) {
          throw new OrchError('WORKFLOW_DEFINITION_INVALID', '规划器未使用指定的固定流程版本')
        }
        const quality = evaluate(brief, proposal, selected?.workflow)
        const workflowHash = selected?.hash ?? null
        const hash = planHash({ brief, proposal, quality }, workflowHash)
        const version = brief.requirements_contract ? 2 : 1
        const id = uuidv7()
        caller.throwIfAborted()
        withTx(db, (tx) => {
          tx.run('INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, content_hash, launch_operation_id, created_at, owner_task_id, auto_workflow_id, contract_version)'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
            [id, actor, JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), workflowHash, hash, uuidv7(), now, version])
          finishDraftRevision(tx, revision, id, actor, now)
          bindChatPlan(tx, origin, id)
          if (origin) bindPlanningProgress(tx, origin.requestKey, id, proposal.title, Date.parse(now))
          appendEvent(tx, { type: 'task_plan.proposed', payload: { plan_id: id, content_hash: hash, quality_ready: quality.ready } })
        })
        return get(id, actor)
      })
  }
  const launch = (planId: string, contentHash: string, actor: string, now: string, chat?: {
    origin: ChatTaskOrigin
    nativeApproval: boolean
  }) => {
      const { row, view } = get(planId, actor)
      const { brief, proposal, quality } = view
      if (contentHash !== row.content_hash || row.content_hash !== planHash({ brief, proposal, quality }, row.workflow_hash, row.contract_version)) {
        throw new OrchError('CONFIRMATION_MISMATCH', '待确认计划的内容已发生变化')
      }
      if (view.launch) return { ...view.launch, replayed: true }
      if (row.contract_version === 1 && options?.interpret) {
        throw new OrchError('CONFIRMATION_REQUIRED', '旧计划未保存结构化需求，请重新规划并确认执行范围')
      }
      withReadTx(db, ({ tx }) => assertDraftActive(tx, { plan_id: planId, content_hash: contentHash }, actor))
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
      const current = check.published ? withReadTx(db, ({ tx }) =>
        readChoice(catalog, registry, check.published!, tx, row.owner_task_id)) : null
      // 新根运行准入：流程被停用就拒启动，错误要和"版本不匹配"分得开
      if (check.meta !== null && check.meta.status !== 'active') {
        throw new OrchError('FORBIDDEN', 'Workflow 已停用，无法启动新任务', { workflow_id: proposal.workflow_id })
      }
      if (!current || current.hash !== row.workflow_hash || !evaluate(brief, proposal, current.workflow).ready) {
        throw new OrchError('CONFIRMATION_MISMATCH', '固定流程版本或工具授权已变化，请重新规划')
      }
      if (chat) {
        chat.origin.assertCurrent()
        if (findChatPlan(db, chat.origin) !== planId) throw new OrchError('FORBIDDEN', '计划与当前会话消息的绑定不一致')
        const definition = catalog.get(proposal.workflow_id, proposal.workflow_version)
        if (brief.requirements_contract?.start_policy === 'plan_only') {
          throw new OrchError('CONFIRMATION_REQUIRED', '这份计划只供预览，请在面板确认后启动')
        }
        const requiresContractApproval = brief.requirements_contract?.constraints.some(constraint => constraint.kind === 'approval_before' && constraint.scope === 'task')
        const needsApproval = definition.nodes.some((node) => node.side_effect_policy === 'irreversible'
          || node.side_effect_policy === 'compensable' || (node.type !== 'agent' && node.type !== 'wait'))
        if ((needsApproval || requiresContractApproval || Boolean(brief.materials?.length)) && !chat.nativeApproval) throw new OrchError('CONFIRMATION_REQUIRED', '此工作流需要在当前会话中批准后才能启动')
      }
      // 自动生成的是任务专属流程：只走服务端可信编排路径。
      // 任务号取自服务端落库的计划行，不来自请求体，客户端伪造不了。
      if (check.meta?.scope === 'task_local') {
        const ownerTaskId = row.owner_task_id
        if (!ownerTaskId) {
          throw new OrchError('FORBIDDEN', '任务专属流程缺少归属任务', { workflow_id: proposal.workflow_id })
        }
        const started = withTx(db, (tx) => {
          const prior = tx.get<{ task_id: string; run_id: string }>(
            'SELECT task_id,run_id FROM start_run_operations WHERE operation_id=?', [row.launch_operation_id])
          if (prior) return { ...prior, replayed: true }
          assertDraftActive(tx, { plan_id: planId, content_hash: contentHash }, actor)
          const result = startTrustedTaskLocalRun(tx, catalog, {
            taskId: ownerTaskId, workflowId: proposal.workflow_id, workflowVersion: proposal.workflow_version,
            taskTitle: proposal.title, autonomy: 'supervised', triggerKind: 'manual', operationId: row.launch_operation_id,
            allowReplay: true, now,
          })
          for (const material of brief.materials ?? []) bindMaterials(tx, materialGrant(actor, material.draft),
            [material], result.run_id, Date.parse(now))
          return result
        })
        return { task_id: started.task_id, run_id: started.run_id, replayed: started.replayed }
      }
      // The persisted operation ID is only visible here. The start receipt back-links the approved plan in the same commit as the new run.
      const params = { taskTitle: proposal.title, workflowId: proposal.workflow_id,
        workflowVersion: proposal.workflow_version, autonomy: 'supervised' as const, triggerKind: 'manual' as const,
        operationId: row.launch_operation_id, now }
      catalog.requireWorkflowCapability(proposal.workflow_id)
      const started = withTx(db, tx => {
        const prior = tx.get<{ task_id: string; run_id: string }>(
          'SELECT task_id,run_id FROM start_run_operations WHERE operation_id=?', [row.launch_operation_id])
        if (prior) return { ...prior, replayed: true }
        assertDraftActive(tx, { plan_id: planId, content_hash: contentHash }, actor)
        const result = createRunInTx(tx, catalog, params)
        for (const material of brief.materials ?? []) bindMaterials(tx, materialGrant(actor, material.draft),
          [material], result.run_id, Date.parse(now))
        return { ...result, replayed: false }
      })
      return { task_id: started.task_id, run_id: started.run_id, replayed: started.replayed }
  }
  return {
    enabled: options !== undefined,
    get requestTimeoutMs() { return readTimeouts().request },
    get,
    progress(actor: string, since = Date.now() - 24*60*60_000) {
      return withReadTx(db, ({ tx, as_of_seq }) => ({ items: readPlanningProgress(tx, actor, since), as_of_seq }))
    },
    grantMaterials(input: z.infer<typeof materialGrantSchema>, actor: string, now: string) {
      return withTx(db, tx => runIdempotentCommand(tx, { kind: 'plan.materials', operationId: input.operation_id,
        requestHash: requestHashOf('plan.materials', { ...input, actor }), now }, () => {
        const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE p.plan_id=? AND p.created_by=?', [input.plan_id,actor])
        if (!row) throw new OrchError('NOT_FOUND','没有对应的任务计划')
        const view = toPlanView(row)
        if (view.content_hash !== input.content_hash || view.launch
          || tx.get('SELECT 1 FROM task_plan_draft_end WHERE plan_id=?',[input.plan_id]))
          throw new OrchError('CONFIRMATION_MISMATCH','计划已变化，请重新取回后授权')
        const def = catalog.get(view.proposal.workflow_id,view.proposal.workflow_version)
        const nodes = [...new Set(input.nodes)].sort()
        if (nodes.some(id => !view.proposal.steps.some(step => step.node_id===id)
          || !def.nodes.some(node => node.node_id===id && node.type==='agent')))
          throw new OrchError('FORBIDDEN','只能授权本计划中的实际执行步骤')
        if (new Set(input.items.map(item => item.name)).size !== input.items.length)
          throw new OrchError('PAYLOAD_SCHEMA_INVALID','同一次授权的材料名称不能重复')
        const pins = saveMaterials(tx, materialGrant(actor,input.plan_id), input.items, Date.parse(now))
        const currentMaterials = (view.brief.materials ?? []).filter(material => !input.items.some(item => item.name===material.name) && tx.get(
          'SELECT 1 FROM plan_materials WHERE id=? AND revoked=0 AND expires_ms>?',[material.id,Date.parse(now)]))
        const materials = [...currentMaterials, ...pins.map((pin,index) => ({ ...pin,
          name: input.items[index]!.name, nodes, expires_ms: Date.parse(now)+30*60_000, draft: input.plan_id }))]
        if (materials.length > 8) throw new OrchError('RANGE_TOO_LARGE','本计划最多授权 8 份材料')
        const brief: PlanInput = { ...view.brief, materials }
        const contentHash = planHash({ brief, proposal:view.proposal, quality:view.quality },row.workflow_hash,row.contract_version)
        const id=uuidv7()
        tx.run(`INSERT INTO task_plans (plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,
          content_hash,launch_operation_id,created_at,owner_task_id,auto_workflow_id,contract_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id,actor,JSON.stringify(brief),row.proposal_json,row.quality_json,row.workflow_hash,contentHash,
            uuidv7(),now,row.owner_task_id,row.auto_workflow_id,row.contract_version])
        tx.run('INSERT INTO task_plan_draft_end(plan_id,successor_id,request_hash,ended_at) VALUES (?,?,?,?)',
          [input.plan_id,id,requestHashOf('plan.materials',{...input,actor}),now])
        tx.run('UPDATE chat_task_receipts SET plan_id=? WHERE plan_id=?',[id,input.plan_id])
        tx.run('UPDATE chat_planning_progress SET plan_id=?,title=?,updated_ms=? WHERE plan_id=?',[id,view.proposal.title,Date.parse(now),input.plan_id])
        appendEvent(tx,{ type:'task_plan.proposed',payload:{ plan_id:id,content_hash:contentHash,materials_count:materials.length } })
        const updated = tx.get<PlanRow>(PLAN_SELECT + ' WHERE p.plan_id=?', [id])!
        return viewOf(updated, tx, Date.parse(now))
      }).result)
    },
    revokeMaterial(input: z.infer<typeof materialRevokeSchema>, actor: string) {
      return withTx(db, tx => {
        const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE p.plan_id=? AND p.created_by=?',[input.plan_id,actor])
        if (!row || row.content_hash!==input.content_hash) throw new OrchError('CONFIRMATION_MISMATCH','计划版本已变化')
        const material = toPlanView(row).brief.materials?.find(item=>item.id===input.material_id)
        if (!material) throw new OrchError('NOT_FOUND','这份计划没有对应材料')
        return { revoked: revokeMaterial(tx,materialGrant(actor,material.draft),material.id) > 0 }
      })
    },
    /** 未启动的计划草稿：只有原创建者能看到，用来取回、调整或放弃（P01）。 */
    listDrafts(actor: string, taskId?: string, options: { cursor?: string; limit?: number } = {}) {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
      const filter = { actor, taskId: taskId ?? null, limit }
      const cursor = options.cursor ? decodeCursor(options.cursor, 'plan-drafts', filter) : undefined
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const where = ["p.created_by=?", "NOT EXISTS (SELECT 1 FROM task_plan_draft_end e WHERE e.plan_id=p.plan_id)",
          "NOT EXISTS (SELECT 1 FROM start_run_operations o2 WHERE o2.operation_id=p.launch_operation_id)"]
        const params: unknown[] = [actor]
        if (taskId) { where.push('p.owner_task_id=?'); params.push(taskId) }
        if (cursor) {
          where.push('(p.created_at < ? OR (p.created_at = ? AND p.plan_id < ?))')
          params.push(cursor.last_key, cursor.last_key, cursor.last_id)
        }
        const rows = tx.all<PlanRow>(PLAN_SELECT + ' WHERE ' + where.join(' AND ')
          + ' ORDER BY p.created_at DESC, p.plan_id DESC LIMIT ?', [...params, limit + 1])
        const items = rows.slice(0, limit)
        const last = items.at(-1)
        return { items: items.map(row => viewOf(row, tx)), as_of_seq,
          next_cursor: rows.length > limit && last ? encodeCursor(makeCursor('plan-drafts', filter,
            last.created_at, last.plan_id, as_of_seq)) : null }
      })
    },
    discard(reference: { plan_id: string; content_hash: string }, actor: string, now: string) {
      return discardDraft(db, reference, actor, now)
    },
    getForTask(taskId: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE o.task_id = ? AND p.created_by = ?', [taskId, actor])
        return { item: row ? viewOf(row, tx) : null, as_of_seq }
      })
    },
    propose: (input: TaskPlanInput, actor: string, now: string, signal?: AbortSignal) => propose(input, actor, now, signal),
    proposeFromChat: (input: TaskPlanInput, actor: string, now: string, origin: ChatTaskOrigin) => propose(input, actor, now, undefined, origin),
    confirm(input: PlanConfirm, actor: string, now: string) {
      if (input.confirmed !== true) throw new OrchError('CONFIRMATION_REQUIRED', '请核对计划后确认启动')
      return launch(input.plan_id, input.content_hash, actor, now)
    },
    launchFromChat(planId: string, contentHash: string, actor: string, now: string, origin: ChatTaskOrigin, nativeApproval = false) {
      origin.assertCurrent()
      if (findChatPlan(db, origin) !== planId) throw new OrchError('FORBIDDEN', '计划与当前会话消息的绑定不一致')
      return launch(planId, contentHash, actor, now, { origin, nativeApproval })
    },
  }
}

export type TaskPlanningHost = ReturnType<typeof createTaskPlanningHost>

/** Read only a confirmed plan that launched this exact run and pinned definition. */
export function readApprovedTaskPlanForRun(tx: Pick<Tx, 'get'>, runId: string): TaskPlanView | null {
  const bound = tx.get<{ task_id: string; workflow_id: string | null; workflow_version: string | null;
    workflow_definition_hash: string | null }>(`SELECT task_id,workflow_id,CAST(workflow_version AS TEXT) AS workflow_version,
    workflow_definition_hash FROM runs WHERE run_id=?`, [runId])
  if (!bound) return null
  const row = tx.get<PlanRow>(PLAN_SELECT + ' WHERE o.task_id = ? AND o.run_id = ?', [bound.task_id, runId])
  if (!row) return null
  if (row.workflow_hash !== bound.workflow_definition_hash) {
    throw new OrchError('CONFIRMATION_MISMATCH', '运行与已批准计划的流程哈希不符')
  }
  return assertApprovedPlan(row, bound.workflow_id, bound.workflow_version)
}

/** The executor calls this inside its dispatch transaction, after the plan was confirmed and started. */
export function getTaskPlanRecommendation(db: Db, context: ModelRoutingContext): ModelRecommendation | null {
  const row = db.raw.prepare(PLAN_SELECT + ' WHERE o.task_id = ? AND o.run_id = ?').get(context.taskId, context.runId) as PlanRow | undefined
  if (!row) return null
  const { proposal } = assertApprovedPlan(row, context.workflowId, context.workflowVersion)
  const step = proposal.steps.find((item) => item.node_id === context.nodeId)
  if (!step) throw new OrchError('CONFIRMATION_MISMATCH', '已启动计划未登记该节点的复杂度建议')
  return { complexity: step.complexity, reason: step.model_reason,
    ...(step.preferred_model_ref === undefined ? {} : { preferredModel: step.preferred_model_ref }) }
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
    const choice = pinned ? readChoiceSafe(catalog, registry, pinned, tx, run.task_id) : null
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
        ...(brief.requirements_contract && { requirements_contract: brief.requirements_contract }),
        requirements: brief.requirements.filter(({ id }) => step.goal_ids.includes(id)),
        step: step.description,
        deliverables: proposal.deliverables.flatMap((item, index) => item.node_id === step.node_id
          ? [{ ...item, ...(item.acceptance.kind === 'chat/text_result' && { deliverable_index: index }) }] : []),
        materials: (brief.materials ?? []).filter(material => material.nodes.includes(step.node_id))
          .map(({ id, digest, name, expires_ms }) => ({ id, digest, name, expires_ms })),
        risks: proposal.risks.filter((item) => item.node_id === step.node_id || item.node_id === undefined),
      },
    }]))
  })
}
