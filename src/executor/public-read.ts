import { createHash } from 'node:crypto'
import { z } from 'zod'
import { OrchError } from '../core/errors.ts'

export const PUBLIC_READ_TOOL = 'orchestra_public_read'
const endpoints = {
  aihot_latest: 'https://aihot.news/api/v1/agent/latest',
  aihot_hot: 'https://aihot.news/api/v1/agent/hot',
  aihot_daily: 'https://aihot.news/api/v1/agent/daily',
  aihot_guide: 'https://aihot.news/api/v1/agent',
} as const
const actions = ['aihot_latest', 'aihot_hot', 'aihot_daily', 'aihot_guide'] as const
export const publicReadInput = z.strictObject({ action: z.enum(actions) })
export const publicReadParameters = { type: 'object', properties: {
  action: { type: 'string', enum: [...actions] },
}, required: ['action'], additionalProperties: false }

const MAX_BYTES = 64 * 1024
const MAX_WAIT_MS = 20_000

/**
 * A bounded public-data adapter for the installed AIHOT skill. It accepts no
 * shell command, URL, credential, header, request body or redirect destination.
 * The caller must use the same host policy, approval and attempt-fence pipeline
 * as other native tools. This adapter does not change network configuration.
 */
export async function readAihotPublic(input: z.infer<typeof publicReadInput>, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<{ source_url: string; content_type: string; fetched_at: string;
    text: string; sha256: string; untrusted: true }> {
  const { action } = publicReadInput.parse(input)
  signal.throwIfAborted()
  const source_url = endpoints[action]
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(MAX_WAIT_MS)])
  const response = await request(source_url, {
    method: 'GET', redirect: 'error', credentials: 'omit', signal: lifetime,
    headers: { Accept: 'text/markdown, text/plain, application/json',
      'User-Agent': 'orchestra-aihot-read/1.0 (+https://aihot.news/aihot-skill/)' },
  })
  lifetime.throwIfAborted()
  if (!response.ok) {
    await response.body?.cancel()
    throw new OrchError('SERVICE_UNAVAILABLE', `AIHOT 读取失败（HTTP ${response.status}）。请稍后重试，或检查该来源的服务状态。`)
  }
  const content_type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!['text/markdown', 'text/plain', 'text/html', 'application/json'].includes(content_type)) {
    await response.body?.cancel()
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'AIHOT 返回了不支持的内容类型。未将其作为新闻结果。')
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel()
    throw new OrchError('RANGE_TOO_LARGE', 'AIHOT 响应超过64 KiB。未截断或伪造完整结果。')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'AIHOT 没有返回可读取的正文。')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      lifetime.throwIfAborted()
      const chunk = await reader.read()
      lifetime.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BYTES) throw new OrchError('RANGE_TOO_LARGE', 'AIHOT 响应超过64 KiB。未截断或伪造完整结果。')
      parts.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  if (!size) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'AIHOT 返回了空正文。未将其当作“没有新闻”。')
  const bytes = Buffer.concat(parts)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'AIHOT 正文不是有效的UTF-8文本。') }
  signal.throwIfAborted()
  return { source_url, content_type, fetched_at: new Date().toISOString(), text,
    sha256: createHash('sha256').update(bytes).digest('hex'), untrusted: true }
}
