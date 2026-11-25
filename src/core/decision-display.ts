import { operatorReason } from './operator-language.ts'

/** Human-readable explanations only. The service remains the authority for available actions. */
export type DecisionDisplaySource = {
  kind: string
  payload?: unknown
  target_summary?: string | null
  allowed_resolutions?: readonly string[] | null
  required_evidence?: readonly string[] | null
  expires_at?: string | null
  expiry_effect?: string | null
  available_recovery_outcomes?: Partial<Record<'confirm_not_started' | 'confirm_not_applied', 'retry' | 'failed'>>
  execution_observation?: {
    reason: 'action_timeout' | 'lease_lost' | null
    observed_running: boolean
    has_tool_call: boolean
    timeout_ms: number | null
  }
}

type DecisionExplanation = { title: string; summary: string; reason: string; evidenceGuidance: string }

const EXPLANATIONS: Readonly<Record<string, DecisionExplanation>> = {
  pre_execution: {
    title: '执行前确认', summary: '这一步需要获得批准后才能执行。',
    reason: '请核对要执行的操作、目标和影响，再决定是否批准。',
    evidenceGuidance: '核对任务要求与步骤中的操作范围。内容不清楚时，先查看任务详情。',
  },
  action_overrun: {
    title: '执行超时，等待处理', summary: '这一步已达到执行时限，最终结果仍待确认。',
    reason: '系统还不能确认原执行的结果，需要你选择如何继续处理。',
    evidenceGuidance: '查看该步骤的执行日志、工具结果或实际操作目标。超时本身不能证明操作失败或已经停止。',
  },
  startup_unknown: {
    title: '启动情况待核实', summary: '现有记录还不能确认这一步是否已启动。',
    reason: '系统缺少可靠的启动或停止凭据。请先核对实际执行情况，再选择下方可用的处理方式。',
    evidenceGuidance: '先查看该步骤的执行日志或原执行会话。只有亲自核对到本次执行已启动，才能提交人工确认；无法核实时不要勾选。',
  },
  abandon_ack: {
    title: '确认停止跟踪', summary: '相关步骤已停止跟踪，外部影响仍未核实。',
    reason: '请确认是否接受未核实的影响。能够继续观察原执行时，也可以恢复跟踪。',
    evidenceGuidance: '核对相关步骤的执行日志和实际操作目标。停止跟踪不表示外部操作没有发生。',
  },
  verify_human: {
    title: '人工核验', summary: '需要核验这一步的执行条件或结果。',
    reason: '现有记录不足以完成核验，需要补充可核实的依据。',
    evidenceGuidance: '核对步骤要求、输入材料、可用工具和执行记录。涉及外部操作时，还需核对本次执行对应的系统凭据。',
  },
  audit_result: {
    title: '结果复核', summary: '这一步的结果需要复核。',
    reason: '请对照任务要求检查结果，再选择通过或拒绝。',
    evidenceGuidance: '核对交付成果、验收条件和执行记录。结果不满足要求时，不要批准。',
  },
  rule_ambiguous: {
    title: '选择后续分支', summary: '当前条件匹配了多个流程分支。',
    reason: '系统无法确定应执行哪个分支，需要你选择后续路径。',
    evidenceGuidance: '核对分支条件和任务目标，选择符合当前情况的一条。',
  },
  report_contradicted: {
    title: '结果不一致', summary: '执行回报与已记录的处理决定不一致。',
    reason: '请核对本次回报与原处理依据，再决定采纳哪一项。',
    evidenceGuidance: '比较回报中的执行结果、尝试次数与原处理依据。不要只凭最新一条消息作出判断。',
  },
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  approved: '批准执行', rejected: '拒绝执行', expired: '按到期处理',
  continue: '继续执行', abort: '停止执行',
  confirm_applied: '确认外部操作已发生', confirm_not_applied: '确认外部操作未发生',
  confirm_started: '按系统凭据确认已启动', confirm_not_started: '确认未启动',
  confirm_started_attested: '人工确认已启动', continue_tracking: '再观察 120 秒',
  continue_wait: '延长等待', abandon: '停止跟踪',
  uphold_report: '采纳回报', uphold_decision: '保留原处理决定',
}

const ACTION_CONSEQUENCES: Readonly<Record<string, string>> = {
  approved: '批准本项请求。后续执行仍受任务范围和已有权限约束。',
  rejected: '拒绝本项请求。系统不会按本项请求继续执行。',
  expired: '按本项已经记录的到期规则处理。',
  continue: '按已批准的任务范围继续执行。',
  abort: '请求停止执行；实际停止情况仍以执行回执为准。',
  confirm_applied: '依据系统核验凭据记录外部操作已发生。',
  confirm_not_applied: '依据系统核验凭据记录外部操作未发生。',
  confirm_not_started: '依据宿主停止凭据记录本次执行未启动。',
  confirm_started: '使用系统已有凭据记录启动事实，继续观察原执行。不会重新派发任务。',
  confirm_started_attested: '记录你亲自核对到的启动事实，继续观察原执行。此确认不代表执行成功。',
  continue_tracking: '再观察原执行 120 秒，等待新的回执。不会重新执行任务，也不会恢复已停止的工具调用。',
  continue_wait: '延长对原执行的观察时间，最多可延长三次。不会重新执行任务，也不会恢复已停止的工具调用。',
  abandon: '停止跟踪原执行，并进入未核实影响确认。此操作不能证明执行已停止或外部操作未发生。',
  uphold_report: '采纳这次执行回报，按回报更新步骤结果。',
  uphold_decision: '保留原处理决定，不采用这次有冲突的回报。',
}

function lookup<T>(values: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined
}

export function decisionActionLabel(decision: DecisionDisplaySource, resolution: string): string | undefined {
  const base = decision.kind === 'rule_ambiguous' && resolution === 'approved' ? '继续所选分支'
    : decision.kind === 'abandon_ack' && resolution === 'approved' ? '确认接受未核实影响'
      : decision.kind === 'abandon_ack' && resolution === 'rejected' ? '恢复跟踪' : lookup(ACTION_LABELS, resolution)
  if (!base) return undefined
  const outcome = resolution === 'confirm_not_started' || resolution === 'confirm_not_applied'
    ? decision.available_recovery_outcomes?.[resolution] : undefined
  return base + (outcome === 'retry' ? '并发起新尝试' : outcome === 'failed' ? '并将此步骤记为失败' : '')
}

export function decisionActionConsequence(decision: DecisionDisplaySource, resolution: string): string {
  if (decision.kind === 'rule_ambiguous' && resolution === 'approved') return '按你选择的分支继续流程。请先选择后续分支。'
  if (decision.kind === 'abandon_ack' && resolution === 'approved') return '记录你接受相关步骤的影响尚未核实。不会将未核实的影响改为已核实。'
  if (decision.kind === 'abandon_ack' && resolution === 'rejected') return '恢复对原执行的观察，继续等待结果。不会重新执行任务。'
  const outcome = resolution === 'confirm_not_started' || resolution === 'confirm_not_applied'
    ? decision.available_recovery_outcomes?.[resolution] : undefined
  const consequence = lookup(ACTION_CONSEQUENCES, resolution) ?? '请先核对本项操作的适用条件。'
  return consequence + (outcome === 'retry' ? '随后按既有授权发起新的执行尝试。' : outcome === 'failed' ? '随后将此步骤记为失败。' : '')
}

export function describeDecision(decision: DecisionDisplaySource): DecisionExplanation & { expiry: string } {
  const explanation = lookup(EXPLANATIONS, decision.kind) ?? {
    title: '待确认事项', summary: '这项处理的说明暂不可用。',
    reason: '请先查看任务详情与执行记录，确认需要处理的内容。',
    evidenceGuidance: '当前记录未列出核验材料。请先核对任务详情，不要推测执行结果。',
  }
  const observation = decision.execution_observation
  // A timeout is not proof of a missing start. Preserve that distinction for older recovery cards too.
  const timedOut = observation?.reason === 'action_timeout'
  const leaseLost = observation?.reason === 'lease_lost'
  const observed = observation?.observed_running === true || observation?.has_tool_call === true
  const recovery = decision.kind === 'startup_unknown' || decision.kind === 'action_overrun'
  const timeoutSummary = timedOut && recovery
    ? `这一步已达到${observation.timeout_ms ? ` ${Math.ceil(observation.timeout_ms / 1000)} 秒` : ''}执行时限，最终结果仍待确认。`
    : null
  const summary = timeoutSummary ?? (recovery && leaseLost ? '本次执行的工具授权已失效，最终结果仍待确认。'
    : decision.target_summary ? operatorReason(decision.target_summary) : explanation.summary)
  const title = recovery && timedOut ? '执行超时，等待处理' : recovery && leaseLost ? '执行授权失效，等待处理' : explanation.title
  const reason = recovery && timedOut
    ? `${observed ? '记录显示本次执行已开始。' : ''}系统已停止新的工具调用，继续等待原执行回报。请选择后续处理方式。`
    : recovery && leaseLost ? `${observed ? '记录显示本次执行已开始。' : ''}系统已停止新的工具调用，需要核对原执行是否结束。`
      : explanation.reason
  const expiry = decision.kind === 'report_contradicted' ? '仅由人工处理，系统不会自动结束本项。'
    : !decision.expires_at ? '本项未设置自动处理期限。步骤的执行或观察时限仍按原规则计时。'
      : decision.expiry_effect === 'auto_resolve' ? '到期后按已记录的规则自动处理。'
        : decision.expiry_effect === 'escalate_only' ? '到期后升级为人工处理，不会自动批准。'
          : decision.expiry_effect === 'none' ? '到期后不会自动处理。'
            : '到期后的处理规则尚未记录。请在期限前核对并处理。'
  return { ...explanation, title, summary, reason, expiry }
}
