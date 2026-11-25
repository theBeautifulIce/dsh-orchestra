import { expect, it, vi } from 'vitest'
import { createExecutionScheduler } from '../../src/service/execution-scheduler.ts'
import { visitChatReports } from '../../src/service/chat-report-isolation.ts'
import { createDshJsonCompletion, SEMANTIC_ADMISSION_TIMEOUT_MS } from '../../src/executor/dsh-json.ts'
import { ORCHESTRA_COMMUNICATION_GUIDE, ORCHESTRA_STRUCTURED_COMMUNICATION_GUIDE } from '../../src/core/communication.ts'

it('isolates a queued workflow-limit lookup failure from both the previous and following task', async () => {
  const scheduler = createExecutionScheduler({ concurrency: 1 })
  const gate = Promise.withResolvers<string>()
  const first = scheduler.run(() => gate.promise)
  const task = vi.fn()
  scheduler.configureWorkflowLimits(() => { throw new Error('limit unavailable') })
  const bad = scheduler.run(task, { workflowScope: { runId: 'r', workflowId: 'w', nodeId: 'n' } })
  const rejected = expect(bad).rejects.toThrow('limit unavailable')
  const good = scheduler.run(() => 'next')
  gate.resolve('first')
  expect(await first).toBe('first')
  await rejected
  expect(await good).toBe('next')
  expect(task).not.toHaveBeenCalled()
  await scheduler.close()
  expect(scheduler.stats()).toMatchObject({ waiting: 0, inFlight: 0 })
})

it('a failed notification remains pending while other runs report; abort and explicit stop end the scan', async () => {
  const delivered: string[] = []
  const visit = async (id: string) => {
    if (id === 'bad') throw new Error('projection failed')
    delivered.push(id)
  }
  await visitChatReports(['bad', 'good'], () => true, visit)
  expect(delivered).toEqual(['good'])
  await visitChatReports(['bad'], () => true, async id => { delivered.push(id) })
  expect(delivered).toEqual(['good', 'bad'])
  let current = true
  await visitChatReports(['first', 'second'], () => current, async id => { delivered.push(id); current = false })
  await visitChatReports(['stop', 'never'], () => true, async id => { delivered.push(id); return 'stop' })
  expect(delivered).toEqual(['good', 'bad', 'first', 'stop'])
})

type Runtime = NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
it.each(['admission', 'permission'] as const)('uses a purpose-specific bounded deadline without restoring provider slots early (%s)', async purpose => {
  vi.useFakeTimers()
  const gate = Promise.withResolvers<void>()
  let entered = 0
  const runtime = { async prepareCall(config: unknown) {
    return { config, async *stream() {
      entered++
      await gate.promise
      yield { type: 'block-end', block: { type: 'text', text: '{}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime
  const complete = createDshJsonCompletion(runtime, purpose)!
  const call = () => complete({ provider: 'fixture', model: 'm' }, 'fixture', {}, new AbortController().signal, () => {})
  try {
    const first = call().catch(error => error)
    const second = call().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(entered).toBe(2)
    const budget = purpose === 'admission' ? SEMANTIC_ADMISSION_TIMEOUT_MS : 8000
    let settled = false
    void first.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const code = purpose === 'admission' ? 'OPERATION_TIMEOUT' : 'SERVICE_UNAVAILABLE'
    expect(await first).toMatchObject({ code })
    expect(await second).toMatchObject({ code })
    await expect(call()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(entered).toBe(2)
  } finally { gate.resolve(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers() }
})

it('compresses only the generic structured-output guide', () => {
  expect(Buffer.byteLength(ORCHESTRA_STRUCTURED_COMMUNICATION_GUIDE)).toBeLessThan(Buffer.byteLength(ORCHESTRA_COMMUNICATION_GUIDE))
  expect(ORCHESTRA_STRUCTURED_COMMUNICATION_GUIDE).toContain('不得为压缩内容而删除要求、证据或完整成果')
})
