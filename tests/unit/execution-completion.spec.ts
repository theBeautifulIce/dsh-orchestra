import { describe, expect, it } from 'vitest'
import { completionBlockReason, readExecutionCompletion, validateDshCompletionReport } from '../../src/core/execution-completion.ts'

describe('structured execution completion', () => {
  it('keeps old bridge reports readable but requires completion from native DSH', () => {
    expect(readExecutionCompletion({ status: 'done', output: {} })).toBeUndefined()
    expect(() => validateDshCompletionReport({ status: 'done', output: {} }))
      .toThrow('执行报告缺少结构化完成度')
  })

  it('accepts a completed search with zero results instead of classifying prose', () => {
    expect(() => validateDshCompletionReport({ status: 'done', output: {
      summary: '已检索指定来源和时段，符合条件的结果为 0 条。',
      completion: { outcome: 'completed', missing: [] },
    } })).not.toThrow()
  })

  it('preserves the reason, next action and missing inputs of blocked work', () => {
    const report = { status: 'failed', output: { completion: {
      outcome: 'blocked', reason: '无法访问新闻来源', next_action: '启用来源会话的检索工具后重试', missing: ['AIHOT 访问工具'],
    } } }
    expect(() => validateDshCompletionReport(report)).not.toThrow()
    const completion = readExecutionCompletion(report)!
    expect(completion).toEqual(report.output.completion)
    if (completion.outcome === 'completed') throw new Error('Expected a blocked report')
    expect(completionBlockReason(completion)).toBe('无法访问新闻来源；下一步：启用来源会话的检索工具后重试')
  })

  it.each([
    { status: 'done', output: { completion: { outcome: 'blocked', reason: '无访问权限', next_action: '处理授权' } } },
    { status: 'failed', output: { completion: { outcome: 'completed' } } },
    { status: 'failed', output: { completion: { outcome: 'blocked', reason: '无访问权限' } } },
    { status: 'done', output: { completion: { outcome: 'completed', missing: ['未执行检索'] } } },
  ])('rejects inconsistent or incomplete facts: %j', report => {
    expect(() => validateDshCompletionReport(report)).toThrow()
  })
})
