import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { requirementsContractSchema, type RequirementsContract } from '../core/task-requirements.ts'
import type { TaskPlanInput } from '../service/task-planning.ts'
import { interpretSemanticAdmission, SEMANTIC_INSTRUCTIONS, type SemanticInput, type SemanticWorkflow } from '../service/semantic-admission.ts'
import { createDshJsonCompletion } from './dsh-json.ts'
import type { createDshPlanningCallback } from './dsh-host.ts'

type PlanningContext = Parameters<typeof createDshPlanningCallback>[0]
type WorkflowSelection = { workflow_id: string; workflow_version: string }
type Input = TaskPlanInput & { requirements_contract?: RequirementsContract }

/** The form and HTTP planner use the same cited contract as chat before workflow retrieval. */
export function createDshTaskRequirements(options: PlanningContext & {
  isAuthorized?: () => boolean
  resolveWorkflow: (hint: SemanticWorkflow) => WorkflowSelection
}) {
  const complete = createDshJsonCompletion(options.context.llm)
  return async (input: Input, signal: AbortSignal): Promise<Input> => {
    signal.throwIfAborted()
    if (input.requirements_contract) {
      return { ...input, requirements_contract: requirementsContractSchema.parse(input.requirements_contract) }
    }
    if (!complete) throw new OrchError('SERVICE_UNAVAILABLE', '当前模型服务尚未提供任务理解接口', { reason: 'semantic_unavailable' })
    const parent = options.parent()
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (!parent || options.parent() !== parent || options.context.agents.get(parent.session.id) !== parent
        || options.isAuthorized?.() === false) {
        throw new OrchError('FORBIDDEN', '任务规划需要当前已授权的工作区会话')
      }
    }
    assertCurrent()
    const selected = typeof options.model === 'function' ? await options.model(parent!, signal) : options.model
    assertCurrent()
    const text = [input.goal, ...input.requirements].join('\n')
    const semantic: SemanticInput = {
      current: { message_id: 'task-form-' + sha256Hex(text), text }, explicit: true, surface: 'task_form',
    }
    const raw = await complete(selected, SEMANTIC_INSTRUCTIONS, semantic, signal, assertCurrent)
    assertCurrent()
    const interpreted = interpretSemanticAdmission(semantic, raw)
    if (interpreted.kind !== 'ready') {
      throw new OrchError('CONFIRMATION_REQUIRED', 'message' in interpreted ? interpreted.message
        : '请说明本次希望完成的任务和交付结果。', { reason: 'semantic_clarification_required' })
    }
    const hint = interpreted.request.workflow
    let selection: WorkflowSelection | undefined
    if (hint) {
      selection = options.resolveWorkflow({ ...hint, ...(hint.version === undefined && input.workflow_version !== undefined
        ? { version: input.workflow_version } : {}) })
      if ((input.workflow_id !== undefined && input.workflow_id !== selection.workflow_id)
        || (input.workflow_version !== undefined && input.workflow_version !== selection.workflow_version)) {
        throw new OrchError('CONFIRMATION_REQUIRED', '文字指定的流程与表单所选流程或版本不同，请统一后重新生成计划。',
          { reason: 'semantic_clarification_required' })
      }
    }
    // Keep the exact form fields. The semantic stage contributes only validated restrictions and an explicit workflow pin.
    return { ...input, ...selection, requirements_contract: interpreted.request.requirements_contract }
  }
}
