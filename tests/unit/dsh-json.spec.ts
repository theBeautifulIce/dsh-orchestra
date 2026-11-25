import { expect, it, vi } from 'vitest'
import { createDshJsonCompletion } from '../../src/executor/dsh-json.ts'
import { semanticResponseNeedsCorrection } from '../../src/service/semantic-admission.ts'

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

it('queues two admission bursts FIFO, rejects overflow, and never exceeds two live provider streams', async () => {
  const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
  const started: number[] = []
  let inFlight = 0
  let peak = 0
  const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
    return { config, async *stream() {
      const index = started.length
      started.push(index)
      inFlight++
      peak = Math.max(peak, inFlight)
      await gates[index]!.promise
      inFlight--
      yield { type: 'block-end', block: { type: 'text', text: '{}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime, 'admission')!
  const abortLastQueued = new AbortController()
  const calls = [0, 1, 2, 3].map(index => complete(route, 'interpret', { index },
    index === 3 ? abortLastQueued.signal : new AbortController().signal, current))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(started).toEqual([0, 1])
  await expect(complete(route, 'interpret', { index: 4 }, new AbortController().signal, current))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { reason: 'semantic_busy' } })
  abortLastQueued.abort()
  await expect(calls[3]).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  gates[0]!.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(started).toEqual([0, 1, 2])
  gates[1]!.resolve()
  gates[2]!.resolve()
  await expect(Promise.all(calls.slice(0, 3))).resolves.toEqual([{}, {}, {}])
  expect(peak).toBeLessThanOrEqual(2)
})

it('times out an admission request while it is still waiting for a provider slot', async () => {
  vi.useFakeTimers()
  try {
    const gate = Promise.withResolvers<void>()
    let streams = 0
    const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
      return { config, async *stream() {
        streams++
        await gate.promise
        yield { type: 'block-end', block: { type: 'text', text: '{}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    } } as unknown as Runtime, 'admission')!
    const holders = [0, 1].map(index => complete(route, 'interpret', { index }, new AbortController().signal, current))
    await vi.advanceTimersByTimeAsync(0)
    const waiting = complete(route, 'interpret', { index: 2 }, new AbortController().signal, current)
    const waitingResult = waiting.then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(waitingResult).resolves.toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'semantic_busy' } } })
    expect(streams).toBe(2)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(Promise.all(holders)).resolves.toEqual([{}, {}])
  } finally { vi.useRealTimers() }
})

function responseQueue(texts: string[]) {
  const systems: string[] = []
  const prepareCall = vi.fn(async (config: unknown) => ({ config, async *stream({ system }: { system: string }) {
    const text = texts[systems.length]
    systems.push(system)
    if (text === undefined) throw new Error('unexpected model retry')
    yield { type: 'block-end', block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }))
  return { llm: { prepareCall } as unknown as Runtime, prepareCall, systems }
}

const badContract = '{"kind":"task","relation":"new","timing":"held","quote":"先不要执行","constraints":[],"missing":["materials","constraints"]}'
const malformedJson = '{"kind":'

it.each([
  { first: malformedJson, second: badContract, final: 'contract' },
  { first: badContract, second: malformedJson, final: 'syntax' },
])('shares a single admission retry across JSON and contract correction (last error: $final)', async ({ first, second, final }) => {
  const model = responseQueue([first, second, '{"kind":"conversation"}'])
  const complete = createDshJsonCompletion(model.llm, 'admission')!
  const result = complete(route, 'interpret', { text: '先不要执行' }, new AbortController().signal, current, semanticResponseNeedsCorrection)
  if (final === 'syntax') {
    await expect(result).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { reason: 'semantic_output_invalid' } })
  } else {
    expect(semanticResponseNeedsCorrection(await result)).toBe(true)
  }
  expect(model.prepareCall).toHaveBeenCalledTimes(2)
  expect(model.systems[0]).not.toContain('Return exactly one complete JSON object')
  expect(model.systems[1]).toContain('Return exactly one complete JSON object')
})

it.each([malformedJson, badContract])('never retries permission transport or invokes admission correction (%s)', async first => {
  const model = responseQueue([first, '{"kind":"conversation"}'])
  const complete = createDshJsonCompletion(model.llm, 'permission')!
  const needsCorrection = vi.fn(() => true)
  const result = complete(route, 'review permission', {}, new AbortController().signal, current, needsCorrection)
  if (first === malformedJson) await expect(result).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  else await expect(result).resolves.toEqual(JSON.parse(first))
  expect(model.prepareCall).toHaveBeenCalledOnce()
  expect(needsCorrection).not.toHaveBeenCalled()
  expect(model.systems[0]).not.toContain('Return exactly one complete JSON object')
})
