export const ORCHESTRA_APPROVAL_HEADING = 'Orchestra 审批'

type ApprovalFields = {
  task?: string | null
  step: string
  reason: string
  operation: string
  consequence: string
  planSteps?: string[]
  deliverables?: string[]
  planVersion?: string
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
    // 步骤描述的长度已由计划 schema 限制。保留每一步的完整正文和受影响对象。
    const plain = (value: string) => value.replace(/[\s\u202a-\u202e\u2066-\u2069]+/gu, ' ').trim()
    lines.push('计划步骤　共 ' + fields.planSteps.length + ' 步')
    for (const [i, text] of fields.planSteps.entries()) lines.push((i + 1) + '. ' + plain(text))
    for (const item of fields.deliverables ?? []) lines.push('将交付　' + plain(item))
    if (fields.planVersion) lines.push('计划版本　' + plain(fields.planVersion))
  }
  if (fields.confirmUntil) lines.push('有效至　' + fields.confirmUntil)
  return lines.join('\n')
}
