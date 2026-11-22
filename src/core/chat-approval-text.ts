export const ORCHESTRA_APPROVAL_HEADING = 'Orchestra 审批'

type ApprovalFields = {
  task?: string | null
  step: string
  reason: string
  operation: string
  consequence: string
  planSteps?: string[]
  confirmUntil?: string
}

function singleLine(text: string, limit: number) {
  const value = text.replace(/[\s\u202a-\u202e\u2066-\u2069]+/gu, ' ').trim()
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value
}

export function formatChatApproval(fields: ApprovalFields) {
  const lines = [
    fields.confirmUntil ? ORCHESTRA_APPROVAL_HEADING + ' · 二次确认' : ORCHESTRA_APPROVAL_HEADING,
    '任务　' + (singleLine(fields.task ?? '', 200) || '任务名称未记录'),
    '步骤　' + singleLine(fields.step, 120),
    '审批原因　' + singleLine(fields.reason, 180),
    '审批内容　' + singleLine(fields.operation, 180),
    '确认后　' + singleLine(fields.consequence, 180),
  ]
  if (fields.planSteps?.length) {
    const examples = fields.planSteps.slice(0, 3).map((step) => singleLine(step, 36))
    lines.push('计划步骤　' + examples.join('、') + (fields.planSteps.length > 3 ? '等，可在任务计划中查看完整列表' : ''))
  }
  if (fields.confirmUntil) lines.push('有效至　' + fields.confirmUntil)
  return lines.join('\n')
}
