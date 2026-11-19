import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { MODEL_COMPLEXITIES, type ModelRecommendation, type ModelRoutingContext } from '../executor/model-routing.ts'
import type { ToolRegistry } from '../executor/tools.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { ARTIFACT_MAX_BYTES, isArtifactFileName } from './artifact-store.ts'
import { startRun } from './commands/start-run.ts'
import { withReadTx } from './queries/read-tx.ts'
import type { NodeSpec } from './dispatcher.ts'
import type { TriggerRunReady } from './task-trigger-dispatch.ts'
import type { WorkflowCatalog } from './workflows.ts'

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
}
type PlanRow = {
  plan_id: string; input_json: string; proposal_json: string; quality_json: string; content_hash: string
  workflow_hash: string | null; launch_operation_id: string; created_at: string
  task_id: string | null; run_id: string | null
}
const PLAN_SELECT = `SELECT p.plan_id, p.input_json, p.proposal_json, p.quality_json, p.content_hash,
  p.workflow_hash, p.launch_operation_id, p.created_at, o.task_id, o.run_id
  FROM task_plans p LEFT JOIN start_run_operations o ON o.operation_id = p.launch_operation_id`

function toPlanView(row: PlanRow): TaskPlanView {
  return {
    plan_id: row.plan_id, content_hash: row.content_hash, brief: JSON.parse(row.input_json) as PlanInput,
    proposal: proposalSchema.parse(JSON.parse(row.proposal_json)), quality: JSON.parse(row.quality_json) as PlanQuality,
    created_at: row.created_at, launch: row.task_id && row.run_id ? { task_id: row.task_id, run_id: row.run_id } : null,
  }
}

type PublishedRow = { workflow_id: string; name: string; version: string; content_hash: string }
const PUBLISHED_SELECT = 'SELECT w.workflow_id, w.name, v.version, v.content_hash FROM workflows w '
  + "JOIN workflow_versions v ON v.workflow_id = w.workflow_id WHERE w.status = 'active' AND w.scope = 'reusable' "
  + 'AND v.published_by IS NOT NULL'

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
      if (!options) throw new OrchError('VERDICT_UNSUPPORTED', 'DSH 宿主尚未装配主脑规划服务')
      const choices = withReadTx(db, ({ tx }) => {
        const rows = tx.all<PublishedRow>(PUBLISHED_SELECT + ' AND v.version = CAST(w.current_version AS TEXT) ORDER BY w.updated_at DESC, w.workflow_id LIMIT 24')
        return rows.flatMap((row) => {
          const choice = readChoice(catalog, registry, row)
          return choice ? [choice] : []
        })
      })
      if (choices.length === 0) throw new OrchError('WORKFLOW_NOT_PUBLISHED', '请先发布至少一个可复用流程')
      const brief = { goal: input.goal, requirements: input.requirements.map((text, index) => ({ id: 'R' + (index + 1), text })) }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let candidate: unknown
      try {
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new OrchError('OPERATION_TIMEOUT', '主脑没有在时限内生成计划'))
            controller.abort()
          }, timeout)
          timer.unref()
        })
        const offered = structuredClone({ ...brief, workflows: choices.map((item) => item.workflow) })
        candidate = await Promise.race([options.propose(offered, controller.signal), expired])
      } catch (error) {
        if (error instanceof OrchError && error.code === 'OPERATION_TIMEOUT') throw error
        throw new OrchError('SERVICE_UNAVAILABLE', '主脑暂时未能产出计划')
      } finally { if (timer !== undefined) clearTimeout(timer) }
      const parsed = proposalSchema.safeParse(candidate)
      if (!parsed.success) throw new OrchError('WORKFLOW_DEFINITION_INVALID', '主脑返回的计划不符合约定结构', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 12),
      })
      const proposal = parsed.data
      const selected = choices.find(({ workflow }) => workflow.workflowId === proposal.workflow_id && workflow.version === proposal.workflow_version)
      const quality = evaluate(brief, proposal, selected?.workflow)
      const workflowHash = selected?.hash ?? null
      const hash = planHash({ brief, proposal, quality }, workflowHash)
      const id = uuidv7()
      withTx(db, (tx) => {
        tx.run('INSERT INTO task_plans (plan_id, created_by, input_json, proposal_json, quality_json, workflow_hash, content_hash, launch_operation_id, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, actor, JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), workflowHash, hash, uuidv7(), now])
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
      const current = withReadTx(db, ({ tx }) => {
        const published = tx.get<PublishedRow>(PUBLISHED_SELECT + ' AND w.workflow_id = ? AND v.version = ?',
          [proposal.workflow_id, proposal.workflow_version])
        return published ? readChoice(catalog, registry, published) : null
      })
      if (!current || current.hash !== row.workflow_hash || !evaluate(brief, proposal, current.workflow).ready) {
        throw new OrchError('CONFIRMATION_MISMATCH', '固定流程版本或工具授权已变化，请重新规划')
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
    const published = tx.get<PublishedRow>(PUBLISHED_SELECT + ' AND w.workflow_id = ? AND v.version = ?',
      [run.workflow_id, run.workflow_version])
    const choice = published ? readChoice(catalog, registry, published) : null
    if (!choice || choice.hash !== row.workflow_hash || !evaluate(brief, proposal, choice.workflow).ready) {
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
