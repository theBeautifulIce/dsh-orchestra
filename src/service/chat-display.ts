import type { ChatTextPreview } from './chat-text-previews.ts'
import { operatorReason, operatorStatus } from '../core/operator-language.ts'
import type { AnyOrchErrorCode } from '../core/errors.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'
import { formatDeliveryReviewNotice, type ChatDeliveryReview } from './chat-delivery-review.ts'

type Step = { title?: string | null; status: string; node_id?: string; waiting_on?: string[] }
type BlockingStep = Step & { action_required: boolean; reason: string | null; missing: string[]; outstanding_files?: string[] }
type Decision = { title: string | null; kind: string; choices: string[] | null; reason?: string | null; required_evidence: string[] | null
  explanation?: { title: string; summary: string; reason: string; evidenceGuidance: string } }
type RunDisplay = {
  title?: string | null
  status: string
  terminal: boolean
  acceptance?: string
  goal_met?: boolean
  settling: boolean
  counts: Array<{ status: string; count: number }>
  blocking: BlockingStep[]
  decisions: Decision[]
  coordination?: Array<{ id: string; revision: number; source: string; body: string; state: string; reason: string | null }>
  deliveryReviews?: ChatDeliveryReview[]
  nativeApprovals?: Array<{ requestId: string; executorSessionId: string; tool: string; mode: 'brain' | 'user'; title?: string }>
  rework?: Array<{ run_id?: string; request_id: string; target_node_run_id: string; status: string; round_no: number; reason: string; revision?: number }>
  delivery_checks: RunDeliveryCheck[]
  text_results?: ChatTextPreview[]
  failure_details?: Array<{ node_id: string; title: string; reason: string; next_action: string; missing: string[] }>
  nodes?: Step[]
  artifacts: Array<{ artifact_id: string; file_name?: string }>
}

const PENDING_EFFECT = new Set(['succeeded_with_unverified', 'failed_with_unverified', 'abandoned_unverified', 'indeterminate_side_effect'])
const ATTENTION_STEP = new Set(['started', 'verifying', 'waiting', 'failed', 'timeout', 'failed_with_unverified', 'orphaned', 'abandoned_unverified'])
const RUN_LABEL = new Map([
  ['succeeded', '本次执行已结束'],
  ['succeeded_with_unverified', '本次执行已结束，部分外部影响仍待核实'],
  ['failed', '本次运行失败'],
  ['failed_with_unverified', '本次运行失败，部分外部影响仍待核实'],
  ['orphaned', '本次运行失去执行联系'],
  ['cancelled', '本次运行已停止'],
])
const ACCEPTANCE = new Map([
  ['passed', '交付验收已通过。'],
  ['failed', '交付验收未通过。'],
  ['unverifiable', '现有证据不足以确认交付是否达到验收要求。'],
  ['not_applicable', '这次任务没有可用于确认交付结果的自动验收结论。'],
  ['pending', '交付验收还没有结论。'],
])

const PLANNING_ISSUES = {
  quota: ['规划模型额度不足', '请在 DSH 检查模型额度，或选择其他可用的主脑模型。处理后可重新发送原任务。'],
  access: ['规划请求被拒绝', '请检查当前模型的访问权限，或选择一个已授权的主脑模型。处理后可重新发送原任务。'],
  layout: ['生成流程的布局未通过校验', '流程图的布局数据不符合要求，执行尚未开始。可重新发送原任务生成新计划。'],
  length: ['计划超出模型的输出长度', '规划模型在完成计划前达到了输出上限。可缩小单次任务范围，或切换主脑模型后再发任务。'],
  connection: ['规划模型暂时不可用', '请检查模型服务的连接状态，恢复后可重新发送原任务。'],
  format: ['规划模型返回的计划无法读取', '可重新发送原任务。若仍无法读取，请切换主脑模型后再试。'],
} as const

type PlanningIssue = keyof typeof PLANNING_ISSUES

// 同一错误码下的可操作原因：用户看到的是“哪一步不成立、现在能做什么”，而不是宿主误诊。
const ERROR_REASONS = {
  semantic_timeout: ['任务理解超时', '本次消息尚未完成任务理解，未由此消息启动新任务。请检查当前模型响应速度；可切换模型后重试。若在补充既有草稿，请核对完整目标及限制，避免遗漏新要求。'],
  semantic_unavailable: ['暂时无法理解本次任务', '任务理解模型没有返回可用结果，未由此消息启动新任务。请检查当前模型服务后重试。若有待确认的旧草稿，请同时保留此前目标及限制。'],
  session_capacity: ['没有空闲的编排会话位', '同时打开的编排会话最多 8 个，而且都在使用中。请先在一个闲置会话里结束正在进行的任务或关闭该会话，再重新发送本任务。'],
  attachments_unsupported: ['附件没有被读入本次任务', '请在 Orchestra 的「任务 → 用自然语言规划任务」先生成计划，再展开「为本次任务补充材料」，选择可读步骤并授权。支持 UTF-8 的 .txt、.md、.csv，每份最多 64 KiB。'],
  only_attachments: ['这条消息只有附件，没有任务目标', '请在 Orchestra 的「任务 → 用自然语言规划任务」填写交付目标；生成计划后，在「为本次任务补充材料」选择文件和可读步骤。'],
  plan_updated: ['本次计划已更新，尚未启动', '材料授权或目标调整已生成新计划。请在 Orchestra 面板取回最新计划，重新核对后确认启动。'],
  goal_empty: ['这条消息没有任务目标', '请说明要交付的结果，以及本次可使用的材料。'],
  goal_too_long: ['任务目标超过长度上限', '请把目标压缩到 2000 个字符以内，其余材料用已授权的只读文件提供。'],
} as const

type ChatErrorReason = keyof typeof ERROR_REASONS

export function isChatErrorReason(value: unknown): value is ChatErrorReason {
  return typeof value === 'string' && Object.hasOwn(ERROR_REASONS, value)
}

export function isChatPlanningIssue(value: unknown): value is PlanningIssue {
  return typeof value === 'string' && Object.hasOwn(PLANNING_ISSUES, value)
}

function displayTitle(title?: string | null): string {
  return title?.replace(/\s+/gu, ' ').trim().slice(0, 120) ?? ''
}

function taskHeading(title: string | null | undefined, state: string): string {
  const name = title?.trim()
  return name ? `Orchestra ${state} · ${name}` : `Orchestra ${state}`
}

function sentence(value: string): string {
  return /[。？！.!?]$/u.test(value) ? value : value + '。'
}

function stepTitle(step: Step): string {
  const title = displayTitle(step.title)
  return title && title !== step.node_id ? `「${title}」` : '一个未命名步骤'
}

function evidenceNames(items: string[]): string[] {
  return [...new Set(items.map((item) => /^[\p{L}\p{N}_ -]+\.[\p{L}\p{N}]{1,12}$/u.test(item) ? `「${item}」` : operatorReason(item)))]
}

export function chatDecisionTitle(title: string | null, kind: string): string {
  return displayTitle(title) || ({
    pre_execution: '执行前审批', verify_human: '核验执行结果', audit_result: '审核结果',
    rule_ambiguous: '确认后续分支', manual_gate: '人工确认',
    action_overrun: '核对已超时的操作', report_contradicted: '核对不一致的执行记录',
  } as Record<string, string>)[kind] || '本次待处理事项'
}

function decisionDescription(decision: Decision, unique: boolean): string {
  const title = chatDecisionTitle(decision.title, decision.kind)
  const evidence = evidenceNames(decision.required_evidence ?? [])
  const available = decision.kind !== 'audit_result' && decision.choices?.includes('approved')
  if (decision.explanation) {
    const view = decision.explanation
    return `${view.title}：${sentence(view.summary)}${sentence(view.reason)}请点击会话中的「前往审批中心」，核对材料并选择操作。等待你处理期间，无需反复查询任务状态。`
  }
  const next = unique && !evidence.length && !decision.reason && available
    ? '请在聊天审批卡中查看并选择。'
    : '请在 Orchestra 面板打开待办，查看核验材料和可用的处理方式。'
  return `「${title}」。${decision.reason ? sentence(operatorReason(decision.reason)) : ''}${evidence.length
    ? `需要补充或核对：${evidence.join('、')}。` : ''}${next}`
}

function blockingDescription(step: BlockingStep): string {
  const state = ({
    blocked_pre: '执行前暂停',
    blocked_post: '执行结果待核验',
    startup_unknown: '启动情况待核实',
    indeterminate_side_effect: '外部影响待核实',
  } as Record<string, string>)[step.status] ?? operatorStatus(step.status)
  const evidence = evidenceNames(step.missing)
  const files = [...new Set(step.outstanding_files ?? [])].map((file) => `「${file}」`)
  return `${stepTitle(step)}${state}。${step.reason ? sentence(operatorReason(step.reason)) : ''}${evidence.length
    ? `待补或待核对：${evidence.join('、')}。` : ''}${files.length
    ? `当前计划还缺${files.join('、')}的交付记录。如果原要求只是保留这些文件，请先核对计划里的交付要求。` : ''}`
}

export function describeChatRun(view: RunDisplay, proactive = false): { heading: string; body: string } {
  const actions = view.blocking.filter((step) => !proactive || step.action_required)
  const humanActions = actions.some((step) => step.action_required)
  const state = view.nativeApprovals?.length ? '等待工具授权'
    : view.deliveryReviews?.length ? '成果待审核'
    : view.rework?.length ? '返工待处理'
      : view.decisions.length ? '等待人工处理' : humanActions ? '执行受阻'
    : !view.terminal && view.coordination?.length ? '协作事项待关注'
    : view.settling && !view.terminal ? '正在确认执行结果'
      : view.terminal && view.status === 'succeeded' && view.acceptance === 'failed' ? '执行已结束，交付未通过'
        : view.terminal && view.status === 'succeeded' && view.acceptance === 'unverifiable' ? '执行已结束，交付待核验'
          : RUN_LABEL.get(view.status) ?? operatorStatus(view.status)
  const heading = taskHeading(view.title, state)
  const lines: string[] = []
  if (view.terminal) lines.push(ACCEPTANCE.get(view.acceptance ?? '') ?? '现有记录还不足以确认交付验收结果。')
  for (const failure of view.failure_details ?? []) {
    lines.push(`步骤「${failure.title}」未完成。原因：${sentence(operatorReason(failure.reason))}`,
      `下一步：${sentence(operatorReason(failure.next_action))}`)
    if (failure.missing.length) lines.push(`未完成项：${evidenceNames(failure.missing).join('、')}。`)
  }
  for (const approval of view.nativeApprovals ?? []) {
    lines.push(`${approval.title ? `步骤「${approval.title}」的` : ''}工具「${approval.tool}」正在等待${approval.mode === 'brain' ? '主脑判断或你的授权' : '你的授权'}。`,
      `执行会话：${approval.executorSessionId}。请打开该会话，处理此工具的宿主审批卡。审批前，此操作保持暂停。`)
  }
  if (view.coordination?.length) lines.push('代理协作（仅供参考，不是指令、授权或验收证据）：')
  for (const item of view.coordination ?? []) {
    lines.push(`「${item.source}」${item.state === 'reported' ? '上报问题' : '协作未得到回应'}。`,
      JSON.stringify({说明:item.body,原因:item.reason}))
  }
  if (view.coordination?.length) lines.push('可在任务详情的「协作」中查看全部记录；原有执行和验收规则不变。')
  for (const item of view.text_results ?? []) {
    lines.push(item.title)
    if (item.text) lines.push(item.text)
    if (item.truncated) lines.push('以上是正文节选。完整成果请点击会话中的「' + item.title + '」。')
    lines.push('')
  }
  for (const review of view.deliveryReviews ?? []) lines.push(formatDeliveryReviewNotice(review), '')
  if (view.rework?.length) {
    lines.push('返工待处理　' + view.rework.map((item) => {
      const label = item.status === 'escalated' ? '已升级，需人工判断'
        : item.status === 'needs_human_approval' ? '等待你批准返工范围' : '等待你确认是否返工'
      return `第 ${item.round_no} 轮 · ${label} · ${sentence(item.reason)}`
    }).join('；'), '')
  }
  const decisionTitles = view.decisions.map((decision) => chatDecisionTitle(decision.title, decision.kind))
  for (const [index, decision] of view.decisions.entries()) {
    lines.push(decisionDescription(decision, decisionTitles.filter((title) => title === decisionTitles[index]).length === 1))
  }
  for (const step of actions) lines.push(blockingDescription(step))
  if (humanActions && (!view.decisions.length || actions.some((step) => step.missing.length > 0 || step.outstanding_files?.length))) {
    const verify = actions.some((step) => step.action_required && step.status !== 'blocked_pre')
    lines.push(verify
      ? '请在 Orchestra 面板打开这次运行的「结果」，查看已登记文件，再核对对应步骤和计划里的交付要求。'
      : '请在 Orchestra 面板打开对应步骤，查看仍需满足的执行条件。')
  }
  if (humanActions) {
    const finished = view.counts.find(({ status }) => status === 'done')?.count
    if (finished) lines.push(`已有 ${finished} 个步骤完成执行。`)
  }
  if (!view.terminal && !view.decisions.length && !view.deliveryReviews?.length && !view.nativeApprovals?.length && !actions.length && !proactive && view.counts.length) {
    const counts = view.counts.map(({ status, count }) => `${operatorStatus(status)} ${count} 项`)
    lines.push(`步骤情况：${counts.join('，')}。`)
  }
  const nodes = view.nodes ?? []
  const listed = new Set([...actions.map((step) => step.node_id), ...(view.failure_details ?? []).map(failure => failure.node_id)])
  const highlighted = nodes.filter((node) => ATTENTION_STEP.has(node.status) && !listed.has(node.node_id))
    .filter((node) => !view.terminal || node.status !== 'started' && node.status !== 'verifying' && node.status !== 'waiting')
  for (const node of highlighted.slice(0, 5)) {
    const dependencies = (node.waiting_on ?? []).flatMap((id) => {
      const dependency = nodes.find((candidate) => candidate.node_id === id)
      return dependency?.title ? [stepTitle(dependency)] : []
    })
    lines.push(`${stepTitle(node)}${operatorStatus(node.status)}${dependencies.length ? `，还在等待${dependencies.join('、')}` : ''}。`)
  }
  if (view.terminal || view.delivery_checks.length > 0) {
    if (!view.terminal) lines.push(ACCEPTANCE.get(view.acceptance ?? '') ?? '现有记录还不足以确认交付验收结果。')
    // 文件层结论与内容结论分开说：自动核对只看登记、大小与有效期（D01）。
    if (view.acceptance === 'passed' && view.delivery_checks.some((item) => item.kind === 'artifact')) lines.push('以上自动核对只覆盖文件是否登记、大小与有效期；内容是否达到要求仍需人工核对。')
    for (const check of view.delivery_checks.filter(({ outcome }) => outcome !== 'passed').slice(0, 5)) {
      const title = check.title || check.file_name || (check.kind === 'tool_evidence' ? '工具执行证据'
        : check.kind === 'chat/text_result' ? '会话正文' : '交付文件')
      if (check.reason) lines.push(`「${title}」${check.outcome === 'failed' ? '未达到验收要求' : '验收结果待核实'}。${sentence(operatorReason(check.reason))}`)
    }
  }
  const accepted = new Set(view.delivery_checks.flatMap(({ artifact_id, kind, outcome }) =>
    artifact_id && kind === 'artifact' && outcome === 'passed' ? [artifact_id] : []))
  const shownText = new Set(view.delivery_checks.filter((c) => c.kind === 'chat/text_result' && c.outcome === 'passed').map((c) => c.artifact_id))
  const registered = view.artifacts.filter((file) => !shownText.has(file.artifact_id)).flatMap(({ artifact_id, file_name }) => file_name ? [{ artifact_id, file_name }] : [])
  const acceptedFiles = registered.filter(({ artifact_id, file_name }) =>
    accepted.has(artifact_id) && registered.filter((file) => file.file_name === file_name).length === 1)
    .map(({ file_name }) => file_name)
  const registeredFiles = [...new Set(registered.map(({ file_name }) => file_name))].filter((name) => !acceptedFiles.includes(name))
  const fileList = (files: string[]) => files.map((name) => `「${name}」`).join('、')
  if (acceptedFiles.length) lines.push(`已通过验收的文件：${fileList(acceptedFiles)}。`)
  if (registeredFiles.length) lines.push(`已登记文件：${fileList(registeredFiles)}。${!view.terminal
    ? '任务的交付验收尚无通过结论。' : ''}`)
  if (view.terminal && (PENDING_EFFECT.has(view.status) || nodes.some((step) => PENDING_EFFECT.has(step.status)))) {
    lines.push('请在 Orchestra 面板核对尚未确认的外部影响，再决定是否重试。')
  } else if (view.terminal && (view.acceptance === 'failed' || view.acceptance === 'unverifiable')) {
    lines.push('请在 Orchestra 面板查看交付验收详情，根据缺失材料或未通过的项目补齐交付。')
  } else if (view.status === 'failed' || view.status === 'orphaned') {
    lines.push('请在 Orchestra 面板查看执行记录，确认受影响的步骤后再决定是否重试。')
  }
  return { heading, body: lines.join('\n') }
}

export type ChatOutcome =
  | { state: 'started'; title: string; run_id: string; task_id?: string }
  | { state: 'plan_ready'; plan_id: string; title: string }
  | { state: 'quality_blocked'; issues: string[]; plan_id: string; title: string }
  | { state: 'approval_pending'; plan_id?: string; run_id?: string; title: string }
  | { state: 'launch_declined'; plan_id: string; title: string }
  | { state: 'stop_requested'; run_id: string; status: string; skipped_irreversible: number; pending_decisions: number }
  | { state: 'approved' | 'rejected'; run_id: string; decision_id: string; title: string }
  | { state: 'clarification_required' | 'task_held' | 'command_unavailable' | 'queued' | 'draft_discarded'; message: string }
  | { state: 'usage'; command?: string; message: string }
  | { state: 'error'; code: AnyOrchErrorCode; retryable: boolean; planning_issue?: PlanningIssue; reason?: ChatErrorReason }

function startErrorDisplay(outcome: Extract<ChatOutcome, { state: 'error' }>): readonly [string, string] {
  if (outcome.reason) return ERROR_REASONS[outcome.reason]
  if (outcome.planning_issue) return PLANNING_ISSUES[outcome.planning_issue]
  switch (outcome.code) {
    case 'WORKFLOW_DEFINITION_INVALID':
    case 'WORKFLOW_VALIDATION_FAILED':
      return ['规划模型生成的计划未通过校验', '计划或流程的结构未通过校验，本次执行尚未开始。可切换主脑模型后重新发送原任务。']
    case 'COMMAND_BUSY':
      return ['规划服务正在处理其他请求', '当前没有空闲的规划执行位。请稍后重新发送原任务。']
    case 'OPERATION_TIMEOUT':
      return ['规划超时', '规划时间已用完。可在「设置 → 规划时限」延长时间，或更换主脑模型后再发送任务。']
    case 'PROTOCOL_VERSION_MISMATCH':
      return ['规划模型设置与本次请求不一致', '请检查 DSH 当前使用的主脑模型与思考设置，确认后重新发送原任务。']
    case 'VERDICT_UNSUPPORTED':
      return ['当前 DSH 宿主缺少所需的规划能力', '请检查 DSH 的 Orchestra 安装和主脑模型设置，恢复规划能力后重新发送原任务。']
    case 'WORKFLOW_NOT_PUBLISHED':
      return ['没有可用于本次任务的已发布流程', '请在 Orchestra 发布可复用的流程，再发送原任务。']
    case 'SERVICE_UNAVAILABLE':
      return ['启动任务所需的服务暂时不可用', '请检查 DSH 和主脑模型服务是否可用。服务恢复后，可重新发送原任务。']
    case 'FORBIDDEN':
      return ['当前会话或工作区授权无法启动任务', '请检查原会话和工作区授权是否仍有效，并确认主脑模型可用。']
    case 'PAYLOAD_SCHEMA_INVALID':
      return ['需要有效的文字任务目标', '请用 1 至 2000 个字符说明要交付的结果，以及本次可使用的材料。']
    case 'CONFIRMATION_REQUIRED':
      return ['这条消息没有可查询的任务回执', '如果已经发送明确的任务，可在当前会话检查 Orchestra 自动接管设置。']
    case 'OPERATION_ID_CONFLICT':
      return ['这条消息与已有的接单记录冲突', '若要布置新的任务，请将完整要求作为一条新消息发送。']
    default:
      return ['未能启动本次任务', 'Orchestra 没有返回成功的接单回执。请检查 DSH 和 Orchestra 的服务状态。']
  }
}

function errorDisplay(outcome: Extract<ChatOutcome, { state: 'error' }>, action?: 'start' | 'status' | 'artifact' | 'review' | 'stop'): string {
  if (outcome.reason) return ERROR_REASONS[outcome.reason].join('')
  switch (outcome.code) {
    case 'NOT_FOUND':
      return action === 'artifact' ? '这次运行里没有找到该文件。请先查看已登记的文件，再选择要打开的一份。'
        : action === 'status' ? '这次查询没有找到匹配的任务。请在 Orchestra 面板选择要查看的任务。'
        : '当前会话中找不到对应的任务或处理事项。请回到原会话，或在 Orchestra 面板打开对应任务。'
    case 'FORBIDDEN':
      return '当前会话无法执行这项操作。请回到发起任务的会话，打开对应任务或待办后重试。'
    case 'CONFIRMATION_REQUIRED':
      return '这项操作需要人工确认。请在 Orchestra 面板打开待办处理。'
    case 'CONFIRMATION_EXPIRED':
    case 'DECISION_REVISION_CONFLICT':
    case 'CONFIRMATION_MISMATCH':
      return action === 'artifact'
        ? '文件内容与登记记录不一致，暂时无法展示。请核对该文件的来源并重新登记。'
        : '这次确认已经失效或待办内容已更新。请重新打开待办，核对当前内容后再决定。'
    case 'OPERATION_EXPIRED':
      return action === 'artifact' ? '文件已超过保留期限。请联系负责这项任务的人获取原件。'
        : '这项操作已过期。请从 Orchestra 面板重新打开对应任务后再试。'
    case 'EVIDENCE_SOURCE_UNAVAILABLE':
      return '当前无法读取所需的文件内容或核验材料。请打开对应步骤核对材料是否已登记。'
    case 'RESOLUTION_NOT_AVAILABLE':
      return action === 'artifact' ? '这份文件暂时无法在聊天中打开。请在 Orchestra 面板的产物列表选择对应文件预览或下载。'
        : action === 'status' ? '当前会话里有多个同名任务。请在 Orchestra 面板选择要查看的任务。'
        : '当前不能在聊天中处理这项待办。请到 Orchestra 面板查看可用操作和所需材料。'
    case 'RANGE_TOO_LARGE':
      return '本次读取超出限制。请缩小查询范围，或在 Orchestra 面板选择具体文件。'
    case 'PAYLOAD_SCHEMA_INVALID':
      return '这次操作的参数不完整。请说明要查看的任务、文件或待办。'
    default:
      return outcome.retryable
        ? 'Orchestra 暂时无法完成这项操作。请刷新任务状态后再试。'
        : 'Orchestra 无法完成这项操作。请在面板打开对应任务查看当前状态。'
  }
}

export function describeChatOutcome(outcome: ChatOutcome, action?: 'start' | 'status' | 'artifact' | 'review' | 'stop') {
  switch (outcome.state) {
    case 'started':
      return { heading: taskHeading(outcome.title, '已接单'), body: '已接收任务，执行进度可在 Orchestra 面板查看。'
        // 纯文字回执给出可直接搜索的完整任务编号，不假定宿主有可点工具卡（T16）。
        + (outcome.task_id ? '\n在 Orchestra 的「任务」中搜索任务编号：' + outcome.task_id : '') }
    case 'plan_ready':
      return { heading: taskHeading(outcome.title, '计划已准备'),
        body: '已按本次要求保存计划草稿。打开本会话的 Orchestra → 任务 → 继续未启动的计划，可核对目标和限制条件，再决定是否启动。' }
    case 'quality_blocked':
      return { heading: taskHeading(outcome.title, '未启动本次任务'), body: [
        ...new Set(outcome.issues.slice(0, 5).map((issue) => sentence(operatorReason(issue)))),
        '任务目标已保留。请处理以上具体条件，再继续本次任务。',
      ].join('\n') }
    case 'approval_pending':
      return { heading: taskHeading(outcome.title, '等待人工批准'), body: '目前没有记录新的批准决定。要继续处理，可重新打开审批卡或在 Orchestra 面板查看待办。' }
    case 'stop_requested': {
      const statusText: Record<string,string> = {
        cancelled:'已停止', succeeded:'此前已完成', succeeded_with_unverified:'已结束，有待核实项',
        failed:'运行已失败', failed_with_unverified:'运行已失败，有待核实项', orphaned:'运行已失去关联'
      }
      const label = statusText[outcome.status]
      const details = [
        outcome.skipped_irreversible ? `有 ${outcome.skipped_irreversible} 个不可逆步骤仍需核实。` : '',
        outcome.pending_decisions ? `还有 ${outcome.pending_decisions} 项人工决定。` : ''
      ].filter(Boolean)
      return {heading:'Orchestra ' + (label ?? '已收到停止请求'),
        body:[label ? '当前结果已登记，请查看执行记录。' : '停止请求已登记，正在等待执行器确认。',...details].join('\n')}
    }
    case 'launch_declined':
      // 启动被拒绝时既没有运行也没有待办，不能指向面板里的空入口（C06）。
      return { heading: taskHeading(outcome.title, '未启动本次任务'), body: '已保留本次草稿。打开本会话的 Orchestra → 任务 → 继续未启动的计划，可核对原方案并重新确认。' }
    case 'approved':
    case 'rejected':
      return { heading: taskHeading(outcome.title, outcome.state === 'approved' ? '已登记批准' : '已登记拒绝'),
        body: '后续执行状态可在 Orchestra 面板查看。' }
    case 'clarification_required':
      return { heading: 'Orchestra 需要明确的交付目标', body: outcome.message }
    case 'task_held':
      return { heading: 'Orchestra 已暂缓任务', body: outcome.message }
    case 'draft_discarded': return { heading: 'Orchestra 已放弃草稿', body: outcome.message }
    case 'usage':
      return { heading: `Orchestra 用法 · /${outcome.command ?? 'orchestra'} 任务内容`, body: outcome.message }
    case 'command_unavailable':
      return { heading: 'Orchestra 任务命令暂不可用', body: outcome.message }
    case 'queued':
      return { heading: 'Orchestra 已排队新消息', body: outcome.message }
    case 'error':
      if (action === 'start') {
        const [heading, body] = startErrorDisplay(outcome)
        return { heading: `Orchestra ${heading}`, body }
      }
      return { heading: 'Orchestra 未能完成本次操作', body: errorDisplay(outcome, action) }
  }
}

export function chatText({ heading, body }: { heading: string; body: string }): string {
  return body ? `${heading}\n${body}` : heading
}
