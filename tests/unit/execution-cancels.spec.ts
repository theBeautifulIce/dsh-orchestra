// 执行中取消注册表：键必须带 attempt，旧 attempt 的取消不能打断新 attempt。
import { describe, expect, it } from 'vitest'
import { ExecutionCancels } from '../../src/service/execution-cancels.ts'

describe('ExecutionCancels', () => {
  it('同一个 node_run+attempt 重复注册返回同一个信号', () => {
    const cancels = new ExecutionCancels()
    const a = cancels.register('n1', 1)
    const b = cancels.register('n1', 1)
    expect(a).toBe(b)
    expect(a.aborted).toBe(false)
  })

  it('abort 只命中对应 attempt，旧 attempt 不影响新 attempt', () => {
    const cancels = new ExecutionCancels()
    const old = cancels.register('n1', 1)
    const next = cancels.register('n1', 2)
    expect(cancels.abort('n1', 1, 'cancel:interrupted')).toBe(true)
    expect(old.aborted).toBe(true)
    expect(next.aborted).toBe(false)
  })

  it('release 后不再持有信号，abort 返回 false', () => {
    const cancels = new ExecutionCancels()
    const signal = cancels.register('n1', 1)
    cancels.release('n1', 1)
    expect(cancels.has('n1', 1)).toBe(false)
    expect(cancels.abort('n1', 1, 'cancel:interrupted')).toBe(false)
    expect(signal.aborted).toBe(false)
  })
})
