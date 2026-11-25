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
  // Retain the v1 meaning of no_workspace_files: no creation or modification.
  z.strictObject({ ...common, kind: z.literal('no_workspace_files') }),
  z.strictObject({ ...common, kind: z.literal('no_workspace_read') }),
  z.strictObject({ ...common, kind: z.literal('no_network') }),
  z.strictObject({ ...common, kind: z.literal('read_only') }),
  z.strictObject({ ...common, kind: z.literal('no_external_send') }),
  z.strictObject({ ...common, kind: z.literal('preserve_input'), target: z.string().trim().min(1).max(500) }),
  z.strictObject({ ...common, kind: z.literal('report_data_gap') }),
  z.strictObject({ ...common, kind: z.literal('approval_before'), scope: z.enum(['task', 'steps']),
    action: z.string().trim().min(1).max(500).optional(), gate_name: z.string().trim().min(1).max(80).optional(), reviewer }),
]).superRefine((constraint, ctx) => {
  if (constraint.kind === 'report_data_gap') {
    const quote = constraint.quote
    const report = /上报|汇报|报告|说明|指出|列出|注明|标注|\b(?:report|explain|identify|list)\b/iu
    const gap = /缺失|缺口|缺少|缺价|未完成|无法完成|不能完成|不完整|\b(?:missing|incomplete|unavailable)\b/iu
    const denied = /(?:不(?:要|必|得|用|需)|无需|禁止|勿)\s*(?:再|主动|如实)?\s*(?:上报|汇报|报告|说明|指出|列出|注明|标注)|\b(?:do not|don't|never)\s+(?:report|explain|identify|list)\b/iu
    if (!report.test(quote) || !gap.test(quote) || denied.test(quote)) {
      ctx.addIssue({ code: 'custom', path: ['quote'], message: '须引用用户要求报告缺失或未完成项的原句' })
    }
  }
  if (constraint.kind === 'approval_before' && constraint.scope === 'steps' && !constraint.action) {
    ctx.addIssue({ code: 'custom', path: ['action'], message: '步骤审批需要说明受控动作' })
  }
  if (constraint.kind === 'approval_before' && constraint.gate_name && constraint.scope !== 'steps') {
    ctx.addIssue({ code: 'custom', path: ['gate_name'], message: '只有步骤审批可绑定审批卡名称' })
  }
})

/** Extract an explicitly requested card label. A label alone never authorizes a gate or an action. */
export function explicitApprovalNames(text: string): string[] {
  const named = /(?:^|[，,。；;\n])\s*(?:请\s*)?(?:设置|添加|加入|安排|设立|创建|新增)(?:\s*(?:一个|一道))?(?:\s*独立的?)?\s*(?:人工审批(?:步骤|节点)\s*[「“]([^」”\r\n]{1,80})[」”]|名为\s*[「“]([^」”\r\n]{1,80})[」”]\s*的人工审批(?:步骤|节点))/gu
  return [...new Set(Array.from(text.matchAll(named), match => (match[1] ?? match[2])!.trim()).filter(Boolean))]
}

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
    if (constraint.kind === 'approval_before' && constraint.gate_name && !sources.get(constraint.source_message_id)?.includes(constraint.gate_name)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'gate_name'], message: '审批卡名称须来自同一条原始消息' })
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
