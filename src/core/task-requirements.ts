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
const deniedGapReport = /(?:不(?:要|必|得|用|需)|无需|禁止|勿)\s*(?:再|主动|如实)?\s*(?:上报|汇报|报告|说明|指出|列出|注明|标注)|\b(?:do not|don't|never)\s+(?:report|explain|identify|list)\b/iu

// Quotes remain bound to their own message. Numbers and parallelism can be stated
// in another authenticated message belonging to the same task.
const rosterClause = /^(?:(?:请)?(?:不(?:要|得|需要|允许)?|禁止|勿)(?:再)?(?:额外|另行|另外)(?:启动|创建|安排|派发|增加|派出|召集)(?:新的?|其他)?(?:业务|子)?(?:代理|智能体)|(?:do not|don't|never) (?:start|spawn|create|add) (?:any )?(?:extra|additional) (?:business )?agents?|no (?:extra|additional) agents?)$/iu
function requestedRoster(source: string) {
  const clauses = source.split(/[。，,；;！!?？：:\n]|\.(?:\s|$)/u).map(clause => clause.trim())
  const quote = clauses.find(clause => rosterClause.test(clause))
  const assignment = /^(?:请(?:你|帮我)?|现在|接下来|我希望|我需要)?\s*(?:安排|启动|创建|使用|派出)\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*(?:个|名|位)?(?:同时运行的|并行的?|独立的?|只读|业务|子|执行|协作|\s)*(?:代理|智能体)|^(?:please\s+)?(?:assign|use|start|run)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:concurrent|parallel|independent|read-only|business)\s+)*agents?\b/iu
  const assignments = clauses.map(clause => assignment.exec(clause)).filter(match => match !== null)
  const numbers = assignments.map(match => {
    const token = (match[1] ?? match[2]!).toLowerCase().replace('两', '二')
    if (/^\d+$/u.test(token)) return Number(token)
    if (/^[a-z]/u.test(token)) return ['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(token) + 1
    const digit = (x: string) => '一二三四五六七八九'.indexOf(x) + 1
    const [tens, ones] = token.split('十')
    return ones === undefined ? digit(tens!) : (tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0)
  })
  if (!quote && !numbers.length) return
  const concurrent = numbers.filter((_number, index) => /同时运行|并行|concurrent|parallel/iu.test(assignments[index]![0]))
  return { quote, count: numbers.length ? Math.max(...numbers) : undefined, parallelCount: concurrent.length ? Math.max(...concurrent) : 0,
    closed: Boolean(quote), conflicting: Boolean(quote) && new Set(numbers).size > 1 }
}

export function explicitAgentRoster(source: string) {
  const roster = requestedRoster(source)
  return roster?.quote ? { ...roster, quote: roster.quote } : undefined
}

export function contractAgentRoster(sources: readonly { text: string }[]) {
  return requestedRoster(sources.map(source => source.text).join('\n'))
}

const peerSubject = /协作|信箱|请求|求助|工具回执|代理|对方|执行状态|运行状态|测试场景|\b(?:collaboration|mailbox|requests?|peers?|receipts?|runtime|test scenario)\b/iu
const executionEvent = /异常|超时|拒绝|回应|答复|回复|回执|观察|覆盖|窗口|去重|未完成|不完整|无法完成|失联|不可用|\b(?:timeout|timed out|repl(?:y|ies)|response|unanswered|reject\w*|errors?|observ\w*|receipts?|coverage|window|unavailable|incomplete|missing)\b/iu
const permissionSubject = /审批|批准|授权|只读|工作区|文件|联网|网络|外部|凭据|\b(?:approv\w*|permissions?|read.only|workspace|files?|network|external|credentials?)\b/iu
const missingMaterial = /(?:数据|材料|资料|字段|输入|单价|金额|价格|数量|清单|交付物)(?:仍然?|尚且?|严重|部分|仍|已|尚|有)?(?:缺失|缺少|缺口|不全|不完整|不足|未知|未提供|未完成)|(?:缺少|缺失|未提供|不完整的)(?:必要的?|所需的?|部分|的)?(?:数据|材料|资料|字段|输入|单价|金额|价格|数量|清单|交付物)|\b(?:missing|unavailable|incomplete)\s+(?:(?:required|necessary|input)\s+)?(?:data|inputs?|materials?|prices?|fields?|deliverables?)\b/iu
const gapReportVerb = /上报|汇报|报告|说明|指出|列出|注明|标注|\b(?:report|explain|identify|list)\b/iu
const gapMarker = /缺失|缺口|缺少|缺价|未完成|无法完成|不能完成|不完整|\b(?:missing|incomplete|unavailable)\b/iu
const incompleteWork = /(?:未完成|无法完成|不能完成|不完整)(?:的)?(?:业务|工作|核算|计算|金额|数量|交付物|交付项|报表|报告)|(?:业务工作|核算|计算|金额|数量|交付物|报表)(?:仍|尚)?(?:未完成|不完整)|\b(?:missing|unavailable|incomplete|unfinished)\s+(?:business\s+)?(?:work|deliverables?|calculations?|amounts?)\b/iu
const processStatus = /审批|批准|权限|授权|测试(?:是否|状态|结果|条件|场景)|运行(?:状态|结果)|执行状态|\b(?:approval|permission|test (?:status|result|condition)|execution status)\b/iu
const approvalStatus = /(?:审批|审核|批准)(?:的)?(?:状态|进度)|\bapproval (?:status|progress)\b/iu
const gatedAction = /只有|才能|之前|批准后|审批后|审核后|未经|方可|先审批|再(?:开始|执行)|\b(?:only after|before|unless|must approve)\b/iu
function mentionsPeerOutcome(sentence: string) {
  return peerSubject.test(sentence) && executionEvent.test(sentence)
}

function citationContexts(source: string, quote: string): string[] {
  if (!quote || !source.includes(quote)) return []
  const sentences = source.match(/[^。！？；;.!?\r\n]+[。！？；;.!?]?/gu) ?? []
  return sentences.filter(sentence => sentence.includes(quote))
}

/** A worker retry rule stays with its step. It cannot establish a closed roster for the whole run. */
export function citesAgentRedispatchRule(source: string, quote: string) {
  const contexts = citationContexts(source, quote)
  const redispatch = /(?:不(?:得|要|可|应|能|必|用)?|禁止|勿)\s*(?:(?:重复|循环|反复)?(?:查询|轮询|等待)\s*(?:或|和|并|、)\s*)?(?:重新|重复|再次)(?:派发|指派|派遣|调度|分派)(?:该|此|原|同一)?(?:代理|智能体)|\b(?:do not|don't|never)\s+(?:(?:poll|wait|retry)\s+(?:or|and)\s+)?(?:redispatch|reassign|re-dispatch)\s+(?:(?:the|this|that|same|either)\s+)?(?:agents?|workers?)\b/iu
  const rosterWording = /额外|新增|另外|另行|只允许|仅限|不得增加|\b(?:extra|additional|new|only)\b/iu
  return contexts.length > 0 && contexts.every(sentence => redispatch.test(sentence) && !rosterWording.test(sentence))
}

// Only this list of validator-owned explanations may appear in model correction instructions.
export const citationIssueMessages = {
  missingQuote: '约束引用不在对应来源消息中',
  roster: '须引用整项任务禁止新增代理的原句。单个代理的查询或重新派发要求应保留在原步骤',
  negatedGap: '缺口处理引用不能省略原句中的否定',
  gap: '协作或运行状态不能作为缺少输入时部分执行的依据',
} as const

export function citedExecutionObservation(source: string, quote: string) {
  const contexts = citationContexts(source, quote)
  return contexts.length > 0 && contexts.every(sentence => !missingMaterial.test(sentence) && (
    mentionsPeerOutcome(sentence) && !permissionSubject.test(sentence)
    || approvalStatus.test(sentence) && gapReportVerb.test(sentence) && !gatedAction.test(sentence)
      && !permissionSubject.test(sentence.replace(/审批|审核|批准|approval/giu, ''))))
}

export function authorizesDataGap(source: string, quote: string) {
  if (!quote || !source.includes(quote) || !gapReportVerb.test(quote) || !gapMarker.test(quote) || deniedGapReport.test(quote)) return false
  // Admission needs positive evidence of a missing input or unfinished business
  // deliverable. A status report alone never grants partial-execution authority.
  if (missingMaterial.test(quote)) return true
  const contexts = citationContexts(source, quote)
  if (contexts.length && contexts.every(sentence => missingMaterial.test(sentence))
    && !mentionsPeerOutcome(quote) && !processStatus.test(quote)) return true
  return incompleteWork.test(quote) && ![quote, ...contexts].some(text => mentionsPeerOutcome(text) || processStatus.test(text))
}

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
  z.strictObject({ ...common, kind: z.literal('no_extra_agents') }),
  z.strictObject({ ...common, kind: z.literal('approval_before'), scope: z.enum(['task', 'steps']),
    action: z.string().trim().min(1).max(500).optional(), gate_name: z.string().trim().min(1).max(80).optional(), reviewer }),
]).superRefine((constraint, ctx) => {
  if (constraint.kind === 'report_data_gap') {
    const quote = constraint.quote
    if (!gapReportVerb.test(quote) || !gapMarker.test(quote) || deniedGapReport.test(quote)) {
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
export const storedRequirementsContractSchema = z.strictObject({
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
    const source = sources.get(constraint.source_message_id)
    if (!source?.includes(constraint.quote)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'quote'], message: citationIssueMessages.missingQuote })
    }
    if (constraint.kind === 'no_extra_agents' && (!explicitAgentRoster(constraint.quote)
      || explicitAgentRoster(source ?? '')?.quote !== explicitAgentRoster(constraint.quote)?.quote)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'quote'], message: citationIssueMessages.roster })
    }
    if (source && constraint.kind === 'report_data_gap') {
      const before = source.slice(0, source.indexOf(constraint.quote)).split(/[，,。！？；;\n]/u).at(-1) ?? ''
      if (deniedGapReport.test(before + constraint.quote)) {
        ctx.addIssue({ code: 'custom', path: ['constraints', index, 'quote'], message: citationIssueMessages.negatedGap })
      }
    }
    if (constraint.kind === 'approval_before' && constraint.gate_name && !sources.get(constraint.source_message_id)?.includes(constraint.gate_name)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'gate_name'], message: '审批卡名称须来自同一条原始消息' })
    }
  }
  if (contract.timing && !sources.get(contract.timing.source_message_id)?.includes(contract.timing.quote)) {
    ctx.addIssue({ code: 'custom', path: ['timing', 'quote'], message: '执行时机引用不在对应来源消息中' })
  }
})

// Already-launched plans keep their historical shape and hash for display.
// New grants and previously unstarted plans pass today's authority checks.
export const requirementsContractSchema = storedRequirementsContractSchema.superRefine((contract, ctx) => {
  const sources = new Map(contract.sources.map(source => [source.message_id, source.text]))
  for (const [index, constraint] of contract.constraints.entries()) {
    if (constraint.kind === 'report_data_gap' && !authorizesDataGap(sources.get(constraint.source_message_id) ?? '', constraint.quote)) {
      ctx.addIssue({ code: 'custom', path: ['constraints', index, 'quote'], message: citationIssueMessages.gap })
    }
  }
  if (contractAgentRoster(contract.sources)?.conflicting) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: '同一任务指定了不同的参与代理人数，请确认人数' })
  }
})

export const constraintBindingSchema = z.strictObject({
  constraint_id: identifier,
  approval_node_id: identifier,
  protected_node_ids: z.array(identifier).min(1).max(100),
})

export type TaskRequirement = z.infer<typeof taskRequirementSchema>
export type RequirementsContract = z.infer<typeof requirementsContractSchema>

/** Preserve an explicitly named task from the human request before the proposed plan is hashed. */
export function requestedTaskTitle(contract: RequirementsContract | undefined): string | undefined {
  if (!contract) return
  const naming = /(?:^|[。！？；;，,\n])\s*(?:\/[^\s]+\s+)?(?:请(?:帮我)?\s*)?(?:(?:执行|创建|启动|新建)(?:一个|一项)?任务\s*|(?:将|把)?(?:本次)?任务(?:的)?(?:名称|标题|名)\s*(?:改为|设为|定为|为|[：:])\s*|(?:please\s+)?(?:run|start|create)\s+(?:a |the )?task\s+(?:named|called|titled)\s*)[「《“"]([^」》”"\r\n]{1,200})[」》”"]/giu
  for (let i = contract.sources.length - 1; i >= 0; i--) {
    const names = new Set([...contract.sources[i]!.text.matchAll(naming)].map(match => match[1]!.trim()).filter(Boolean))
    if (names.size) return names.size === 1 ? [...names][0] : undefined
  }
}
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
