import { describe, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { assertProposal, assertProposalSize, resolveTargetConflicts, type MemoryItemInput } from '../../src/core/memory-canonical.ts'

function proposal(overrides: Partial<MemoryItemInput> = {}): MemoryItemInput {
  return {
    client_key: 'item_1', action: 'update', target_id: 'target-1', layer: 'L4',
    title: '标题', content: '内容', tags: [], questions: [], key: null,
    importance: 5, ttl_days: null, quote: '引文', reason: '原因', ...overrides,
  }
}

function errorCode(run: () => unknown): string {
  try { run() } catch (error) { if (error instanceof OrchError) return error.code; throw error }
  throw new Error('预期调用失败')
}

describe('memory proposal canonical limits', () => {
  it('完整统计 metadata 字节，超长 tags 与 questions 都会拒绝', () => {
    expect(errorCode(() => assertProposalSize([proposal({ tags: ['x'.repeat(65 * 1024)] })]))).toBe('MEMORY_BATCH_TOO_LARGE')
    expect(errorCode(() => assertProposalSize([proposal({ questions: ['x'.repeat(65 * 1024)] })]))).toBe('MEMORY_BATCH_TOO_LARGE')
  })

  it('整批 metadata 超过 256 KiB 时拒绝，即使 content 很短', () => {
    const items = Array.from({ length: 10 }, (_, index) => proposal({
      client_key: `item_${index}`,
      tags: Array.from({ length: 12 }, (_, tag) => `${index}-${tag}-${'x'.repeat(2300)}`),
    }))
    expect(items.every((item) => item.content.length < 10)).toBe(true)
    expect(errorCode(() => assertProposalSize(items))).toBe('MEMORY_BATCH_TOO_LARGE')
  })

  it('正常提议通过，空标签和空问题元素拒绝', () => {
    expect(() => assertProposal([proposal()])).not.toThrow()
    expect(() => assertProposal([proposal({ tags: [''] })])).toThrow(/标签不能为空/)
    expect(() => assertProposal([proposal({ questions: ['  '] })])).toThrow(/问题不能为空/)
  })

  it('单个 metadata 字段有独立上限', () => {
    expect(() => assertProposal([proposal({ tags: ['x'.repeat(257)] })])).toThrow(/单个标签/)
    expect(() => assertProposal([proposal({ questions: ['x'.repeat(4097)] })])).toThrow(/单个问题/)
    expect(() => assertProposal([proposal({ key: 'x'.repeat(257) })])).toThrow(/key/)
    expect(() => assertProposal([proposal({ target_id: 'x'.repeat(257) })])).toThrow(/target_id/)
  })
})

describe('same-target proposal resolution', () => {
  it('只有业务字段一致才把同目标提议作为重复项跳过', () => {
    const first = proposal()
    const same = proposal({ client_key: 'item_2' })
    expect(resolveTargetConflicts([first, same]).skippedDuplicates).toEqual([same])
    expect(errorCode(() => resolveTargetConflicts([first, proposal({ client_key: 'item_2', importance: 9 })]))).toBe('MEMORY_BATCH_CONFLICT')
    expect(errorCode(() => resolveTargetConflicts([first, proposal({ client_key: 'item_2', tags: ['security'] })]))).toBe('MEMORY_BATCH_CONFLICT')
  })
})
