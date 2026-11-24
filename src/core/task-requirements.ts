import { z } from 'zod'

const identifier = z.string().trim().min(1).max(128)
const evidence = {
  source_message_id: identifier,
  quote: z.string().trim().min(1).max(2000),
}
const common = { id: identifier, ...evidence }
const reviewer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator') }),
  z.strictObject({ kind: z.literal('named'), name: z.string().trim().min(1).max(120) }),
])

export const taskRequirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('chat_only') }),
  z.strictObject({ ...common, kind: z.literal('no_workspace_files') }),
  z.strictObject({ ...common, kind: z.literal('read_only') }),
  z.strictObject({ ...common, kind: z.literal('no_external_send') }),
  z.strictObject({ ...common, kind: z.literal('preserve_input'), target: z.string().trim().min(1).max(500) }),
  z.strictObject({ ...common, kind: z.literal('approval_before'), scope: z.enum(['task', 'steps']),
    action: z.string().trim().min(1).max(500).optional(), reviewer }),
]).superRefine((constraint, ctx) => {
  if (constraint.kind === 'approval_before' && constraint.scope === 'steps' && !constraint.action) {
    ctx.addIssue({ code: 'custom', path: ['action'], message: '步骤审批需要说明受控动作' })
  }
})

/** Sources are supplied by an authenticated entry point. Quotes carry meaning, never authorization. */
export const requirementsContractSchema = z.strictObject({
  version: z.literal(1),
  start_policy: z.enum(['immediate', 'plan_only']),
  sources: z.array(z.strictObject({ message_id: identifier, text: z.string().min(1).max(8000) })).min(1).max(20),
  constraints: z.array(taskRequirementSchema).max(40),
  timing: z.strictObject(evidence).optional(),
}).superRefine((contract, ctx) => {
  const sources = new Map(contract.sources.map(source => [source.message_id, source.text]))
  if (sources.size !== contract.sources.length) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: '需求来源消息不能重复' })
  }
  const ids = new Set(contract.constraints.map(constraint => constraint.id))
  if (ids.size !== contract.constraints.length) {
    ctx.addIssue({ code: 'custom', path: ['constraints'], message: '需求约束编号不能重复' })
  }
  for (const [index, constraint] of contract.constraints.entries()) {
    if (!sources.get(constraint.source_message_id)?.includes(constraint.quote)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'quote'], message: '约束引用不在对应来源消息中' })
    }
  }
  if (contract.timing && !sources.get(contract.timing.source_message_id)?.includes(contract.timing.quote)) {
    ctx.addIssue({ code: 'custom', path: ['timing', 'quote'], message: '执行时机引用不在对应来源消息中' })
  }
})

export const constraintBindingSchema = z.strictObject({
  constraint_id: identifier,
  approval_node_id: identifier,
  protected_node_ids: z.array(identifier).min(1).max(100),
})

export type TaskRequirement = z.infer<typeof taskRequirementSchema>
export type RequirementsContract = z.infer<typeof requirementsContractSchema>
export type ConstraintBinding = z.infer<typeof constraintBindingSchema>

/** A revision preserves earlier restrictions. Relaxing them requires a separately reviewed task. */
export function mergeRequirementsContracts(previous: RequirementsContract, next: RequirementsContract): RequirementsContract {
  const sources = [...previous.sources]
  for (const source of next.sources) {
    if (!sources.some(existing => existing.message_id === source.message_id && existing.text === source.text)) sources.push(source)
  }
  const constraints: TaskRequirement[] = []
  const seen = new Set<string>()
  for (const value of [...previous.constraints, ...next.constraints]) {
    const constraint = taskRequirementSchema.parse(value)
    const { id: _id, quote: _quote, source_message_id: _source, ...meaning } = constraint
    const comparable = JSON.stringify(meaning)
    if (seen.has(comparable)) continue
    seen.add(comparable)
    constraints.push({ ...constraint, id: 'c' + (constraints.length + 1) })
  }
  const timing = previous.start_policy === 'plan_only' ? previous.timing : next.timing
  return requirementsContractSchema.parse({ version: 1,
    start_policy: previous.start_policy === 'plan_only' ? 'plan_only' : next.start_policy,
    sources, constraints, ...(timing && { timing }) })
}
