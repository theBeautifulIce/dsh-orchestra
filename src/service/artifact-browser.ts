import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import MarkdownIt from 'markdown-it'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { artifactReceiptLocation, type ArtifactReceiptLocation } from '../core/receipt-location.ts'
import { ARTIFACT_MAX_BYTES } from './artifact-store.ts'

export const artifactBrowserPath = '/v1/artifacts/open-browser'
export const artifactDownloadPath = '/v1/artifacts/download'
type ArtifactBytes = { fileName: string; title?: string; bytes: Uint8Array; sha256: string }
type Grant = { location: ArtifactReceiptLocation; identity: string; expiresAt: number }

const escape = (text: string) => text.replace(/[&<>"']/gu, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[value]!)
const markdown = new MarkdownIt({ html: false, linkify: false, maxNesting: 24 })
// Artifact content is untrusted. Images must not make background network requests.
markdown.renderer.rules.image = (tokens, index) => escape(tokens[index]!.content || '图片')
const renderLink = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!
  const href = String(token.attrGet('href') ?? '')
  if (!/^https?:\/\//iu.test(href)) token.attrSet('href', '#')
  token.attrSet('rel', 'noreferrer noopener')
  token.attrSet('target', '_blank')
  return renderLink(tokens, index, options, env, self)
}

const headers = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox",
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escape(title)}</title><style>html{color-scheme:light dark}body{font:16px/1.75 system-ui,sans-serif;margin:0 auto;padding:32px 24px;max-width:1000px;overflow-wrap:anywhere}h1{font-size:1.7rem;line-height:1.4}header{border-bottom:1px solid #8993a244;padding-bottom:16px;margin-bottom:28px}header p{font-size:14px;opacity:.7;margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#8993a214;border-radius:8px}code{font-size:.9em}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #8993a244;padding:8px 12px}a{color:#3779d8}blockquote{border-left:3px solid #8993a266;padding-left:18px;margin-left:0}</style>`
    + `<body><header><h1>${escape(title)}</h1><p>Orchestra · 已核验的成果版本</p></header>${body}`
    + '<footer style="font-size:14px;opacity:.7;margin-top:32px">阅读链接短时有效。连接失效时，请回到原会话再次点击成果名称。原文件可在会话成果卡中选择“下载原件”。</footer></body></html>'
}

function imageType(item: ArtifactBytes): string | undefined {
  const bytes = Buffer.from(item.bytes)
  if (/\.png$/iu.test(item.fileName) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (/\.jpe?g$/iu.test(item.fileName) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/\.gif$/iu.test(item.fileName) && /^(?:GIF87a|GIF89a)$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (/\.webp$/iu.test(item.fileName) && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
}

function renderArtifact(item: ArtifactBytes, imagePath: string): string {
  const title = item.title || item.fileName
  if (imageType(item)) return page(title,
    `<main><img src="${escape(imagePath)}" alt="${escape(item.fileName)}" style="max-width:100%;height:auto"></main>`)
  let text: string
  try {
    if (!/\.(?:md|markdown|txt|json|jsonl|csv|tsv|log|ya?ml|xml|ini|html?|svg)$/iu.test(item.fileName)) throw new Error('unsupported')
    text = new TextDecoder('utf-8', { fatal: true }).decode(item.bytes)
    if (text.includes('\0')) throw new Error('binary')
  } catch {
    return page(title, '<p>此格式不支持安全的浏览器预览。请回到原会话，在此成果旁点击“下载原件”。下载保留完整的原始文件。</p>')
  }
  // Large documents remain complete, with linear plain-text rendering instead of a Markdown parse.
  const body = /\.(?:md|markdown)$/iu.test(item.fileName) && item.bytes.byteLength <= 256 * 1024
    ? markdown.render(text) : `<pre>${escape(text)}</pre>`
  return page(title, `<main>${body}</main>`)
}

/** A separate loopback origin is required: DSH Browser rejects the application origin.
 * Each random grant addresses one version and rechecks its source authorization on every read. */
export function createArtifactBrowserReader(options: {
  read(location: ArtifactReceiptLocation, identity: string): Promise<ArtifactBytes>
  now?: () => number
  ttlMs?: number
  capacity?: number
}) {
  const now = options.now ?? Date.now
  const ttl = Math.min(Math.max(options.ttlMs ?? 15 * 60_000, 1), 15 * 60_000)
  const capacity = Math.min(Math.max(options.capacity ?? 64, 1), 64)
  const grants = new Map<string, Grant>()
  let server: Server | undefined
  let starting: Promise<number> | undefined
  let disposed = false
  let active = 0

  const read = async (grant: Pick<Grant, 'location' | 'identity'>) => {
    if (disposed) throw new OrchError('SERVICE_UNAVAILABLE', '成果阅读服务已关闭，请回到原会话重新打开成果。')
    const item = await options.read(grant.location, grant.identity)
    if (disposed) throw new OrchError('SERVICE_UNAVAILABLE', '成果阅读服务已关闭，请回到原会话重新打开成果。')
    if (item.bytes.byteLength > ARTIFACT_MAX_BYTES) throw new OrchError('RANGE_TOO_LARGE', '成果超过 8 MiB 阅读上限。请在面板下载原文件。')
    if (item.sha256 !== grant.location.sha256 || sha256Hex(Buffer.from(item.bytes)) !== grant.location.sha256)
      throw new OrchError('CONFIRMATION_MISMATCH', '成果版本校验失败。请回到原会话核对成果。')
    return item
  }
  const listen = () => starting ??= new Promise<number>((resolve, reject) => {
    if (disposed) { reject(new OrchError('SERVICE_UNAVAILABLE', '成果阅读服务已关闭')); return }
    const http = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
      const address = http.address()
      const authority = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : ''
      const reply = (status: number, body: string) => {
        response.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) })
        response.end(request.method === 'HEAD' ? undefined : body)
      }
      if (request.headers.host !== authority) { reply(403, page('无法打开成果', '<p>成果只能通过本机阅读入口打开。</p>')); return }
      const target = /^\/artifacts\/([a-f0-9]{64})(\/image)?$/u.exec(request.url ?? '')
      const token = target?.[1]
      const grant = token && grants.get(token)
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { reply(405, page('无法打开成果', '<p>此入口只支持读取成果。</p>')); return }
      if (!grant || grant.expiresAt <= now()) {
        if (token) grants.delete(token)
        reply(410, page('成果链接已过期', '<p>请回到原会话，再次点击成果名称。原成果不会因阅读链接过期而删除。</p>')); return
      }
      if (active >= 8) { reply(503, page('请稍后重试', '<p>正在读取其他成果，请稍后刷新此页。</p>')); return }
      active += 1
      try {
        const item = await read(grant)
        if (grant.expiresAt <= now()) throw new OrchError('OPERATION_EXPIRED', '成果链接已过期。请回到原会话再次点击成果名称。')
        if (target?.[2]) {
          const type = imageType(item)
          if (!type) { reply(404, page('无法预览图片', '<p>此成果不是支持的安全图片格式。</p>')); return }
          response.writeHead(200, { ...headers, 'content-type': type, 'content-length': item.bytes.byteLength })
          response.end(request.method === 'HEAD' ? undefined : Buffer.from(item.bytes))
        } else reply(200, renderArtifact(item, `/artifacts/${token}/image`))
      } catch (error) {
        const known = error instanceof OrchError
        reply(known ? error.httpStatus : 503, page('无法打开成果', `<p>${escape(known ? error.message : '暂时无法读取成果。请回到原会话重新打开。')}</p>`))
      } finally { active -= 1 }
    })
    server = http
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.unref()
      const address = http.address()
      if (!address || typeof address === 'string' || disposed) { http.close(); reject(new OrchError('SERVICE_UNAVAILABLE', '成果阅读服务已关闭')); return }
      resolve(address.port)
    })
  }).catch(error => { starting = undefined; throw error })

  return {
    async open(location: ArtifactReceiptLocation, identity: string) {
      location = artifactReceiptLocation.parse(location)
      await read({ location, identity })
      const port = await listen()
      if (disposed) throw new OrchError('SERVICE_UNAVAILABLE', '成果阅读服务已关闭')
      for (const [token, grant] of grants) if (grant.expiresAt <= now()) grants.delete(token)
      if (grants.size >= capacity) throw new OrchError('SERVICE_UNAVAILABLE', '已打开的成果链接较多。请稍后再试。')
      const token = randomBytes(32).toString('hex')
      const expiresAt = now() + ttl
      grants.set(token, { location, identity, expiresAt })
      return { url: `http://127.0.0.1:${port}/artifacts/${token}`, expiresAt: new Date(expiresAt).toISOString() }
    },
    async close() {
      disposed = true
      grants.clear()
      if (starting) await starting.catch(() => undefined)
      const http = server
      if (!http) return
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}
