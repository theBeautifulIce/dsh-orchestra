import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { OrchError } from '../core/errors.ts'

type Llm = Context['llm']
type StreamOptions = Parameters<Llm['stream']>[0]
export type JsonModelRoute = { provider: string; model: string; reasoningEffort?: string | null }
const unavailable = () => new OrchError('SERVICE_UNAVAILABLE', '暂时无法确认任务含义，请稍后重试', { reason: 'semantic_unavailable' })

/** One bounded JSON call. No session history, tool registry or agent loop is supplied. */
export function createDshJsonCompletion(llm: Llm | undefined) {
  if (typeof llm?.prepareCall !== 'function') return
  const runtime = llm
  let active = 0
  return async (route: JsonModelRoute | undefined, instructions: string, input: unknown,
    signal: AbortSignal, assertCurrent: () => void): Promise<unknown> => {
    if (!route || signal.aborted || active >= 2) throw unavailable()
    const body = JSON.stringify(input)
    if (Buffer.byteLength(body, 'utf8') > 32_768) throw unavailable()
    active++
    const local = new AbortController()
    const timeout = setTimeout(() => local.abort(), 8_000)
    timeout.unref()
    const lifetime = AbortSignal.any([local.signal, signal])
    const work = (async () => {
      lifetime.throwIfAborted()
      assertCurrent()
      const maxTokens = 3072
      const { provider, model, reasoningEffort } = route
      const prepared = await runtime.prepareCall({ provider, model, maxTokens,
        ...(reasoningEffort == null ? {} : { reasoningEffort: reasoningEffort as StreamOptions['reasoningEffort'] }) }, lifetime)
      lifetime.throwIfAborted()
      assertCurrent()
      if (prepared.config.provider !== provider || prepared.config.model !== model || prepared.config.maxTokens !== maxTokens
        || (reasoningEffort != null && prepared.config.reasoningEffort !== reasoningEffort)) throw unavailable()
      const messages: StreamOptions['messages'] = [{ id: randomUUID() as NonNullable<StreamOptions['messages'][number]['id']>,
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body }] }]
      const stream = prepared.stream({ provider, model, maxTokens, system: instructions, messages, tools: [], signal: lifetime,
        ...(prepared.config.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }) })
      let output = ''
      let length = 0
      let chunks = 0
      let stopped = false
      for await (const chunk of stream) {
        lifetime.throwIfAborted()
        assertCurrent()
        if (++chunks > 4096 || stopped || chunk.type === 'tool-call-delta') throw unavailable()
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') length += chunk.text.length
        if (chunk.type === 'block-end') {
          if (chunk.block.type === 'text') output += chunk.block.text
          else if (chunk.block.type !== 'reasoning') throw unavailable()
        }
        if (length > 24_576 || output.length > 16_384) throw unavailable()
        if (chunk.type === 'finish') {
          if (chunk.reason.kind !== 'stop') throw unavailable()
          stopped = true
        }
      }
      lifetime.throwIfAborted()
      assertCurrent()
      if (!stopped) throw unavailable()
      return JSON.parse(output) as unknown
    })()
    // A timed-out provider still occupies its slot until its actual work settles.
    void work.then(() => { active-- }, () => { active-- })
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(unavailable())
      lifetime.addEventListener('abort', onAbort, { once: true })
      if (lifetime.aborted) onAbort()
    })
    try { return await Promise.race([work, aborted]) }
    catch { throw unavailable() }
    finally {
      lifetime.removeEventListener('abort', onAbort)
      clearTimeout(timeout)
      local.abort()
    }
  }
}
