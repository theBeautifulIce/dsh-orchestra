import assert from 'node:assert/strict'
import { createDshJsonCompletion } from '../../src/executor/dsh-json.ts'
import { OrchError } from '../../src/core/errors.ts'

type Runtime = NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
type Event = Record<string, unknown>
type Config = Record<string, unknown>
const route = { provider: 'fixture', model: 'selected', reasoningEffort: 'high' }
const original = { current: { message_id: 'user-msg', text: '核对预算，必须先获得我的批准；不读写工作区文件。' }, explicit: true }
const answer = { kind: 'task', relation: 'new', timing: 'immediate', quote: '核对预算', constraints: [
  { id: 'c1', kind: 'approval_before', scope: 'task', reviewer: { kind: 'operator' }, source_message_id: 'user-msg', quote: '必须先获得我的批准' },
  { id: 'c2', kind: 'no_workspace_files', source_message_id: 'user-msg', quote: '不读写工作区文件' },
], missing: [] }
const body = JSON.stringify(answer)
const end = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const text = (value: string) => ({ type: 'block-end', block: { type: 'text', text: value } })
const secret = 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD'
const signal = () => new AbortController().signal
const current = () => {}
const rejection = (reason: string) => (error: unknown) => {
  const e = error as { code?: string; details?: { reason?: string }; message?: string }
  assert.equal(e.code, 'SERVICE_UNAVAILABLE')
  assert.equal(e.details?.reason, reason)
  assert.ok(!JSON.stringify(e).includes(secret) && !String(error).includes(secret))
  return true
}
function fixture(scripts: Event[][], options: { purpose?: 'admission' | 'permission'; prepare?: (c: Config) => Config; failPrepare?: boolean; failStream?: boolean } = {}) {
  const configs: Config[] = []
  const requests: Array<{ config: Config; system: string; body: string }> = []
  const runtime = { async prepareCall(config: Config) {
    configs.push(config)
    if (options.failPrepare) throw new Error(secret)
    const effective = options.prepare?.(config) ?? config
    return { config: effective, async *stream(request: { provider: string; model: string; maxTokens: number; reasoningEffort: string; system: string; tools: unknown[]; messages: Array<{ content: Array<{ text: string }> }> }) {
      assert.deepEqual(request.tools, [])
      assert.equal(request.provider, route.provider)
      assert.equal(request.model, route.model)
      assert.equal(request.reasoningEffort, route.reasoningEffort)
      assert.equal(request.maxTokens, effective.maxTokens)
      assert.equal(request.messages.length, 1)
      const payload = request.messages[0]!.content[0]!.text
      const i = requests.length
      requests.push({ config: effective, system: request.system, body: payload })
      if (options.failStream) throw new Error(secret)
      const events = scripts[i]
      assert.ok(events, 'unexpected model retry')
      yield* events
    } }
  } } as unknown as Runtime
  const complete = createDshJsonCompletion(runtime, options.purpose ?? 'admission')!
  return { complete, configs, requests, call: (s = signal(), check = current) => complete(route, 'interpret exact task', original, s, check) }
}
export const semanticTransportCases: Array<{ name: string; run(): Promise<void> }> = [
  { name: 'complete bare JSON uses a single bounded call', async run() {
    const f = fixture([[text(body), end()]])
    assert.deepEqual(await f.call(), answer)
    assert.equal(f.requests.length, 1)
    assert.equal(f.configs[0]!.maxTokens, 8192)
    assert.equal(f.requests[0]!.body, JSON.stringify(original))
  } },
  { name: 'single complete JSON fence preserves all cited fields', async run() {
    const f = fixture([[text('```json\n' + body + '\n```'), end()]])
    assert.deepEqual(await f.call(), answer)
    assert.equal(f.requests.length, 1)
  } },
  { name: 'long reasoning within admission budget does not become output', async run() {
    const f = fixture([[{ type: 'reasoning-delta', text: 'r'.repeat(30_000) }, text(body), end()]])
    assert.deepEqual(await f.call(), answer)
  } },
  { name: 'max-tokens cannot turn valid-looking partial JSON into admission; retries once at larger bound', async run() {
    const f = fixture([[text('{"kind":"conversation"}'), end('max-tokens')], [text(body), end()]])
    assert.deepEqual(await f.call(), answer)
    assert.deepEqual(f.configs.map(c => c.maxTokens), [8192, 12288])
    assert.deepEqual(f.requests.map(r => r.body), [JSON.stringify(original), JSON.stringify(original)])
    assert.ok(f.requests[1]!.system.includes('Preserve all operative user restrictions'))
  } },
  { name: 'normal finish with malformed output gets one repair without forwarding old output', async run() {
    const f = fixture([[text(secret + ' ' + body), end()], [text(body), end()]])
    assert.deepEqual(await f.call(), answer)
    assert.equal(f.requests.length, 2)
    assert.ok(!f.requests[1]!.system.includes(secret))
    assert.equal(f.requests[1]!.body, JSON.stringify(original))
  } },
  { name: 'prose, multiple objects and arrays cannot be mined for a valid response', async run() {
    for (const invalid of ['prefix ' + body, body + body, '[' + body + ']', 'null', '```json\n' + body + '\n```\nextra']) {
      const f = fixture([[text(invalid), end()], [text(invalid), end()]])
      await assert.rejects(f.call(), rejection('semantic_output_invalid'))
      assert.equal(f.requests.length, 2)
    }
  } },
  { name: 'two truncated responses stop after two attempts', async run() {
    const f = fixture([[text('{'), end('max-tokens')], [text('{'), end('max-tokens')]])
    await assert.rejects(f.call(), rejection('semantic_output_truncated'))
    assert.equal(f.requests.length, 2)
  } },
  { name: 'missing or unexpected finish is not success and not retried', async run() {
    for (const events of [[text(body)], [text(body), end('error')], [text(body), end(), text('extra')]]) {
      const f = fixture([events]); await assert.rejects(f.call(), rejection('semantic_stream_incomplete')); assert.equal(f.requests.length, 1)
    }
  } },
  { name: 'unexpected tool call and excessive output fail closed without retry', async run() {
    const tool = fixture([[{ type: 'tool-call-delta' }, text(body), end()]])
    await assert.rejects(tool.call(), rejection('semantic_tool_output')); assert.equal(tool.requests.length, 1)
    const size = fixture([[text('x'.repeat(16_385)), end()]])
    await assert.rejects(size.call(), rejection('semantic_output_limit')); assert.equal(size.requests.length, 1)
  } },
  { name: 'prepare and stream failures are distinguished and redacted', async run() {
    const p = fixture([], { failPrepare: true }); await assert.rejects(p.call(), rejection('semantic_prepare_failed')); assert.equal(p.configs.length, 1)
    const s = fixture([], { failStream: true }); await assert.rejects(s.call(), rejection('semantic_stream_failed')); assert.equal(s.requests.length, 1)
  } },
  { name: 'bounded model normalization accepted only within the budget; route and explicit effort pinned', async run() {
    const f = fixture([[text(body), end()]], { prepare: c => ({ ...c, maxTokens: 4096 }) })
    assert.deepEqual(await f.call(), answer)
    assert.equal(f.requests[0]!.config.maxTokens, 4096)
    for (const diff of [{ model: 'other' }, { provider: 'other' }, { reasoningEffort: 'low' }, { maxTokens: 999999 }, { maxTokens: 0 }]) {
      const bad = fixture([], { prepare: c => ({ ...c, ...diff }) }); await assert.rejects(bad.call(), rejection('semantic_config_mismatch')); assert.equal(bad.requests.length, 0)
    }
  } },
  { name: 'permission response remains strict, no retry and no normalized budget', async run() {
    const f = fixture([[text('```json\n{}\n```'), end()]], { purpose: 'permission' })
    await assert.rejects(f.call(), rejection('semantic_unavailable')); assert.equal(f.requests.length, 1); assert.equal(f.configs[0]!.maxTokens, 3072)
    const g = fixture([], { purpose: 'permission', prepare: c => ({ ...c, maxTokens: 2048 }) })
    await assert.rejects(g.call(), rejection('semantic_unavailable')); assert.equal(g.requests.length, 0)
  } },
  { name: 'missing selection and oversized input do not invoke provider', async run() {
    const f = fixture([])
    await assert.rejects(f.complete(undefined, 'interpret', original, signal(), current), rejection('semantic_model_missing'))
    await assert.rejects(f.complete(route, 'interpret', { text: 'x'.repeat(33_000) }, signal(), current), rejection('semantic_input_limit'))
    assert.equal(f.configs.length, 0)
  } },
  { name: 'revoked authorization cannot be retried', async run() {
    const f = fixture([[text('bad'), end()]])
    await assert.rejects(f.call(signal(), () => { if (f.requests.length) throw new Error(secret) }), rejection('semantic_context_changed'))
    assert.equal(f.configs.length, 1)
  } },
  { name: 'cancelled work keeps capacity until actual provider completion', async run() {
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runtime = { async prepareCall(config: Config) { return { config, async *stream() {
      entered++; await gate; yield text(body); yield end()
    } } } } as unknown as Runtime
    const complete = createDshJsonCompletion(runtime, 'admission')!
    const ctrls = [new AbortController(), new AbortController()]
    const calls = Promise.allSettled(ctrls.map(c => complete(route, 'interpret', original, c.signal, current)))
    await new Promise<void>(r => setImmediate(r)); assert.equal(entered, 2)
    try {
      ctrls.forEach(c => c.abort())
      for (const result of await calls) {
        assert.ok(result.status === 'rejected', 'cancelled calls must reject')
        const error: unknown = result.reason
        assert.ok(error instanceof OrchError, 'expected an Orchestra error')
        assert.equal(error.code, 'SERVICE_UNAVAILABLE')
      }
      await assert.rejects(complete(route, 'interpret', original, signal(), current), rejection('semantic_busy'))
    } finally { release() }
    await new Promise<void>(r => setImmediate(r))
    assert.deepEqual(await complete(route, 'interpret', original, signal(), current), answer)
    assert.equal(entered, 3)
  } },
]
