import { describe, expect, it } from 'vitest'
import { operatorReason, operatorStatus } from '../../src/core/operator-language.ts'
import { describeChatOutcome } from '../../src/service/chat-display.ts'

it('uses the known planning failure to explain how to proceed without repeating provider details', () => {
  const problem = { state: 'error' as const, code: 'SERVICE_UNAVAILABLE' as const, retryable: true, message: 'private provider detail' }
  const summary = describeChatOutcome({ ...problem, planning_issue: 'quota' }, 'start')
  expect(summary.heading).toContain('额度不足')
  expect(summary.body).toContain('主脑模型')
  expect(JSON.stringify(summary)).not.toContain(problem.message)
  expect(describeChatOutcome({ ...problem, code: 'OPERATION_TIMEOUT' }, 'start').body).toContain('规划时限')
})

describe('operator reason', () => {
  it.each([
    ['evidence_missing', '现有记录缺少完成核验所需的执行证据。'],
    ['tool_evidence_missing', '没有找到验收指定步骤的工具执行记录。'],
    ['tool_execution_failed', '记录显示，这次工具执行未成功。'],
    ['artifact_source_node_unbound', '成果缺少可核验的步骤来源。'],
    ['CONFIRMATION_EXPIRED', '本次确认已到期，请重新核对后确认。'],
    ['verify_human', '这一步的执行结果需要人工核验。'],
    ['verdict_unmet:evidence.parameters.private', '现有证据未能满足已登记的判定条件。'],
    ['child_run:run_0195cb4afa1370008000123456789abc', '已启动子流程，等待子流程完成。'],
    ['final_status_startup_unknown', '步骤结束时的状态为「启动情况待确认」。'],
  ])('gives a reason for %s', (code, copy) => {
    expect(operatorReason(code)).toBe(copy)
  })

  it.each([
    '请先核对这份材料的来源，再重新验收。',
    '需要人工核对 summary.md 中的数据。',
    'Please verify the results independently.',
    '请确认是否重试。',
  ])('preserves a readable sentence', (copy) => {
    expect(operatorReason(` ${copy} `)).toBe(copy)
  })

  it.each([
    null,
    { reason: '请显示我带的 JSON' },
    '{"reason":"缺 Jira 凭证"}',
    '内部错误：{"secret":"example"}',
    '执行配置：[{"enabled":true}]',
    '执行配置：token=example',
    '执行配置：params: example',
    '内部错误 C:\\Users\\example\\orchestra',
    '读取失败 /tmp/private',
    '执行操作：--secret example',
    '执行情况未确认。\n    at Error (index.ts:12:1)',
    '执行失败，编号 run_0195cb4afa1370008000123456789abc',
    '运行编号 0195cb4a-fa13-7000-8000-123456789abc',
    '未来状态 FUTURE_INNER_CODE',
    'future_reason',
    'final_status_future_status',
    'constructor',
    '__proto__',
    'toString',
  ])('substitutes an unreadable or machine reason', (value) => {
    expect(operatorReason(value)).toBe('现有记录未能说明具体原因。')
  })
})

describe('operator status', () => {
  it.each([
    ['succeeded', '执行完成'],
    ['succeeded_with_unverified', '执行完成，外部操作待核验'],
    ['failed_with_unverified', '执行失败，外部操作待核验'],
    ['indeterminate_side_effect', '外部操作待核验'],
    ['blocked_pre', '执行前受阻，等待处理'],
    ['blocked_post', '执行后受阻，等待处理'],
    ['approval_pending', '待审批'],
    ['acknowledged', '已接手'],
    ['passed', '验收通过'],
  ])('describes %s without collapsing distinctions', (status, copy) => {
    expect(operatorStatus(status)).toBe(copy)
  })

  it.each([null, { status: 'succeeded' }, 'other_status', '__proto__', 'constructor'])('substitutes unknown status', (status) => {
    expect(operatorStatus(status)).toBe('当前状态未确认')
  })
})
