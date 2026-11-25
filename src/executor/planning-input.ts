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
    // Free prose, table rows and copied requirement clauses can contain the
    // same operands without a data label. Keep structural counts (e.g. two
    // steps), named task/card identifiers and the operation; defer operands.
    return text.replace(/(?:任务|流程|审批(?:步骤|节点)?)\s*[「“][^」”\r\n]{1,80}[」”]|[+−-]?\p{Nd}+(?:[.,，．]\p{Nd}+)*(?:[eE][+-]?\d+)?|[零〇一二两三四五六七八九十百千万亿点]+(?=\s*(?:元|块|美元|欧元|千克|公斤|%|％))/gu,
      (value, offset: number) => {
        if (/^(?:任务|流程|审批)/u.test(value)) return value
        const rest = text.slice(offset + value.length)
        const structural = /^\s*(?:(?:个|名|项|条)\s*)?(?:执行步骤|步骤|节点|代理|分支|列|段落|deliverables?\b|steps?\b|agents?\b|columns?\b)/iu.test(rest)
        return structural ? value : '〔输入值〕'
      })
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
