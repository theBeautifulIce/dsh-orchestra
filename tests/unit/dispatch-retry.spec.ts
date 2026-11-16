// 宿主重试指令：收口结果 → 宿主行为，单表钉死（评审 P2-3）
import { describe, expect, it } from 'vitest'
import { retryDirective } from '../../src/service/dispatcher.ts'

describe('派发结果的重试指令', () => {
  it('落库成功或被接管：一律不重派', () => {
    expect(retryDirective({ settlement: 'applied' })).toBe('never')
    expect(retryDirective({ settlement: 'already_moved' })).toBe('never')
    expect(retryDirective({})).toBe('never')
  })

  it('写库失败但读到了库内状态：重读确认仍是 queued 才可重试', () => {
    expect(retryDirective({ settlement: 'storage_error', persisted_status: 'queued' })).toBe('after_reread')
    expect(retryDirective({ settlement: 'storage_error', persisted_status: 'started' })).toBe('after_reread')
  })

  it('写库失败且状态未知：必须先独立查询，绝不直接重派', () => {
    expect(retryDirective({ settlement: 'storage_error', persisted_status: 'unknown' })).toBe('after_status_query')
    expect(retryDirective({ settlement: 'storage_error' })).toBe('after_status_query')
  })
})
