import { expect, it } from 'vitest'
import { createDshJsonCompletion } from '../../src/executor/dsh-json.ts'

type Runtime = NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
const route = { provider: 'fixture', model: 'selected', reasoningEffort: 'low' }
const current = () => {}

it('supplies only data and no tools or session identity to a pinned, prepared JSON call', async () => {
  const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
    return { config, async *stream(options: { tools: unknown[]; sessionId?: string; messages: unknown[]; system: string }) {
      expect(options.tools).toEqual([])
      expect(options.sessionId).toBeUndefined()
      expect(options.messages).toHaveLength(1)
      expect(options.system).toContain('ORCHESTRA_COMMUNICATION_STE80')
      expect(options.system.endsWith('\ninterpret')).toBe(true)
      expect(options.system).not.toContain('hello')
      yield { type: 'block-end', block: { type: 'text', text: '{"kind":"conversation"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime)!
  await expect(complete(route, 'interpret', { text: 'hello' }, new AbortController().signal, current)).resolves.toEqual({ kind: 'conversation' })
})

it.each(['tool', 'no-finish', 'oversized', 'changed-model', 'provider-error'])('rejects %s without leaking provider input', async scenario => {
  const complete = createDshJsonCompletion({ async prepareCall(config: Record<string, unknown>) {
    if (scenario === 'provider-error') throw Error('private provider payload')
    return { config: scenario === 'changed-model' ? { ...config, model: 'different' } : config,
      async *stream() {
        if (scenario === 'tool') yield { type: 'tool-call-delta' }
        yield { type: 'block-end', block: { type: 'text', text: scenario === 'oversized' ? 'x'.repeat(20_000) : '{}' } }
        if (scenario !== 'no-finish') yield { type: 'finish', reason: { kind: 'stop' } }
      } }
  } } as unknown as Runtime)!
  const result = await complete(route, 'interpret', { secret: 'private provider payload' }, new AbortController().signal, current).catch(error => error)
  expect(result).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(String(result)).not.toContain('private provider payload')
})

it('keeps real provider slots occupied after cancellation and recovers when they settle', async () => {
  expect(createDshJsonCompletion({} as Runtime)).toBeUndefined()
  const blocked = Promise.withResolvers<void>()
  let calls = 0
  const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
    return { config, async *stream() {
      calls++
      await blocked.promise
      yield { type: 'block-end', block: { type: 'text', text: '{}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime)!
  const controllers = [new AbortController(), new AbortController()]
  const attempts = Promise.allSettled(controllers.map(controller => complete(route, 'interpret', {}, controller.signal, current)))
  await new Promise<void>(resolve => setImmediate(resolve))
  controllers.forEach(controller => controller.abort())
  expect((await attempts).every(result => result.status === 'rejected')).toBe(true)
  await expect(complete(route, 'interpret', {}, new AbortController().signal, current)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(calls).toBe(2)
  blocked.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  await expect(complete(route, 'interpret', {}, new AbortController().signal, current)).resolves.toEqual({})
})
