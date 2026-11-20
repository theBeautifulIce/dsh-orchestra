// HTTP 入口：只监听 127.0.0.1；/health 免认证，其余路径都要 x-orchestra-secret（规格 12.5 行 1091）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { OrchError, failEnvelope, okEnvelope, toOrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { TASK_LANES, TASK_ORIGINS, type TaskLane, type TaskOrigin } from '../core/task-workspace.ts'
import type { SetTaskArchive } from './commands/task-archive.ts'
import { taskTriggerCreateSchema, taskTriggerEnabledSchema, taskTriggerEventSchema, type TaskTriggerHost } from './task-triggers.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'
import { WriteQueue } from './write-queue.ts'
import { decodeCursor, encodeCursor, makeCursor } from './queries/cursor.ts'
import { ATTENTION_ORDER, type Attention } from './queries/attention.ts'
import type { ListTaskParams, TaskSummary, WorkspaceOverview } from './queries/tasks.ts'
import type { listEventHistory } from './queries/list_events.ts'
import type { listExecutionHistory } from './queries/execution-history.ts'
import type { RunSummary } from './queries/runs.ts'
import type { NodeRunView } from './queries/nodes.ts'
import type { ArtifactView, RunArtifact, getArtifactContent } from './queries/artifacts.ts'
import type { AttestationView } from './queries/attestations.ts'
import type { DecisionView, ListDecisionParams } from './queries/decisions.ts'
import type { EvidenceView } from './queries/evidence.ts'
import type { LedgerVerify } from './queries/verify_ledger.ts'
import type { ListEffectsParams, UnverifiedEffectView } from './queries/effects.ts'
import type { ListMemoryBatchesParams, MemoryBatchPage } from './queries/memory-batches.ts'
import type { ListWorkflowParams, WorkflowListItem, WorkflowVersionView, WorkflowView } from './queries/workflows.ts'
import type { OperationRow } from './queries/get_operation.ts'
import { LAST_EVENT_ID_HEADER, startEventStream } from './events/stream.ts'
import {
  acknowledgeDecisionSchema, cancelRunSchema, cancelSchema, compensateSettleSchema, compensateStartSchema, confirmStartSchema, createRunSchema, dispatchSchema, effectResolveSchema,
  ledgerEventSchema, leaseSchema, memoryInspectSchema, memoryRecoverySchema, memoryStartSchema, parseBody, recoveryResolveSchema,
  renewSchema, reportSchema, resolveDecisionSchema, runNodeSchema, startRunSchema, waitEventSchema, workflowLoadSchema,
  taskReserveSchema, taskArchiveSchema, workflowCreateCommandSchema, workflowOpenDraftCommandSchema, workflowUpdateCommandSchema, workflowPublishCommandSchema,
  workflowTestSchema, workflowGenerateSchema, workflowStatusSchema,
} from './schemas.ts'
import type { ApplyResult } from '../core/report.ts'
import type { CancelOutcome } from './commands/cancel.ts'
import type { CompensationDescriptor } from './commands/compensation.ts'
import type { RecoveryResolveResult } from './commands/recovery.ts'
import type { RecoveryUncertainItem } from './queries/recovery.ts'
import type { LoadWorkflowResult } from './workflows.ts'
import type { CreateRunResult } from './runs.ts'
import type { StartRunResult } from './commands/start-run.ts'
import type { acknowledgeDecision, Resolution } from './commands/decisions.ts'
import type { inspectEffectEvidence, EffectResolutionResult, EvidenceSource, ResolutionBasis } from './commands/effects.ts'
import type { Actor } from './decision/approver.ts'
import type { MemoryHost } from './memory-host.ts'
import { planConfirmSchema, planInputSchema, type TaskPlanningHost } from './task-planning.ts'
import { collaborationReassignSchema, collaborationReviewSchema, collaborationScopeSchema, type CollaborationHost } from './collaboration.ts'
import { reworkRequestSchema, reworkReviewSchema, type ReworkHost } from './rework-coordinator.ts'
import { deliveryHoldSchema, type createDeliveryReviewHost } from './delivery-review.ts'
import { localPlanInput, localPlanApproval, type createReworkPlanningHost } from './rework-planning.ts'
import { reworkInspectionInput, type createReworkInspectionHost } from './rework-inspection.ts'
import { modelRoutingSettingsSchema, type ModelRoutingSettingsHost } from './model-routing-settings.ts'
import { modelEscalationInput, type createModelEscalationHost } from './model-escalation.ts'
import type { DispatchOutcome, NodeSpec } from './dispatcher.ts'
import type { RunNodeResult } from '../executor/run-node.ts'
import type { ToolPolicy } from '../executor/session.ts'

/** Host-owned verification of a human session on this request. Use authenticated host context. */
export type ResolveHttpHuman = (request: IncomingMessage) => { id: string } | null | Promise<{ id: string } | null>

export type ServerDeps = {
  secret: string
  resolveHttpHuman?: ResolveHttpHuman
  phase: string
  epoch: number
  asOfSeq: () => number
  listTasks: (limit: number) => unknown[]
  listEvents: (fromSeq: number, limit: number) => unknown[]
  queries?: ServerQueries
  appendLedgerEvent: (body: unknown, actor: string) => { seq: number; event_id: string }
  log?: Logger
  queue?: WriteQueue
  // 服务端时钟：租约与上报的时刻只由服务端决定，请求体里的 now 不参与判定。
  // 测试可注入固定时刻；生产缺省读系统墙钟。
  now?: () => string
  // 生产路径的节点命令；缺省时这几条路由一律 404，老测试不受影响
  commands?: NodeCommands
  memory?: MemoryHost
  memoryProposalOnly?: () => boolean
  planning?: TaskPlanningHost
  collaboration?: CollaborationHost
  rework?: ReworkHost
  delivery?: ReturnType<typeof createDeliveryReviewHost>
  localPlanning?: ReturnType<typeof createReworkPlanningHost>
  inspection?: ReturnType<typeof createReworkInspectionHost>
  modelEscalation?: ReturnType<typeof createModelEscalationHost>
  modelSettings?: ModelRoutingSettingsHost
  taskTriggers?: TaskTriggerHost
  workflowGenerator?: (input: { goal: string }, signal: AbortSignal) => Promise<unknown>
}

export type ServerQueries = {
  listEvents: (fromSeq: number, limit: number) => { rows: unknown[]; as_of_seq: number }
  listEventHistory: (params: Parameters<typeof listEventHistory>[1]) => ReturnType<typeof listEventHistory>
  listExecutionHistory: (params: Parameters<typeof listExecutionHistory>[1]) => ReturnType<typeof listExecutionHistory>
  listTaskSummaries: (params: ListTaskParams) => { items: TaskSummary[]; next_cursor: string | null; as_of_seq: number }
  getTaskSummary: (taskId: string, now: number) => { item: TaskSummary; as_of_seq: number }
  getWorkspaceOverview: () => { item: WorkspaceOverview; as_of_seq: number }
  listRuns: (opts: { task_id?: string; workflow_id?: string; limit?: number; cursor?: string }) => {
    items: RunSummary[]; next_cursor?: string | null; as_of_seq: number
  }
  getRun: (runId: string) => RunSummary
  listNodes: (runId: string, limit?: number) => { items: NodeRunView[]; as_of_seq: number }
  getNode: (nodeRunId: string) => { item: NodeRunView; as_of_seq: number }
  getArtifact: (artifactId: string, now: number) => { item: ArtifactView; as_of_seq: number }
  getArtifactContent?: (runId: string, artifactId: string, mode: Parameters<typeof getArtifactContent>[3], now: number) => ReturnType<typeof getArtifactContent>
  listRunArtifacts: (runId: string, now: number) => { items: RunArtifact[]; has_more: boolean; as_of_seq: number }
  getAttestation: (attestationId: string) => { item: AttestationView; as_of_seq: number }
  listDecisions: (params: ListDecisionParams) => { items: DecisionView[]; next_cursor: string | null; as_of_seq: number }
  getDecision: (decisionId: string, now?: number) => { item: DecisionView; as_of_seq: number }
  getEvidence: (evidenceId: string) => { item: EvidenceView; as_of_seq: number }
  verifyLedger: () => { item: LedgerVerify; as_of_seq: number }
  listUnverifiedEffects: (params: ListEffectsParams) => { items: UnverifiedEffectView[]; next_cursor: string | null; as_of_seq: number }
  inspectEffectEvidence: (nodeRunId: string) => ReturnType<typeof inspectEffectEvidence>
  listMemoryBatches: (params: ListMemoryBatchesParams) => MemoryBatchPage
  listWorkflows: (params: ListWorkflowParams) => { items: WorkflowListItem[]; next_cursor: string | null; as_of_seq: number }
  getWorkflow: (workflowId: string) => { item: WorkflowView; as_of_seq: number }
  getWorkflowVersion: (workflowId: string, version: number) => { item: WorkflowVersionView; as_of_seq: number }
  getOperation: (operationId: string, now: number) => { item: OperationRow; as_of_seq: number }
}

import type { CreateWorkflowParams, OpenDraftParams, PublishParams, UpdateDraftParams } from './commands/workflows.ts'
import type { SetWorkflowStatusParams, WorkflowDraftTest } from './commands/workflows.ts'
import { validateSaveLayer } from '../core/workflow-doc.ts'

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
  testWorkflowDraft: (body: { workflowId: string; revision: number; now: string }) => WorkflowDraftTest
  getWorkflowDraftTest: (workflowId: string) => WorkflowDraftTest | null
  setWorkflowStatus: (body: SetWorkflowStatusParams) => unknown
  publishWorkflow: (body: PublishParams & { operationId: string }) => unknown
  reserveTask: (body: { title: string; actor: string; now: string; operationId: string }) => unknown
  getWorkflow: (body: { workflowId: string }) => unknown
  listWorkflows: (body: { ownerTaskId?: string | null }) => unknown
  // 建 run 与节点：定义加载后由服务层建行，不许靠手写 INSERT 起节点（审计 F-01）
  createRun: (body: { taskTitle: string; workflowId?: string; workflowVersion: string; nodeIds?: string[]; now: string }) => CreateRunResult
  // 起运行：固定版本、operation_id 幂等、自治档位与升级规则；HTTP 只搬字段
  startRun: (body: {
    taskId?: string
    taskTitle: string
    workflowId?: string
    workflowVersion: string
    nodeIds?: string[]
    autonomy?: 'autonomous' | 'assisted' | 'supervised'
    triggerKind?: TaskOrigin
    escalations?: { kind: 'node_type' | 'action_category' | 'workflow_version_publish'; value: string }[]
    operationId: string
    startedBy?: string
    now: string
  }) => StartRunResult
  setTaskArchive?: (body: SetTaskArchive, actor: string, now: string) => { task_id: string; archived_at: string | null }
  // 裁决收口：批准人、confirm_required 与 revision 都由服务层判
  acknowledgeDecision: (body: Parameters<typeof acknowledgeDecision>[1]) => ReturnType<typeof acknowledgeDecision>
  resolveDecision: (body: {
    decisionId: string
    revision: number
    resolution: Resolution
    payload?: Record<string, unknown>
    actor?: Actor
    evidenceProducers?: string[]
    bindActor?: boolean
    confirm?: boolean
    confirmChallenge?: string
    contentHash?: string
    operationId?: string
    now: string
  }) => { decisionId: string; revision: number; replayed?: boolean }
  // 副作用结算：服务受控写入口（附录 §4、§5）
  resolveEffect: (body: {
    basis: ResolutionBasis
    nodeRunId: string
    runId?: string | null
    evidenceId?: string | null
    decisionId?: string | null
    stopEvidence?: string | null
    evidenceSource?: EvidenceSource | null
    expected: { revision: number; decisionRevision?: number | null }
    operationId: string
    now: string
    actor: Actor
  }) => EffectResolutionResult
  // 启动未知的人工确认：M-08/M-09/M-61 的生产入口
  confirmStart: (body: { nodeRunId: string; attempt: number; attested?: boolean; now: string; actor?: string }) => {
    trigger: 'confirm-started' | 'confirm-started-attested' | 'confirm-started-with-tool'; attestation_id?: string
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
  const supplied = sha256Hex(got)
  if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(sha256Hex(secret), 'hex'))) {
    throw new OrchError('UNAUTHORIZED', '认证主体无效', { reason: 'bad_secret' })
  }
  // actor 由认证主体派生；payload 里的 actor 字段一律忽略
  return 'service:' + supplied.slice(0, 8)
}

function authenticatedHuman(deps: ServerDeps, serviceActor: string, bound: { id: string } | null | undefined): Actor {
  if (deps.phase !== 'S6') return { kind: 'human', id: serviceActor }
  if (!bound || typeof bound.id !== 'string' || !bound.id.trim() || bound.id !== bound.id.trim() || bound.id.length > 256
    || /[\u0000-\u001f\u007f]/u.test(bound.id) || /^(?:service|agent|system):/i.test(bound.id)) {
    throw new OrchError('FORBIDDEN', '这条命令需要宿主认证的人工会话')
  }
  return { kind: 'human', id: bound.id }
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

function taskDateParam(url: URL, name: string): string | undefined {
  const value = stringParam(url, name, 30)
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '任务日期格式无效')
  return value
}

function stringParam(url: URL, name: string, maxLength = 256): string | undefined {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  if (value.length > maxLength) throw new OrchError('RANGE_TOO_LARGE', '查询参数太长', { name, limit: maxLength })
  return value
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, queue: WriteQueue): Promise<void> {
  const log = deps.log ?? nullLogger
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // 每个请求只取一次服务端时刻：同一请求内的租约与上报用同一基准
  const requestNow = serverNow(deps)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), {
        ok: true, phase: deps.phase, epoch: deps.epoch, memory_enabled: Boolean(deps.memory),
        memory_proposal_only: deps.memoryProposalOnly?.() ?? false,
        collaboration_enabled: Boolean(deps.collaboration), model_routing_enabled: Boolean(deps.modelSettings),
        rework_enabled: Boolean(deps.rework), rework_planner_enabled: deps.localPlanning?.enabled === true,
        model_escalation_enabled: Boolean(deps.modelEscalation),
      }))
      return
    }
    const serviceActor = authenticate(req, deps.secret)
    const bound = deps.phase === 'S6' ? await deps.resolveHttpHuman?.(req) : undefined
    const human = () => authenticatedHuman(deps, serviceActor, bound)
    const actor = bound ? human().id : serviceActor
    if (deps.modelEscalation && url.pathname === '/v1/model-escalation') {
      if (req.method === 'GET') {
        const { as_of_seq, ...view } = deps.modelEscalation.get(stringParam(url, 'run_id') ?? '', stringParam(url, 'node_run_id') ?? '', human().id)
        sendJson(res, 200, okEnvelope(as_of_seq, view))
        return
      }
      if (req.method === 'POST') {
        const body = parseBody(modelEscalationInput, await readJsonBody(req), '主脑诊断节点模型')
        const result = await deps.modelEscalation.assess(body, human().id, requestNow)
        sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
        return
      }
    }

    if (req.method === 'POST' && deps.inspection && url.pathname === '/v1/rework/inspect') {
      const body = parseBody(reworkInspectionInput, await readJsonBody(req), '主脑检查指定成果')
      const result = await deps.inspection.inspect(body, human().id, requestNow)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && deps.inspection && url.pathname === '/v1/rework/inspections') {
      const { items, as_of_seq } = deps.inspection.list(stringParam(url, 'run_id') ?? '', human().id)
      sendJson(res, 200, okEnvelope(as_of_seq, { items }))
      return
    }

    if (req.method === 'GET' && deps.rework && url.pathname === '/v1/rework') {
      const { items, as_of_seq } = deps.rework.list(human().id, stringParam(url, 'run_id'))
      sendJson(res, 200, okEnvelope(as_of_seq, { items }))
      return
    }
    if (req.method === 'GET' && deps.rework && url.pathname === '/v1/rework/get') {
      const { item, as_of_seq } = deps.rework.get(stringParam(url, 'request_id') ?? '', human().id)
      sendJson(res, 200, okEnvelope(as_of_seq, { item }))
      return
    }
    if (req.method === 'POST' && deps.rework && url.pathname === '/v1/rework/request') {
      const body = parseBody(reworkRequestSchema, await readJsonBody(req), '提出成果修改意见')
      const reviewer = human().id
      const result = await queue.run(() => deps.rework!.request(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && deps.rework && url.pathname === '/v1/rework/review') {
      const reviewer = human().id
      const body = parseBody(reworkReviewSchema, await readJsonBody(req), '审核成果修改')
      const result = await queue.run(() => deps.rework!.review(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && deps.delivery && url.pathname === '/v1/rework/holds') {
      const { items, as_of_seq } = deps.delivery.list(human().id, stringParam(url, 'run_id'))
      sendJson(res, 200, okEnvelope(as_of_seq, { items }))
      return
    }
    if (req.method === 'POST' && deps.delivery && url.pathname === '/v1/rework/hold') {
      const reviewer = human().id
      const body = parseBody(deliveryHoldSchema, await readJsonBody(req), '设置人工成果留验')
      const result = await queue.run(() => deps.delivery!.change(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && deps.localPlanning && url.pathname === '/v1/rework/topology') {
      const { as_of_seq, ...view } = deps.localPlanning.topology(stringParam(url, 'run_id') ?? '', human().id)
      sendJson(res, 200, okEnvelope(as_of_seq, view))
      return
    }
    if (req.method === 'GET' && deps.localPlanning && url.pathname === '/v1/rework/plan') {
      const { plan, as_of_seq } = deps.localPlanning.get(stringParam(url, 'request_id') ?? '', human().id)
      sendJson(res, 200, okEnvelope(as_of_seq, { plan }))
      return
    }
    if (req.method === 'POST' && deps.localPlanning && url.pathname === '/v1/rework/plan') {
      const body = parseBody(localPlanInput, await readJsonBody(req), '生成局部返工方案')
      const result = await deps.localPlanning.propose(body, human().id, requestNow)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && deps.localPlanning && url.pathname === '/v1/rework/plan/approve') {
      const reviewer = human().id
      const body = parseBody(localPlanApproval, await readJsonBody(req), '批准局部返工方案')
      const result = await queue.run(() => deps.localPlanning!.approve(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/settings/model-routing' && deps.modelSettings) {
      const { item, as_of_seq } = deps.modelSettings.get()
      sendJson(res, 200, okEnvelope(as_of_seq, item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/settings/model-routing' && deps.modelSettings) {
      const body = parseBody(modelRoutingSettingsSchema, await readJsonBody(req), '保存模型分配')
      const result = await queue.run(() => deps.modelSettings!.save(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/collaboration/scopes' && deps.collaboration) {
      const { as_of_seq, items } = deps.collaboration.listScopes(actor)
      sendJson(res, 200, okEnvelope(as_of_seq, { items }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/collaboration/scopes/get' && deps.collaboration) {
      const { as_of_seq, item } = deps.collaboration.getScope(stringParam(url, 'scope_id', 128) ?? '', actor, requestNow)
      sendJson(res, 200, okEnvelope(as_of_seq, item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/collaboration/scopes' && deps.collaboration) {
      const body = parseBody(collaborationScopeSchema, await readJsonBody(req), '建立协作范围')
      const result = await queue.run(() => deps.collaboration!.createScope(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/collaboration/review' && deps.collaboration) {
      const reviewer = human().id
      const body = parseBody(collaborationReviewSchema, await readJsonBody(req), '处理核验请求')
      const result = await queue.run(() => deps.collaboration!.review(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/collaboration/reassign' && deps.collaboration) {
      const reviewer = human().id
      const body = parseBody(collaborationReassignSchema, await readJsonBody(req), '重新指派核验')
      const result = await queue.run(() => deps.collaboration!.reassignVerification(body, reviewer, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/task-plans/capability') {
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { enabled: deps.planning?.enabled === true }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/task-plans/get' && deps.planning) {
      const { view, as_of_seq } = deps.planning.get(stringParam(url, 'plan_id', 64) ?? '', actor)
      sendJson(res, 200, okEnvelope(as_of_seq, view))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/task-plans/by-task' && deps.planning) {
      const { item, as_of_seq } = deps.planning.getForTask(stringParam(url, 'task_id', 256) ?? '', actor)
      sendJson(res, 200, okEnvelope(as_of_seq, item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/task-plans' && deps.planning) {
      const input = parseBody(planInputSchema, await readJsonBody(req), '任务规划目标')
      const { view, as_of_seq } = await deps.planning.propose(input, actor, requestNow)
      sendJson(res, 200, okEnvelope(as_of_seq, view))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/task-plans/confirm' && deps.planning) {
      const input = parseBody(planConfirmSchema, await readJsonBody(req), '任务计划确认')
      const result = await queue.run(() => deps.planning!.confirm(input, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/task-triggers' && deps.taskTriggers) {
      const { as_of_seq, items } = deps.taskTriggers.list(stringParam(url, 'task_id', 128))
      sendJson(res, 200, okEnvelope(as_of_seq, { items }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/task-triggers' && deps.taskTriggers) {
      const body = parseBody(taskTriggerCreateSchema, await readJsonBody(req), '登记任务触发规则')
      const item = await queue.run(() => deps.taskTriggers!.create(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/task-triggers/enabled' && deps.taskTriggers) {
      const body = parseBody(taskTriggerEnabledSchema, await readJsonBody(req), '切换任务触发规则')
      const item = await queue.run(() => deps.taskTriggers!.setEnabled(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/task-triggers/event' && deps.taskTriggers) {
      const body = parseBody(taskTriggerEventSchema, await readJsonBody(req), '接收任务触发事件')
      const result = await queue.run(() => deps.taskTriggers!.emit(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workspace/overview' && deps.queries) {
      const result = deps.queries.getWorkspaceOverview()
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      if (deps.queries) {
        const attentionRaw = stringParam(url, 'attention', 24)
        if (attentionRaw !== undefined && !(ATTENTION_ORDER as readonly string[]).includes(attentionRaw)) {
          throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'attention 过滤值无效', { attention: attentionRaw })
        }
        const lane = stringParam(url, 'lane', 24)
        const trigger = stringParam(url, 'trigger_kind', 24)
        const archive = stringParam(url, 'archived', 1)
        const from = taskDateParam(url, 'updated_from')
        const before = taskDateParam(url, 'updated_before')
        if ((lane && !TASK_LANES.some((item) => item.id === lane))
          || (trigger && trigger !== 'unknown' && !(TASK_ORIGINS as readonly string[]).includes(trigger))
          || (archive !== undefined && archive !== '0' && archive !== '1') || (from && before && from >= before)) {
          throw new OrchError('PAYLOAD_SCHEMA_INVALID', '任务筛选值无效')
        }
        const result = deps.queries.listTaskSummaries({
          limit: Math.min(intParam(url, 'limit', 50), 100),
          cursor: stringParam(url, 'cursor', 4096),
          status: stringParam(url, 'status', 64),
          query: stringParam(url, 'query', 200),
          attention: attentionRaw as Attention | undefined,
          lane: lane as TaskLane | undefined, trigger_kind: trigger as TaskOrigin | 'unknown' | undefined,
          archived: archive === '1', updated_from: from, updated_before: before,
          now: Date.parse(requestNow),
        })
        sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, next_cursor: result.next_cursor }))
      } else {
        const limit = Math.min(intParam(url, 'limit', 50), 200)
        sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: deps.listTasks(limit) }))
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/tasks/archive' && deps.commands?.setTaskArchive) {
      const body = parseBody(taskArchiveSchema, await readJsonBody(req), '归档或取回任务')
      const result = await queue.run(() => deps.commands!.setTaskArchive!(body, actor, requestNow))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks/get' && deps.queries) {
      const taskId = stringParam(url, 'task_id', 256) ?? ''
      const result = deps.queries.getTaskSummary(taskId, Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/runs' && deps.queries) {
      const taskId = stringParam(url, 'task_id', 256)
      const workflowId = stringParam(url, 'workflow_id', 128)
      const result = deps.queries.listRuns({ task_id: taskId, workflow_id: workflowId,
        limit: Math.min(intParam(url, 'limit', 50), 100), cursor: stringParam(url, 'cursor', 4096) })
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, next_cursor: result.next_cursor ?? null }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/runs/get' && deps.queries) {
      const result = deps.queries.getRun(stringParam(url, 'run_id', 256) ?? '')
      sendJson(res, 200, okEnvelope(result.as_of_seq, result))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/node-runs' && deps.queries) {
      const runId = stringParam(url, 'run_id', 256) ?? ''
      const result = deps.queries.listNodes(runId, Math.min(intParam(url, 'limit', 100), 200))
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/node-runs/get' && deps.queries) {
      const result = deps.queries.getNode(stringParam(url, 'node_run_id', 256) ?? '')
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/artifacts/get' && deps.queries) {
      const result = deps.queries.getArtifact(stringParam(url, 'artifact_id', 256) ?? '', Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/artifacts/content' && deps.queries?.getArtifactContent) {
      res.setHeader('cache-control', 'private, no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      const runId = stringParam(url, 'run_id')
      const artifactId = stringParam(url, 'artifact_id')
      const mode = stringParam(url, 'mode', 8)
      if (!runId || !artifactId || (mode !== 'preview' && mode !== 'download')) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', '需要有效的运行编号、产物编号和读取方式')
      }
      const { item, as_of_seq } = deps.queries.getArtifactContent(runId, artifactId, mode, Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(as_of_seq, item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/artifacts' && deps.queries) {
      const result = deps.queries.listRunArtifacts(stringParam(url, 'run_id', 256) ?? '', Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, has_more: result.has_more }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/attestations/get' && deps.queries) {
      const result = deps.queries.getAttestation(stringParam(url, 'attestation_id', 256) ?? '')
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/decisions' && deps.queries) {
      const inbox = stringParam(url, 'inbox', 16)
      if (inbox !== undefined && inbox !== 'human') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知的审批收件箱')
      const result = deps.queries.listDecisions({
        run_id: stringParam(url, 'run_id', 256),
        status: stringParam(url, 'status', 64),
        humanInbox: inbox === 'human',
        limit: Math.min(intParam(url, 'limit', 50), 100),
        cursor: stringParam(url, 'cursor', 4096),
        now: Date.parse(requestNow),
      })
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, next_cursor: result.next_cursor }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/decisions/get' && deps.queries) {
      const result = deps.queries.getDecision(stringParam(url, 'decision_id', 256) ?? '', Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/memory/batches' && deps.queries?.listMemoryBatches) {
      const result = deps.queries.listMemoryBatches({
        task_id: stringParam(url, 'task_id', 256),
        limit: intParam(url, 'limit', 50),
        cursor: stringParam(url, 'cursor', 4096),
        now: Date.parse(requestNow),
      })
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, next_cursor: result.next_cursor }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/memory/runs/start' && deps.memory) {
      const body = parseBody(memoryStartSchema, await readJsonBody(req), '启动记忆整理')
      const out = await queue.run(() => deps.memory!.start({ ...body, now: requestNow }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/memory/recovery/inspect' && deps.memory) {
      const body = parseBody(memoryInspectSchema, await readJsonBody(req), '核对记忆写入')
      // The adapter call awaits the writer outside the global write queue. Recovery verifies the scope again in its final transaction.
      const out = await deps.memory.inspect(body.batch_id)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/memory/recovery/resolve' && deps.memory) {
      const approver = human()
      const body = parseBody(memoryRecoverySchema, await readJsonBody(req), '恢复记忆写入')
      const out = await queue.run(() => deps.memory!.resolve(approver, body))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/evidence/get' && deps.queries) {
      const result = deps.queries.getEvidence(stringParam(url, 'evidence_id', 256) ?? '')
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/ledger/verify' && deps.queries) {
      const result = deps.queries.verifyLedger()
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/effects/review' && deps.queries) {
      const result = deps.queries.inspectEffectEvidence(stringParam(url, 'node_run_id', 256) ?? '')
      sendJson(res, 200, okEnvelope(result.as_of_seq, result.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/effects/unverified' && deps.queries) {
      const result = deps.queries.listUnverifiedEffects({
        run_id: stringParam(url, 'run_id', 256),
        limit: Math.min(intParam(url, 'limit', 50), 100),
        cursor: stringParam(url, 'cursor', 4096),
        now: Date.parse(requestNow),
      })
      sendJson(res, 200, okEnvelope(result.as_of_seq, { items: result.items, next_cursor: result.next_cursor }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/execution-history' && deps.queries) {
      const { as_of_seq, ...data } = deps.queries.listExecutionHistory({
        taskId: stringParam(url, 'task_id', 256), runId: stringParam(url, 'run_id', 256), nodeId: stringParam(url, 'node_run_id', 256),
        before: intParam(url, 'before', Number.MAX_SAFE_INTEGER), limit: intParam(url, 'limit', 35),
      })
      sendJson(res, 200, okEnvelope(as_of_seq, data))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/activity' && deps.queries) {
      const { as_of_seq, ...data } = deps.queries.listEventHistory({ runId: stringParam(url, 'run_id', 256), taskId: stringParam(url, 'task_id', 256),
        beforeSeq: intParam(url, 'before_seq', Number.MAX_SAFE_INTEGER), limit: Math.min(intParam(url, 'limit', 40), 100) })
      sendJson(res, 200, okEnvelope(as_of_seq, data))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      // 游标与 from_seq 二选一；游标按 kind=events、无过滤条件绑定（规格 8.3 行 638）
      const rawCursor = url.searchParams.get('cursor')
      if (rawCursor !== null && url.searchParams.has('from_seq')) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'cursor 与 from_seq 只能指定其中一个')
      }
      const fromSeq = rawCursor === null
        ? intParam(url, 'from_seq', 0)
        : Number(decodeCursor(rawCursor, 'events', {}).last_key)
      if (!Number.isInteger(fromSeq) || fromSeq < 0) throw new OrchError('CURSOR_EXPIRED', '游标里的位置不合法', { cursor: rawCursor })
      const limit = Math.min(intParam(url, 'limit', 100), 200)
      const result = deps.queries?.listEvents(fromSeq, limit)
      const rows = result?.rows ?? deps.listEvents(fromSeq, limit)
      const last = rows.length === 0 ? null : (rows[rows.length - 1] as { seq?: number }).seq
      const asOfSeq = result?.as_of_seq ?? deps.asOfSeq()
      const nextCursor = typeof last === 'number' ? encodeCursor(makeCursor('events', {}, String(last), '', asOfSeq)) : null
      sendJson(res, 200, okEnvelope(asOfSeq, { items: rows, next_cursor: nextCursor }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events/stream' && deps.queries) {
      const headerValue = req.headers[LAST_EVENT_ID_HEADER]
      const queryValue = url.searchParams.get('after_seq')
      if (Array.isArray(headerValue)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'Last-Event-ID 只能有一个值', {})
      const rawSeq = typeof headerValue === 'string' ? headerValue : queryValue
      const initialSeq = rawSeq === null || rawSeq === undefined || rawSeq === '' ? 0 : Number(rawSeq)
      if (!Number.isSafeInteger(initialSeq) || initialSeq < 0) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'Last-Event-ID 必须是非负整数', { last_event_id: rawSeq })
      }
      startEventStream(req, res, (afterSeq, limit) => deps.queries!.listEvents(afterSeq, limit), initialSeq)
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
    if (req.method === 'POST' && url.pathname === '/v1/tasks/reserve' && deps.commands) {
      const body = parseBody(taskReserveSchema, await readJsonBody(req), '预留任务')
      const out = await queue.run(() => deps.commands!.reserveTask({
        title: body.title, actor, now: requestNow, operationId: body.operation_id,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows' && deps.commands) {
      const body = parseBody(workflowCreateCommandSchema, await readJsonBody(req), '创建工作流')
      const out = await queue.run(() => deps.commands!.createWorkflow({
        workflowId: body.workflow_id, name: body.name, definition: body.definition,
        scope: body.scope,
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
    if (req.method === 'GET' && url.pathname === '/v1/workflows/generate/capability') {
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { enabled: Boolean(deps.workflowGenerator) }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/generate' && deps.workflowGenerator) {
      const body = parseBody(workflowGenerateSchema, await readJsonBody(req), '生成 Workflow 草稿')
      const signal = AbortSignal.timeout(45_000)
      const proposed = await deps.workflowGenerator(body, signal)
      signal.throwIfAborted()
      const saved = validateSaveLayer(proposed)
      if (!saved.saved || saved.report.errors.length > 0 || saved.saved.scope === 'task_local') {
        throw new OrchError('WORKFLOW_VALIDATION_FAILED', '生成的可复用 Workflow 草稿结构不合法', { errors: saved.report.errors })
      }
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { definition: saved.saved, validation: saved.report }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows/test' && deps.commands) {
      const workflowId = stringParam(url, 'workflow_id', 256) ?? ''
      const result = deps.commands.getWorkflowDraftTest(workflowId)
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/test' && deps.commands) {
      const body = parseBody(workflowTestSchema, await readJsonBody(req), '流程结构与模拟流转测试')
      const result = await queue.run(() => deps.commands!.testWorkflowDraft({ workflowId: body.workflow_id, revision: body.revision, now: requestNow }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), result))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/workflows/status' && deps.commands) {
      const body = parseBody(workflowStatusSchema, await readJsonBody(req), '更新 Workflow 状态')
      const out = await queue.run(() => deps.commands!.setWorkflowStatus({
        workflowId: body.workflow_id, status: body.status, expectedStatus: body.expected_status,
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
    if (req.method === 'GET' && url.pathname === '/v1/workflows/get' && deps.queries) {
      const workflowId = stringParam(url, 'workflow_id', 256) ?? ''
      const out = deps.queries.getWorkflow(workflowId)
      sendJson(res, 200, okEnvelope(out.as_of_seq, out.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows/get' && deps.commands) {
      const workflowId = url.searchParams.get('workflow_id') ?? ''
      const out = deps.commands.getWorkflow({ workflowId })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows' && deps.queries) {
      const out = deps.queries.listWorkflows({
        owner_task_id: stringParam(url, 'owner_task_id', 256),
        status: stringParam(url, 'status', 64),
        query: stringParam(url, 'query', 200),
        limit: Math.min(intParam(url, 'limit', 50), 100),
        cursor: stringParam(url, 'cursor', 4096),
        now: Date.parse(requestNow),
      })
      sendJson(res, 200, okEnvelope(out.as_of_seq, { items: out.items, next_cursor: out.next_cursor }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows' && deps.commands) {
      const owner = url.searchParams.get('owner_task_id')
      const out = deps.commands.listWorkflows({ ownerTaskId: owner === null ? undefined : owner })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), { items: out }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/workflows/versions/get' && deps.queries) {
      const workflowId = stringParam(url, 'workflow_id', 256) ?? ''
      const version = intParam(url, 'version', 0)
      if (version < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'version 必须是正整数', { version })
      const out = deps.queries.getWorkflowVersion(workflowId, version)
      sendJson(res, 200, okEnvelope(out.as_of_seq, out.item))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/operations/get' && deps.queries) {
      const operationId = stringParam(url, 'operation_id', 64) ?? ''
      const out = deps.queries.getOperation(operationId, Date.parse(requestNow))
      sendJson(res, 200, okEnvelope(out.as_of_seq, out.item))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/start' && deps.commands) {
      const body = parseBody(startRunSchema, await readJsonBody(req), '起运行')
      const out = await queue.run(() => deps.commands!.startRun({
        taskId: body.task_id,
        taskTitle: body.taskTitle,
        workflowId: body.workflowId,
        workflowVersion: body.workflowVersion,
        nodeIds: body.nodeIds,
        autonomy: body.autonomy,
        triggerKind: body.triggerKind,
        escalations: body.escalations,
        operationId: body.operationId,
        ...(bound ? { startedBy: human().id } : {}),
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/decisions/acknowledge' && deps.commands) {
      const approver = human()
      const body = parseBody(acknowledgeDecisionSchema, await readJsonBody(req), '确认收到决定')
      const out = await queue.run(() => deps.commands!.acknowledgeDecision({
        decisionId: body.decisionId, revision: body.revision, operationId: body.operation_id,
        actor: approver, now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/decisions/resolve' && deps.commands) {
      const approver = human()
      const body = parseBody(resolveDecisionSchema, await readJsonBody(req), '裁决收口')
      const audit = { operationId: body.operation_id, decisionId: body.decisionId, actorId: approver.id }
      const out = await queue.run(() => deps.commands!.resolveDecision({
        decisionId: body.decisionId,
        revision: body.revision,
        resolution: body.resolution,
        payload: body.payload,
        actor: approver,
        ...(deps.phase === 'S6' ? { bindActor: true } : {}),
        evidenceProducers: body.evidenceProducers,
        confirm: body.confirm,
        confirmChallenge: body.confirm_challenge,
        contentHash: body.contentHash,
        operationId: body.operation_id,
        now: requestNow,
      })).catch(error => {
        const code = toOrchError(error).code
        if (code !== 'CONFIRMATION_REQUIRED') log.warn('裁决命令审计', { ...audit, outcome: 'rejected', code })
        throw error
      })
      if (out.replayed) log.info('裁决命令审计', { ...audit, outcome: 'replayed' })
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/effects/resolve' && deps.commands) {
      const approver = human()
      const body = parseBody(effectResolveSchema, await readJsonBody(req), '副作用结算')
      const out = await queue.run(() => deps.commands!.resolveEffect({
        basis: body.basis,
        nodeRunId: body.node_run_id,
        runId: body.run_id ?? null,
        evidenceId: body.evidence_id ?? null,
        decisionId: body.decision_id ?? null,
        stopEvidence: body.stop_evidence ?? null,
        evidenceSource: body.evidence_source ?? null,
        expected: {
          revision: body.expected.revision,
          decisionRevision: body.expected.decision_revision ?? null,
        },
        operationId: body.operation_id,
        actor: approver,
        now: requestNow,
      }))
      sendJson(res, 200, okEnvelope(deps.asOfSeq(), out))
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
      const approver = human()
      const body = parseBody(confirmStartSchema, await readJsonBody(req), '确认启动')
      const out = await queue.run(() => deps.commands!.confirmStart({
        nodeRunId: body.nodeRunId,
        attempt: body.attempt,
        attested: body.attested,
        actor: approver.id,
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
      if (body.type === 'decision.command_audited') throw new OrchError('FORBIDDEN', '裁决审计只由命令处理器记录')
      const out = await queue.run(() => deps.appendLedgerEvent(body, serviceActor))
      sendJson(res, 200, okEnvelope(out.seq, { seq: out.seq, event_id: out.event_id, actor: serviceActor }))
      return
    }
    throw new OrchError('NOT_FOUND', '没有这个接口', { path: url.pathname, method: req.method })
  } catch (err) {
    const e = toOrchError(err)
    if (e.httpStatus >= 500) log.error('请求失败', { code: e.code })
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
