// HTTP 入口：只监听 127.0.0.1；/health 免认证，其余路径都要 x-orchestra-secret（规格 12.5 行 1091）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { OrchError, failEnvelope, okEnvelope, toOrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'
import { WriteQueue } from './write-queue.ts'
import { decodeCursor, encodeCursor, makeCursor } from './queries/cursor.ts'
import {
  cancelRunSchema, cancelSchema, compensateSettleSchema, compensateStartSchema, confirmStartSchema, createRunSchema, dispatchSchema,
  ledgerEventSchema, leaseSchema, parseBody, recoveryResolveSchema,
  renewSchema, reportSchema, resolveDecisionSchema, runNodeSchema, startRunSchema, waitEventSchema, workflowLoadSchema,
  workflowCreateCommandSchema, workflowOpenDraftCommandSchema, workflowUpdateCommandSchema, workflowPublishCommandSchema,
} from './schemas.ts'
import type { ApplyResult } from '../core/report.ts'
import type { CancelOutcome } from './commands/cancel.ts'
import type { CompensationDescriptor } from './commands/compensation.ts'
import type { RecoveryResolveResult } from './commands/recovery.ts'
import type { RecoveryUncertainItem } from './queries/recovery.ts'
import type { LoadWorkflowResult } from './workflows.ts'
import type { CreateRunResult } from './runs.ts'
import type { StartRunResult } from './commands/start-run.ts'
import type { DecisionResolution, Resolution } from './commands/decisions.ts'
import type { Actor } from './decision/approver.ts'
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
  // 服务端时钟：租约与上报的时刻只由服务端决定，请求体里的 now 不参与判定。
  // 测试可注入固定时刻；生产缺省读系统墙钟。
  now?: () => string
  // 生产路径的节点命令；缺省时这几条路由一律 404，老测试不受影响
  commands?: NodeCommands
}

import type { CreateWorkflowParams, OpenDraftParams, PublishParams, UpdateDraftParams } from './commands/workflows.ts'

export type NodeCommands = {
  acquireLease: (body: { nodeRunId: string; ownerEpoch: number; leaseTtlMs: number; now: string }) => {
    lease_id: string; expires_at: string; action_generation: number
  }
  // 续租：动作比租约长时把租约往后推；判定留在服务端，路由层只搬字段（规格 4.3 行 309-310）
  renewLease: (body: { nodeRunId: string; leaseTtlMs: number; now: string }) => { expires_at: string }
  report: (body: {
    nodeRunId: string; attempt: number; report: unknown; expectedStatus: string; generation: number
    decision?: { decisionId: string; revision: number; resolution: 'confirm_applied' | 'confirm_not_applied' | 'uphold_report' | 'uphold_decision' }
    now: string
  }) => ApplyResult
  cancel: (body: {
    nodeRunId: string; attempt: number; revision: number; cancelResult: string; now: string
    graceMs: number; extendDeadlineMs?: number
  }) => CancelOutcome
  loadWorkflow: (body: unknown) => LoadWorkflowResult
  // S4 工作流命令：四个写命令都强制 operation_id（规格 3.7），actor 由认证主体派生
  createWorkflow: (body: CreateWorkflowParams & { operationId: string }) => unknown
  openWorkflowDraft: (body: OpenDraftParams & { operationId: string }) => unknown
  updateWorkflowDraft: (body: UpdateDraftParams & { operationId: string }) => unknown
  publishWorkflow: (body: PublishParams & { operationId: string }) => unknown
  getWorkflow: (body: { workflowId: string }) => unknown
  listWorkflows: (body: { ownerTaskId?: string | null }) => unknown
  // 建 run 与节点：定义加载后由服务层建行，不许靠手写 INSERT 起节点（审计 F-01）
  createRun: (body: { taskTitle: string; workflowId?: string; workflowVersion: string; nodeIds?: string[]; now: string }) => CreateRunResult
  // 起运行：固定版本、operation_id 幂等、自治档位与升级规则；HTTP 只搬字段
  startRun: (body: {
    taskTitle: string
    workflowId?: string
    workflowVersion: string
    nodeIds?: string[]
    autonomy?: 'autonomous' | 'assisted' | 'supervised'
    escalations?: { kind: 'node_type' | 'action_category' | 'workflow_version_publish'; value: string }[]
    operationId: string
    now: string
  }) => StartRunResult
  // 裁决收口：批准人、confirm_required 与 revision 都由服务层判
  resolveDecision: (body: {
    decisionId: string
    revision: number
    resolution: Resolution
    payload?: Record<string, unknown>
    actor?: Actor
    evidenceProducers?: string[]
    confirm?: boolean
    contentHash?: string
    now: string
  }) => DecisionResolution
  // 启动未知的人工确认：M-08/M-09/M-61 的生产入口
  confirmStart: (body: { nodeRunId: string; attempt: number; attested?: boolean; now: string; actor?: string }) => {
    trigger: 'confirm-started' | 'confirm-started-attested' | 'confirm-started-with-tool'
  }
  // 补偿的生产入口：开始与收口都由服务层做幂等和状态迁移，HTTP 只搬描述符
  startCompensation: (body: {
    nodeRunId: string; attempt: number; descriptor: CompensationDescriptor; now: string
  }) => { compensationId: string; started: boolean }
  settleCompensation: (body: {
    compensationId: string; state: 'applied' | 'failed' | 'unverified'; evidence?: unknown; now: string; reason?: string
  }) => { settled: boolean }
  // 等待事件的生产入口：先落 inbox，再回放该 run 下所有活跃等待
  wakeOnEvent: (body: {
    runId: string; eventType: string; payload?: unknown; idempotencyKey?: string | null; now: string
  }) => { eventSeq: number; woken: number }
  // 运行级取消：父取消必须向子 run 传播，不可逆节点跳过
  cancelRun: (body: {
    runId: string; cancelResult: string; graceMs: number; extendDeadlineMs?: number; now: string
  }) => {
    cancelledRuns: string[]
    cancelledNodes: string[]
    skippedIrreversible: string[]
    pendingHumanDecisions: string[]
    runStatus: string
    // 取消后的库内终态与业务结果（run.terminal.outcome）；run 还没到终态时两者都是 null
    terminalStatus: string | null
    outcome: string | null
  }
  // 派发：把 run 下排队中的节点交给生产执行器跑
  dispatch: (body: {
    runId: string
    nodes: Record<string, NodeSpec>
    now: string
    ownerEpoch?: number
    leaseTtlMs?: number
    leaseRenewIntervalMs?: number
  }) => Promise<DispatchOutcome[]>
  // 恢复不确定的节点：可查、可确认（评审 P2-4）
  listRecoveryUncertain: () => RecoveryUncertainItem[]
  resolveRecoveryUncertain: (body: {
    nodeRunId: string; revision: number; resolution: 'mark_indeterminate_side_effect'; now: string
  }) => RecoveryResolveResult
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

// 服务端时刻只从这里取：客户端发来的 now 仅作形状兼容，不进入租约/上报判定（S2 第二十三轮 P0-3）
const serverNow = (deps: ServerDeps): string => deps.now ? deps.now() : new Date().toISOString()

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
  // 每个请求只取一次服务端时刻：同一请求内的租约与上报用同一基准
  const requestNow = serverNow(deps)
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
    // 恢复不确定的节点：宿主面板查这里，确认后走 resolve（评审 P2-4）
    if (req.method === 'GET' && url.pathname === '/v1/recovery/uncertain' && deps.commands) {
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: deps.commands.listRecoveryUncertain() }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/recovery/resolve' && deps.commands) {
      const body = parseBody(recoveryResolveSchema, await readJsonBody(req), '确认恢复不确定')
      const out = await queue.run(() => deps.commands!.resolveRecoveryUncertain({ ...body, now: requestNow }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/load' && deps.commands) {
      // 定义哈希按整个 body 算：schema 用 looseObject，未知键原样传下去
      const body = parseBody(workflowLoadSchema, await readJsonBody(req), '加载工作流')
      const out = await queue.run(() => deps.commands!.loadWorkflow(body))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    // —— S4 工作流命令：写命令一律要求 operation_id，actor 只取认证主体 ——
    if (req.method === 'POST' && url.pathname === '/v1/workflows' && deps.commands) {
      const body = parseBody(workflowCreateCommandSchema, await readJsonBody(req), '创建工作流')
      const out = await queue.run(() => deps.commands!.createWorkflow({
        workflowId: body.workflow_id, name: body.name, definition: body.definition,
        scope: body.scope, ownerTaskId: body.owner_task_id ?? null,
        actor, now: requestNow, operationId: body.operation_id,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/open-draft' && deps.commands) {
      const body = parseBody(workflowOpenDraftCommandSchema, await readJsonBody(req), '打开草稿')
      const out = await queue.run(() => deps.commands!.openWorkflowDraft({
        workflowId: body.workflow_id, baseVersion: body.base_version,
        actor, now: requestNow, operationId: body.operation_id,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/update' && deps.commands) {
      const body = parseBody(workflowUpdateCommandSchema, await readJsonBody(req), '更新草稿')
      const out = await queue.run(() => deps.commands!.updateWorkflowDraft({
        workflowId: body.workflow_id, revision: body.revision, definition: body.definition,
        actor, now: requestNow, operationId: body.operation_id,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/publish' && deps.commands) {
      const body = parseBody(workflowPublishCommandSchema, await readJsonBody(req), '发布工作流')
      const out = await queue.run(() => deps.commands!.publishWorkflow({
        workflowId: body.workflow_id, revision: body.revision, baseVersion: body.base_version,
        note: body.publish_note ?? null, actor, now: requestNow, operationId: body.operation_id,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows/get' && deps.commands) {
      const workflowId = url.searchParams.get('workflow_id') ?? ''
      const out = deps.commands.getWorkflow({ workflowId })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows' && deps.commands) {
      const owner = url.searchParams.get('owner_task_id')
      const out = deps.commands.listWorkflows({ ownerTaskId: owner === null ? undefined : owner })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: out }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/start' && deps.commands) {
      const body = parseBody(startRunSchema, await readJsonBody(req), '起运行')
      const out = await queue.run(() => deps.commands!.startRun({
        taskTitle: body.taskTitle,
        workflowId: body.workflowId,
        workflowVersion: body.workflowVersion,
        nodeIds: body.nodeIds,
        autonomy: body.autonomy,
        escalations: body.escalations,
        operationId: body.operationId,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/decisions/resolve' && deps.commands) {
      const body = parseBody(resolveDecisionSchema, await readJsonBody(req), '裁决收口')
      await queue.run(() => deps.commands!.resolveDecision({
        decisionId: body.decisionId,
        revision: body.revision,
        resolution: body.resolution,
        payload: body.payload,
        actor: { kind: 'human', id: actor },
        evidenceProducers: body.evidenceProducers,
        confirm: body.confirm,
        contentHash: body.contentHash,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { decisionId: body.decisionId, revision: body.revision + 1 }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs' && deps.commands) {
      const body = parseBody(createRunSchema, await readJsonBody(req), '创建 run')
      const out = await queue.run(() => deps.commands!.createRun({
        taskTitle: body.taskTitle,
        workflowId: body.workflowId,
        workflowVersion: body.workflowVersion,
        nodeIds: body.nodeIds,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/dispatch' && deps.commands) {
      const body = parseBody(dispatchSchema, await readJsonBody(req), '派发节点')
      // 派发是长时间跑的 agent 执行，不占写队列的名额：写队列一满就拒，
      // 排队里的续租会被饿死（租约过期 → 节点被判失败）。并发上限由 ExecutionScheduler 管，
      // 里面的数据库写照旧走 withTx 单写者串行（第二次意见 P1）。
      const out = await deps.commands!.dispatch({
        runId: body.runId,
        nodes: body.nodes,
        now: requestNow,
        ownerEpoch: body.ownerEpoch,
        leaseTtlMs: body.leaseTtlMs,
        leaseRenewIntervalMs: body.leaseRenewIntervalMs,
      })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/lease' && deps.commands) {
      const body = parseBody(leaseSchema, await readJsonBody(req), '拿租约')
      const out = await queue.run(() => deps.commands!.acquireLease({
        nodeRunId: body.nodeRunId, ownerEpoch: body.ownerEpoch,
        leaseTtlMs: body.leaseTtlMs, now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/renew' && deps.commands) {
      const body = parseBody(renewSchema, await readJsonBody(req), '续租')
      const out = await queue.run(() => deps.commands!.renewLease({
        nodeRunId: body.nodeRunId, leaseTtlMs: body.leaseTtlMs, now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/report' && deps.commands) {
      const body = parseBody(reportSchema, await readJsonBody(req), '上报节点')
      const out = await queue.run(() => deps.commands!.report({
        nodeRunId: body.nodeRunId, attempt: body.attempt,
        report: body.report, expectedStatus: body.expectedStatus,
        generation: body.generation, decision: body.decision, now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/run' && deps.commands) {
      const body = parseBody(runNodeSchema, await readJsonBody(req), '执行节点')
      // 同上：执行节点是长时间任务，不占写队列名额（第二次意见 P1）
      const out = await deps.commands!.runNode({
        nodeRunId: body.nodeRunId, nodeId: body.nodeId, attempt: body.attempt,
        input: body.input ?? {}, outputSchema: body.outputSchema ?? {},
        tools: body.tools,
        now: requestNow,
        ownerEpoch: body.ownerEpoch,
        leaseTtlMs: body.leaseTtlMs,
        leaseRenewIntervalMs: body.leaseRenewIntervalMs,
      })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/confirm-start' && deps.commands) {
      const body = parseBody(confirmStartSchema, await readJsonBody(req), '确认启动')
      const out = await queue.run(() => deps.commands!.confirmStart({
        nodeRunId: body.nodeRunId,
        attempt: body.attempt,
        attested: body.attested,
        actor,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/node-runs/cancel' && deps.commands) {
      const body = parseBody(cancelSchema, await readJsonBody(req), '取消节点')
      const out = await queue.run(() => deps.commands!.cancel({
        nodeRunId: body.nodeRunId, attempt: body.attempt, revision: body.revision,
        cancelResult: body.cancelResult, now: requestNow, graceMs: body.graceMs,
        extendDeadlineMs: body.extendDeadlineMs,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/compensations/start' && deps.commands) {
      const body = parseBody(compensateStartSchema, await readJsonBody(req), '开始补偿')
      const out = await queue.run(() => deps.commands!.startCompensation({
        nodeRunId: body.nodeRunId,
        attempt: body.attempt,
        descriptor: body.descriptor,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/compensations/settle' && deps.commands) {
      const body = parseBody(compensateSettleSchema, await readJsonBody(req), '收口补偿')
      const out = await queue.run(() => deps.commands!.settleCompensation({
        compensationId: body.compensationId,
        state: body.state,
        evidence: body.evidence,
        reason: body.reason,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/wait/events' && deps.commands) {
      const body = parseBody(waitEventSchema, await readJsonBody(req), '等待事件')
      const out = await queue.run(() => deps.commands!.wakeOnEvent({
        runId: body.runId,
        eventType: body.eventType,
        payload: body.payload,
        idempotencyKey: body.idempotencyKey ?? null,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/cancel' && deps.commands) {
      const body = parseBody(cancelRunSchema, await readJsonBody(req), '取消运行')
      const out = await queue.run(() => deps.commands!.cancelRun({
        runId: body.runId,
        cancelResult: body.cancelResult,
        graceMs: body.graceMs,
        extendDeadlineMs: body.extendDeadlineMs,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/ledger/events') {
      const body = parseBody(ledgerEventSchema, await readJsonBody(req), '写账本事件')
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
