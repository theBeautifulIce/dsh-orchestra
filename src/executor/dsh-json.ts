import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { OrchError } from '../core/errors.ts'
import { ORCHESTRA_STRUCTURED_COMMUNICATION_GUIDE } from '../core/communication.ts'

type Llm = Context['llm']
type StreamOptions = Parameters<Llm['stream']>[0]
export type JsonModelRoute = { provider: string; model: string; reasoningEffort?: string | null }
const unavailable = () => new OrchError('SERVICE_UNAVAILABLE', '暂时无法确认任务含义，请稍后重试', { reason: 'semantic_unavailable' })

export const SEMANTIC_ADMISSION_TIMEOUT_MS = 60_000
const ADMISSION_TOKENS = 8192
const ADMISSION_RETRY_TOKENS = 12288
const CORRECTION = 'Return exactly one complete JSON object, without prose or Markdown. Copy only the shortest necessary verbatim clauses. Preserve all operative user restrictions. Do not solve the task or grant permission.'

const admissionFailures = {
  semantic_model_missing: '任务理解没有可用的当前模型。',
  semantic_busy: '任务理解的两个请求位仍被占用。',
  semantic_input_limit: '任务理解的输入超过安全长度限制。',
  semantic_prepare_failed: '任务理解模型请求准备失败。',
  semantic_config_mismatch: '任务理解的实际模型、思考设置或输出上限不符合请求。',
  semantic_context_changed: '任务理解期间会话或授权已改变。',
  semantic_stream_failed: '任务理解模型的响应流中断或请求失败。',
  semantic_stream_incomplete: '任务理解未收到完整的模型结束信号。',
  semantic_output_truncated: '任务理解模型达到输出上限，未返回完整结果。',
  semantic_output_invalid: '任务理解模型未返回一个完整可读取的 JSON 对象。',
  semantic_output_limit: '任务理解响应超过安全长度或事件数限制。',
  semantic_tool_output: '任务理解模型返回了不允许的工具调用。',
} as const

type AdmissionFailure = keyof typeof admissionFailures
class JsonFailure extends Error {
  readonly reason: AdmissionFailure
  constructor(reason: AdmissionFailure) { super(admissionFailures[reason]); this.reason = reason }
}

/** Accept only the entire JSON object, optionally enclosed in a single JSON fence.
 * Never extract a plausible substring from prose, concatenate alternative answers,
 * or repair missing fields. The semantic contract still validates all citations. */
function parseAdmissionObject(output: string): unknown {
  const trimmed = output.trim()
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  try {
    const value: unknown = JSON.parse(fence ? fence[1]! : trimmed)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  } catch { throw new JsonFailure('semantic_output_invalid') }
}

/** Bounded tool-free calls. Admission alone permits a single format/length retry.
 * The original permission path remains strict, with its original 8-second budget. */
export function createDshJsonCompletion(llm: Llm | undefined, purpose: 'admission' | 'permission' = 'permission') {
  if (typeof llm?.prepareCall !== 'function') return
  const runtime = llm
  const admission = purpose === 'admission'
  let active = 0
  const failure = (reason: AdmissionFailure) => admission
    ? new OrchError('SERVICE_UNAVAILABLE', admissionFailures[reason], { reason }) : unavailable()
  return async (route: JsonModelRoute | undefined, instructions: string, input: unknown,
    signal: AbortSignal, assertCurrent: () => void): Promise<unknown> => {
    if (signal.aborted) throw unavailable()
    if (!route) throw failure('semantic_model_missing')
    if (active >= 2) throw failure('semantic_busy')
    const body = JSON.stringify(input)
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 32_768) throw failure('semantic_input_limit')
    active++
    const local = new AbortController()
    const timeoutReason = admission
      ? new OrchError('OPERATION_TIMEOUT', '任务理解超时，尚未开始执行', { reason: 'semantic_timeout' })
      : unavailable()
    const timeout = setTimeout(() => local.abort(timeoutReason), admission ? SEMANTIC_ADMISSION_TIMEOUT_MS : 8_000)
    timeout.unref()
    const lifetime = AbortSignal.any([local.signal, signal])
    const current = () => {
      lifetime.throwIfAborted()
      try { assertCurrent() } catch { throw new JsonFailure('semantic_context_changed') }
    }
    const { provider, model, reasoningEffort } = route
    const attempt = async (requestedTokens: number, correction: boolean) => {
      current()
      const prepared = await (async () => {
        try {
          return await runtime.prepareCall({ provider, model, maxTokens: requestedTokens,
            ...(reasoningEffort == null ? {} : { reasoningEffort: reasoningEffort as StreamOptions['reasoningEffort'] }) }, lifetime)
        } catch { throw new JsonFailure('semantic_prepare_failed') }
      })()
      current()
      const maxTokens = prepared.config.maxTokens
      // Allow a safe provider clamp only for task understanding. Never silently
      // switch models, change explicitly chosen reasoning, or exceed the budget.
      const budgetMatches = admission
        ? typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= requestedTokens
        : maxTokens === requestedTokens
      if (prepared.config.provider !== provider || prepared.config.model !== model || !budgetMatches
        || (reasoningEffort != null && prepared.config.reasoningEffort !== reasoningEffort)) throw new JsonFailure('semantic_config_mismatch')
      // maxTokens has been checked above; use the effective bounded value.
      const effectiveTokens = maxTokens as number
      const messages: StreamOptions['messages'] = [{ id: randomUUID() as NonNullable<StreamOptions['messages'][number]['id']>,
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body }] }]
      let output = ''
      let length = 0
      let chunks = 0
      let finish: string | undefined
      try {
        const stream = prepared.stream({ provider, model, maxTokens: effectiveTokens,
          system: `${ORCHESTRA_STRUCTURED_COMMUNICATION_GUIDE}\n${instructions}${correction ? '\n' + CORRECTION : ''}`, messages, tools: [], signal: lifetime,
          ...(prepared.config.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }) })
        for await (const chunk of stream) {
          current()
          if (++chunks > (admission ? 16_384 : 4096)) throw new JsonFailure('semantic_output_limit')
          if (finish !== undefined) throw new JsonFailure('semantic_stream_incomplete')
          if (chunk.type === 'tool-call-delta') throw new JsonFailure('semantic_tool_output')
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') length += chunk.text.length
          if (chunk.type === 'block-end') {
            if (chunk.block.type === 'text') output += chunk.block.text
            else if (chunk.block.type !== 'reasoning') throw new JsonFailure('semantic_tool_output')
          }
          if (length > (admission ? 98_304 : 24_576) || output.length > 16_384) throw new JsonFailure('semantic_output_limit')
          if (chunk.type === 'finish') {
            finish = chunk.reason.kind
            // The permission call retains the original fail-closed behaviour.
            if (!admission && finish !== 'stop') throw new JsonFailure('semantic_stream_incomplete')
          }
        }
      } catch (error) {
        if (error instanceof JsonFailure) throw error
        throw new JsonFailure('semantic_stream_failed')
      }
      current()
      // Retry only after the first stream has actually closed with a known
      // length limit, or ended normally with malformed/empty text. No retry
      // on provider errors, cancellation, unknown stop reasons, or tool output.
      if (admission && (finish === 'max-tokens' || finish === 'length')) throw new JsonFailure('semantic_output_truncated')
      if (finish !== 'stop') throw new JsonFailure('semantic_stream_incomplete')
      return admission ? parseAdmissionObject(output) : JSON.parse(output) as unknown
    }
    const work = (async () => {
      try { return await attempt(admission ? ADMISSION_TOKENS : 3072, false) }
      catch (error) {
        if (!admission || !(error instanceof JsonFailure)
          || (error.reason !== 'semantic_output_invalid' && error.reason !== 'semantic_output_truncated')) throw error
        current()
        return attempt(error.reason === 'semantic_output_truncated' ? ADMISSION_RETRY_TOKENS : ADMISSION_TOKENS, true)
      }
    })()
    // The two slots cover both attempts and remain occupied until actual work settles.
    void work.then(() => { active-- }, () => { active-- })
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(unavailable())
      lifetime.addEventListener('abort', onAbort, { once: true })
      if (lifetime.aborted) onAbort()
    })
    try { return await Promise.race([work, aborted]) }
    catch (error) {
      if (!signal.aborted && local.signal.reason === timeoutReason) throw timeoutReason
      if (signal.aborted) throw unavailable()
      if (error instanceof JsonFailure) throw failure(error.reason)
      throw unavailable()
    }
    finally {
      lifetime.removeEventListener('abort', onAbort)
      clearTimeout(timeout)
      local.abort()
    }
  }
}
