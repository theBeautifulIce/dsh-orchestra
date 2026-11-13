// HTTP 入口：只监听 127.0.0.1；/health 免认证，其余路径都要 x-orchestra-secret（规格 12.5 行 1091）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { OrchError, failEnvelope, okEnvelope, toOrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'
import { WriteQueue } from './write-queue.ts'
import { decodeCursor, encodeCursor, makeCursor } from './queries/cursor.ts'
import type { ApplyResult } from '../core/report.ts'
import type { CancelOutcome } from './commands/cancel.ts'
import type { LoadWorkflowResult } from './workflows.ts'
import type { CreateRunResult } from './runs.ts'
import type { DispatchOutcome, NodeSpec } from './dispatcher.ts'
import type { RunNodeResult } from '../executor/run-node.ts'
import type { ToolPolicy } from '../executor/session.ts'

export type ServerDeps = {
  secret: string
  phase: string
  epoch: number
  asOfSeq: () => number
  listTasks: (limit: number) => unknown[]
  listEvents: (fromSeq: number, limit: number) => unknown[]
  appendLedgerEvent: (body: unknown, actor: string) => { seq: number; event_id: string }
  log?: Logger
  queue?: WriteQueue
  // 生产路径的节点命令；缺省时这几条路由一律 404，老测试不受影响
  commands?: NodeCommands
}

export type NodeCommands = {
  acquireLease: (body: { nodeRunId: string; ownerEpoch: number; leaseTtlMs: number; now: string }) => {
    lease_id: string; expires_at: string; action_generation: number
  }
  // 续租：动作比租约长时把租约往后推；判定留在服务端，路由层只搬字段（规格 4.3 行 309-310）
  renewLease: (body: { nodeRunId: string; leaseTtlMs: number; now: string }) => { expires_at: string }
  report: (body: {
    nodeRunId: string; attempt: number; report: unknown; expectedStatus: string; generation: number; now: string
  }) => ApplyResult
  cancel: (body: {
    nodeRunId: string; attempt: number; revision: number; cancelResult: string; now: string
    graceMs: number; extendDeadlineMs?: number
  }) => CancelOutcome
  loadWorkflow: (body: unknown) => LoadWorkflowResult
  // 建 run 与节点：定义加载后由服务层建行，不许靠手写 INSERT 起节点（审计 F-01）
  createRun: (body: { taskTitle: string; workflowVersion: string; nodeIds?: string[]; now: string }) => CreateRunResult
  // 派发：把 run 下排队中的节点交给生产执行器跑
  dispatch: (body: {
    runId: string
    nodes: Record<string, NodeSpec>
    now: string
    ownerEpoch?: number
    leaseTtlMs?: number
    leaseRenewIntervalMs?: number
  }) => Promise<DispatchOutcome[]>
  // 生产执行入口：路由只做形状校验，执行链在 runNode 里（审计 F-01）
  runNode: (body: {
    nodeRunId: string
    nodeId: string
    attempt: number
    input?: unknown
    outputSchema?: unknown
    tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
    now: string
    ownerEpoch?: number
    leaseTtlMs?: number
    leaseRenewIntervalMs?: number
  }) => Promise<RunNodeResult>
}

const CANCEL_RESULTS = ['interrupted', 'not_interruptible', 'already_stopped', 'unknown'] as const

// 请求体必填字段：缺一个就按结构错拒，别把 undefined 写进账本
function requireFields(body: unknown, fields: string[]): Record<string, unknown> {
  const record = body as Record<string, unknown>
  if (!record || typeof record !== 'object') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请求体要是对象', {})
  const missing = fields.filter((f) => record[f] === undefined || record[f] === null)
  if (missing.length > 0) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '请求体缺字段', { missing })
  return record
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

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, queue: WriteQueue): Promise<void> {
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
      // 游标与 from_seq 二选一；游标按 kind=events、无过滤条件绑定（规格 8.3 行 638）
      const rawCursor = url.searchParams.get('cursor')
      const fromSeq = rawCursor === null
        ? intParam(url, 'from_seq', 0)
        : Number(decodeCursor(rawCursor, 'events', {}).last_key)
      if (!Number.isInteger(fromSeq) || fromSeq < 0) throw new OrchError('CURSOR_EXPIRED', '游标里的位置不合法', { cursor: rawCursor })
      const limit = Math.min(intParam(url, 'limit', 100), 200)
      const rows = deps.listEvents(fromSeq, limit)
      const last = rows.length === 0 ? null : (rows[rows.length - 1] as { seq?: number }).seq
      const nextCursor = typeof last === 'number' ? encodeCursor(makeCursor('events', {}, String(last), '', deps.asOfSeq())) : null
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: rows, next_cursor: nextCursor }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/load' && deps.commands) {
      const body = await readJsonBody(req)
      const out = await queue.run(() => deps.commands!.loadWorkflow(body))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['taskTitle', 'workflowVersion', 'now'])
      const out = await queue.run(() => deps.commands!.createRun({
        taskTitle: String(body.taskTitle),
        workflowVersion: String(body.workflowVersion),
        nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : undefined,
        now: String(body.now),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/dispatch' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['runId', 'nodes', 'now'])
      if (typeof body.nodes !== 'object' || body.nodes === null || Array.isArray(body.nodes)) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'nodes 要是按 node_id 归类的对象', { nodes: body.nodes })
      }
      const out = await queue.run(() => deps.commands!.dispatch({
        runId: String(body.runId),
        nodes: body.nodes as Record<string, NodeSpec>,
        now: String(body.now),
        ownerEpoch: body.ownerEpoch === undefined ? undefined : Number(body.ownerEpoch),
        leaseTtlMs: body.leaseTtlMs === undefined ? undefined : Number(body.leaseTtlMs),
        leaseRenewIntervalMs: body.leaseRenewIntervalMs === undefined ? undefined : Number(body.leaseRenewIntervalMs),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/lease' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['nodeRunId', 'ownerEpoch', 'leaseTtlMs', 'now'])
      const out = await queue.run(() => deps.commands!.acquireLease({
        nodeRunId: String(body.nodeRunId), ownerEpoch: Number(body.ownerEpoch),
        leaseTtlMs: Number(body.leaseTtlMs), now: String(body.now),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/renew' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['nodeRunId', 'leaseTtlMs', 'now'])
      const out = await queue.run(() => deps.commands!.renewLease({
        nodeRunId: String(body.nodeRunId), leaseTtlMs: Number(body.leaseTtlMs), now: String(body.now),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/report' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['nodeRunId', 'attempt', 'report', 'expectedStatus', 'generation', 'now'])
      const out = await queue.run(() => deps.commands!.report({
        nodeRunId: String(body.nodeRunId), attempt: Number(body.attempt),
        report: body.report, expectedStatus: String(body.expectedStatus),
        generation: Number(body.generation), now: String(body.now),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/run' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['nodeRunId', 'nodeId', 'attempt', 'tools', 'now'])
      if (!Array.isArray(body.tools)) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'tools 要是数组', { tools: body.tools })
      }
      const out = await queue.run(() => deps.commands!.runNode({
        nodeRunId: String(body.nodeRunId), nodeId: String(body.nodeId), attempt: Number(body.attempt),
        input: body.input ?? {}, outputSchema: body.outputSchema ?? {},
        tools: body.tools as { command: string; args: string[]; cwd: string; timeoutMs: number }[],
        now: String(body.now),
        ownerEpoch: body.ownerEpoch === undefined ? undefined : Number(body.ownerEpoch),
        leaseTtlMs: body.leaseTtlMs === undefined ? undefined : Number(body.leaseTtlMs),
        leaseRenewIntervalMs: body.leaseRenewIntervalMs === undefined ? undefined : Number(body.leaseRenewIntervalMs),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/cancel' && deps.commands) {
      const body = requireFields(await readJsonBody(req), ['nodeRunId', 'attempt', 'revision', 'cancelResult', 'now', 'graceMs'])
      if (!(CANCEL_RESULTS as readonly string[]).includes(String(body.cancelResult))) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'cancelResult 不在枚举里', { cancelResult: body.cancelResult })
      }
      const out = await queue.run(() => deps.commands!.cancel({
        nodeRunId: String(body.nodeRunId), attempt: Number(body.attempt), revision: Number(body.revision),
        cancelResult: String(body.cancelResult), now: String(body.now), graceMs: Number(body.graceMs),
        extendDeadlineMs: body.extendDeadlineMs === undefined ? undefined : Number(body.extendDeadlineMs),
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/ledger/events') {
      const body = await readJsonBody(req)
      const out = await queue.run(() => deps.appendLedgerEvent(body, actor))
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
  const queue = deps.queue ?? new WriteQueue(1000, deps.log ?? nullLogger)
  const server = createServer((req, res) => { void handle(req, res, deps, queue) })
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
