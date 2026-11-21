import { expect, it } from 'vitest'
import { createDshPrivateNotes } from '../../src/executor/dsh-private-notes.ts'

type Runtime = NonNullable<Parameters<typeof createDshPrivateNotes>[0]>
const route = { provider: 'fixture', model: 'planner' }
const current = () => {}
const raw = 'private-abort-fixture'

it('requires the prepared one-shot interface and retains slots until a stalled provider settles', async () => {
  expect(createDshPrivateNotes({ stream() {} } as unknown as Runtime)).toBeUndefined()
  const blocked = Promise.withResolvers<void>()
  let calls = 0
  const io = createDshPrivateNotes({
    async prepareCall(config: unknown) {
      return { config, async *stream(options: { sessionId?: string; tools: unknown[] }) {
        expect(options.sessionId).toBeUndefined()
        expect(options.tools).toEqual([])
        calls++
        await blocked.promise
        yield { type: 'block-end', block: { type: 'text', text: '{"classification":"informational"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
  } as unknown as Runtime)!
  const first = new AbortController()
  const second = new AbortController()
  const handles = [first, second].map(({ signal }) => io.review(route, [raw], signal, current))
  const outcomes = Promise.allSettled(handles)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(calls).toBe(2)
  first.abort(new Error(raw))
  second.abort(new Error(raw))
  for (const outcome of await outcomes) {
    expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'SERVICE_UNAVAILABLE' } })
    expect(JSON.stringify(outcome)).not.toContain(raw)
  }
  await expect(io.review(route, [raw], new AbortController().signal, current)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(calls).toBe(2)
  blocked.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await expect(io.review(route, [raw], new AbortController().signal, current)).resolves.toBe('informational')
})
