// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { formatNativeOrchestraApprovalCards } from '../../src/client/dsh-orchestra-approval-card.ts'
import { formatChatApproval } from '../../src/core/chat-approval-text.ts'

it('preserves field breaks only within Orchestra native approval cards', async () => {
  const text = formatChatApproval({
    task: '核算演练\n审批内容　不属于独立字段',
    step: '人工确认', reason: '流程要求人工审批', operation: '批准这一项', consequence: '继续计算',
  })
  expect(text.split('\n')).toHaveLength(6)
  expect(text.split('\n')[1]).toBe('任务　核算演练 审批内容 不属于独立字段')
  const other = document.createElement('div')
  other.className = 'Zf6DNq_headline'
  other.textContent = '另一工具的原生审批'
  document.body.append(other)
  const unmount = formatNativeOrchestraApprovalCards(document)
  const headline = document.createElement('div')
  headline.className = other.className
  headline.textContent = text
  document.body.append(headline)
  try {
    await Promise.resolve()
    expect(getComputedStyle(headline).whiteSpace).toBe('pre-line')
    expect(other.hasAttribute('data-orchestra-approval')).toBe(false)
    headline.textContent = other.textContent
    await Promise.resolve()
    expect(headline.hasAttribute('data-orchestra-approval')).toBe(false)
    headline.textContent = text
    await Promise.resolve()
    expect(headline.hasAttribute('data-orchestra-approval')).toBe(true)
  } finally {
    unmount()
    expect(headline.hasAttribute('data-orchestra-approval')).toBe(false)
    headline.remove()
    other.remove()
  }
})
