// HTTP 入口：只监听 127.0.0.1；/health 免认证，其余路径都要 x-orchestra-secret（规格 12.5 行 1091）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { OrchError, failEnvelope, okEnvelope, toOrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'

export type ServerDeps = {
  secret: string
  phase: string
  epoch: number
  asOfSeq: () => number
  listTasks: (limit: number) => unknown[]
  listEvents: (fromSeq: number, limit: number) => unknown[]
  appendLedgerEvent: (body: unknown, actor: string) => { seq: number; event_id: string }
  log?: Logger
}

const MAX_BODY_BYTES = 1024 * 1024

function authenticate(req: IncomingMessage, secret: string): string {
  const got = req.headers['x-orchestra-secret']
  if (typeof got !== 'string' || got.length === 0) {
    throw new OrchError('UNAUTHORIZED', '没有认证主体', { reason: 'missing_secret' })
  }
  if (got !== secret) {
    throw new OrchError('UNAUTHORIZED', '认证主体无效', { reason: 'bad_secret' })
  }
  // actor 由认证主体派生；payload 里的 actor 字段一律忽略
  return 'service:' + sha256Hex(got).slice(0, 8)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new OrchError('RANGE_TOO_LARGE', '请求体太大', { limit: MAX_BODY_BYTES })
    chunks.push(buf)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请求体不是合法 JSON', {})
  }
}

const intParam = (url: URL, name: string, fallback: number): number => {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '查询参数不合法', { name, value: raw })
  return n
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const log = deps.log ?? nullLogger
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { ok: true, phase: deps.phase, epoch: deps.epoch }))
      return
    }
    const actor = authenticate(req, deps.secret)

    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      const limit = Math.min(intParam(url, 'limit', 50), 200)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: deps.listTasks(limit) }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const fromSeq = intParam(url, 'from_seq', 0)
      const limit = Math.min(intParam(url, 'limit', 100), 500)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: deps.listEvents(fromSeq, limit) }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/ledger/events') {
      const body = await readJsonBody(req)
      const out = deps.appendLedgerEvent(body, actor)
      sendJson(res, 200, okEnvelope(out.seq, { seq: out.seq, event_id: out.event_id, actor }))
      return
    }
    throw new OrchError('NOT_FOUND', '没有这个接口', { path: url.pathname, method: req.method })
  } catch (err) {
    const e = toOrchError(err)
    if (e.httpStatus >= 500) log.error('请求失败', { path: url.pathname, code: e.code, err: e.message })
    sendJson(res, e.httpStatus, failEnvelope(deps.asOfSeq(), e))
  }
}

export function startServer(deps: ServerDeps): Promise<{ endpoint: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => { void handle(req, res, deps) })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        endpoint: 'http://127.0.0.1:' + String(port),
        close: () => new Promise<void>((r) => { server.close(() => { r() }) }),
        server,
      })
    })
  })
}
