import { requirementsContractSchema } from '../core/task-requirements.ts'
import { taskAccess } from '../core/task-access.ts'

/** Keep the execution data on the approved plan. The planning model only needs
 * the operation and constraints when the operator has put that operation on hold. */
export function dshPlanningInput(input: unknown) {
  if (!input || typeof input !== 'object' || !('requirements_contract' in input)) return { payload: input }
  const parsed = requirementsContractSchema.safeParse(input.requirements_contract)
  if (!parsed.success) return { payload: input }
  const contract = parsed.data
  const { noNetwork: offline, noWorkspaceRead } = taskAccess(contract)
  if (!contract.constraints.some(c => c.kind === 'approval_before' && c.scope === 'steps')) return { payload: input, offline, noWorkspaceRead }

  const material = new Set<string>()
  // A labelled data field can share a line with the next instruction. Only
  // withhold its value; keep the requested operation and its dependencies.
  const field = /(?:^|[\n，,。！？；;])\s*(?:请\s*)?(?:(?:使用|采用|提供|给定|输入)\s*)?(?:(?:以下|下列|如下|模拟|原始|测试|输入)\s*)*(?:数据|材料|样本)\s*[：:][ \t]*(?:\r?\n[ \t]*)?([^。！？；;\r\n]+)/gu
  for (const source of contract.sources) {
    for (const match of source.text.matchAll(field)) if (match[1]?.trim()) material.add(match[1].trim())
  }
  const placeholder = '〔任务输入已保留，批准后提供〕'
  function defer(text: string) {
    for (const block of material) {
      if (text.trim() && block.includes(text.trim())) return placeholder
      text = text.replaceAll(block, placeholder)
    }
    return text
  }
  const brief = input as Record<string, unknown>
  // The ledger keeps the citations. Repeating them alongside the verified
  // constraint IDs in the model request would disclose the same data again.
  const constraints = contract.constraints.map(({ quote: _quote, source_message_id: _source, ...c }) =>
    c.kind === 'approval_before' && c.action ? { ...c, action: defer(c.action) } : c)
  const payload = { ...brief, ...(typeof brief.goal === 'string' && { goal: defer(brief.goal) }),
    ...(Array.isArray(brief.requirements) && { requirements: brief.requirements.map((item: unknown) =>
      item && typeof item === 'object' && 'text' in item && typeof item.text === 'string' ? { ...item, text: defer(item.text) } : item) }),
    requirements_contract: { version: contract.version, start_policy: contract.start_policy, constraints },
  }
  return { payload, offline, noWorkspaceRead }
}
