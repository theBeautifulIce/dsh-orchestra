// src/service/dispatcher.ts —— 主脑派发：把 run 下排队的节点交给生产执行器（审计 F-01）
// 评审 P1：agent 执行是长时间任务，不许占着写队列的名额；并发闸由装配层统一注入。
// 调度器不再由 dispatcher 自己持有：否则 /v1/node-runs/run 与 /v1/runs/dispatch 各走一套，
// 或者同一次 runNode 被调度两次、重复占用名额（S2 第三十七轮 P0-01）。
import { ERROR_STATUS, PROPOSED_ERROR_CODES, OrchError, type AnyOrchErrorCode } from '../core/errors.ts'
import { DEFAULT_LEASE_TTL_MS, runNode, type RunNodeDeps, type RunNodeParams, type RunNodeResult } from '../executor/run-node.ts'
import { inTx } from '../infra/db/tx.ts'
import { acquireNodeRun, type RuntimeDeps } from './commands/runtime.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { enterWaiting, type WaitKind, type WaitMatch } from './commands/wait.ts'
import { startSubworkflowNode } from './commands/subworkflow.ts'
import { loadNodeRun } from './commands/lease.ts'
import { definitionHashOf, type WorkflowCatalog } from './workflows.ts'
import { closeRun } from './commands/run-close.ts'
import { applyTransition } from './commands/nodes.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'

export type NodeSpec = {
  tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
  input?: unknown
  outputSchema?: unknown
}

export type DispatchParams = {
  runId: string
  // 按 node_id 给每个节点要跑的工具与策略；没给的节点这一轮跳过
  nodes: Record<string, NodeSpec>
  now: string
  ownerEpoch?: number
  leaseTtlMs?: number
  leaseRenewIntervalMs?: number
}

/** 只认登记过的错误码：任意异常的 code 字符串不进联合类型（评审 P2-3） */
const KNOWN_ERROR_CODES = new Set<string>([...Object.keys(ERROR_STATUS), ...Object.keys(PROPOSED_ERROR_CODES)])
function dispatchErrorCode(err: unknown): DispatchOutcomeErrorCode {
  const raw = err instanceof OrchError ? err.code : (err as { code?: unknown } | null | undefined)?.code
  // 登记表之外的一律不进联合类型：宿主拿到的永远是登记过的码
  return typeof raw === 'string' && KNOWN_ERROR_CODES.has(raw) ? (raw as DispatchOutcomeErrorCode) : ''
}

/** 派发结果错误码：DISPATCH_SETTLE_FAILED 是派发结果级（非顶层 OrchError），其余复用 OrchErrorCode */
export type DispatchOutcomeErrorCode = 'DISPATCH_SETTLE_FAILED' | AnyOrchErrorCode | ''

export type DispatchOutcome = {
  node_run_id: string
  node_id: string
  status: 'done' | 'failed' | 'skipped' | 'waiting'
  reason?: string
  /** 派发结果级错误码：含派发专属 DISPATCH_SETTLE_FAILED 与顶层 OrchErrorCode（S3 r64 P2） */
  error_code?: DispatchOutcomeErrorCode
  agent_id?: string
  evidence_source?: string
  /** 节点被并发流程接管时的当前状态：返回 skipped 而不是 failed（S1/S2 round60 P2） */
  current_status?: string
  /** 收口结果类别：storage_error 时调用方必须查状态后再决定能否重派 */
  settlement?: 'applied' | 'already_moved' | 'storage_error'
  /** storage_error 时节点在库里的真实状态；查不到写 unknown（S2/S3 round61 P2） */
  persisted_status?: string
}

/**
 * 派发期失败收口的结果。不要用布尔值：调用方必须能区分
 * 「已经收成 failed」「被别人接管了」「收口本身写库失败」三种情况。
 */
export type DispatchSettlement =
  | { kind: 'applied' }
  | { kind: 'already_moved'; currentStatus: string }
  | { kind: 'storage_error'; error: unknown; persistedStatus?: string }

/**
 * 宿主要不要重派：由派发结果本身决定，不让每个集成方各自理解（评审 P2-3）。
 * - never：节点已经落库或已被接管，重派只会盖掉事实；
 * - after_reread：写库失败但库里状态读到了，先重读确认仍是 queued 再重派；
 * - after_status_query：写库失败且状态未知，必须先独立查一次，绝不直接重派。
 */
export type DispatchRetry = 'never' | 'after_reread' | 'after_status_query'

export function retryDirective(outcome: Pick<DispatchOutcome, 'settlement' | 'persisted_status'>): DispatchRetry {
  if (outcome.settlement !== 'storage_error') return 'never'
  const persisted = outcome.persisted_status
  return persisted === undefined || persisted === 'unknown' ? 'after_status_query' : 'after_reread'
}

// 派发依赖 = 账本/运行时 + 执行器（可选）。
// 控制节点（wait / subworkflow）不需要宿主执行器：没装配执行器的进程也能推进它们；
// agent 节点才必须要有执行器，缺了就在派发前明确拒绝，不留下 dispatched 半截状态。
export type DispatchDeps = {
  db: Db
  secret: string
  runtime: RuntimeDeps
  // 装配层注入的「已经过调度」的执行函数；注入后 dispatcher 不再自己排一次队
  executeNode?: (p: RunNodeParams) => Promise<RunNodeResult>
  // 老装配（没有 scheduler）可以直接给完整执行器依赖，由 dispatcher 自己调 runNode
  executor?: RunNodeDeps
  // 控制节点（wait / subworkflow）要靠已加载的工作流目录固定子流程版本
  catalog?: WorkflowCatalog
  // 生产装配从配置读出的执行时限；缺省时由 runNode 使用默认值。
  executionLimits?: Pick<RunNodeParams, 'actionTimeoutMs' | 'startupTimeoutMs' | 'verifyTimeoutMs'>
}

// 只派发排队中的节点：一个节点失败不拖垮同批别的节点
// 依赖放行：定义里带了 edges 时，前置节点没到 done 的不派发（审计 P1-3）。
// 前置节点压根不在 run 里 = 配置错误（nodeIds 闭包被绕过/账本被改），必须可观测地失败，
// 不能无限期静默跳过（审计 P1 防御面）。
const SUCCESS_STATUS = new Set(['done', 'succeeded', 'succeeded_with_unverified'])
type Readiness = { ready: true } | { ready: false; missingPreds: string[] } | { ready: false; waitingPreds: string[] }
function readinessOf(db: DispatchDeps['db'], runId: string, nodeId: string, preds: ReadonlyMap<string, string[]>): Readiness {
  const missing: string[] = []
  const waiting: string[] = []
  for (const pred of preds.get(nodeId) ?? []) {
    const row = db.raw.prepare('SELECT status FROM node_runs WHERE run_id = ? AND node_id = ?').get(runId, pred) as { status: string } | undefined
    if (!row) missing.push(pred)
    else if (!SUCCESS_STATUS.has(row.status)) waiting.push(pred)
  }
  if (missing.length > 0) return { ready: false, missingPreds: missing }
  if (waiting.length > 0) return { ready: false, waitingPreds: waiting }
  return { ready: true }
}

export async function dispatchRun(deps: DispatchDeps, p: DispatchParams): Promise<DispatchOutcome[]> {
  const all = deps.db.raw.prepare(
    "SELECT node_run_id, node_id, seq, attempt FROM node_runs WHERE run_id = ? AND status = 'queued' ORDER BY seq ASC",
  ).all(p.runId) as { node_run_id: string; node_id: string; seq: number; attempt: number }[]
  // 有执行拓扑就按拓扑放行；旧定义没有 edges，保持原来的全量派发
  const preds = new Map<string, string[]>()
  const runRow = deps.db.raw.prepare('SELECT workflow_id, workflow_version FROM runs WHERE run_id = ?').get(p.runId) as
    { workflow_id: string; workflow_version: string } | undefined
  // 目录里没有这个版本就退回全量派发：老装配/直接插行的 run 没有已发布定义，
  // 依赖闸只在"定义带着拓扑"时才生效
  let def: { edges?: Array<{ from: string; to: string }> } | undefined
  if (runRow && deps.catalog) {
    try {
      def = deps.catalog.get(runRow.workflow_id, runRow.workflow_version)
    } catch {
      def = undefined
    }
  }
  for (const edge of def?.edges ?? []) {
    const list = preds.get(edge.to) ?? []
    list.push(edge.from)
    preds.set(edge.to, list)
  }
  const rows: typeof all = []
  for (const row of all) {
    const readiness = readinessOf(deps.db, p.runId, row.node_id, preds)
    if (readiness.ready) {
      rows.push(row)
      continue
    }
    if ('missingPreds' in readiness) {
      // 防御面：前置节点不在 run 里，收成失败留事件，别让 run 永远卡在 queued
      failQueuedNode(deps, p, row, '前置节点不在本 run 里：' + readiness.missingPreds.join(','), 'SCHEMA_VERSION_UNSUPPORTED')
    }
  }
  // 装配层给了执行函数，它已经带并发闸：同批节点可以一起排，谁先拿到名额谁先跑。
  // 没给执行函数（老装配/单测）时保持原来的串行次序，不凭空放并发。
  const outcomes = deps.executeNode
    ? await Promise.all(rows.map((row) => dispatchOne(deps, p, row)))
    : await (async () => {
        const out: DispatchOutcome[] = []
        for (const row of rows) out.push(await dispatchOne(deps, p, row))
        return out
      })()
  // 这一轮跑完后收口 run：所有子节点都已终态才写，未满足条件保持原状。
  inTx(deps.db, (tx) => { closeRun(tx, deps.secret, p.runId, p.now) })
  return outcomes
}

async function dispatchOne(
  deps: DispatchDeps,
  p: DispatchParams,
  row: { node_run_id: string; node_id: string; seq: number; attempt: number },
): Promise<DispatchOutcome> {
  // 取消与派发可能并发：选行之后、真正执行之前再查一次取消位，
  // 避免已取消的 run 因为节点还留在 queued 又被执行一次。
  const run = deps.db.raw.prepare('SELECT cancel_requested_at FROM runs WHERE run_id = ?').get(p.runId) as
    | { cancel_requested_at: string | null }
    | undefined
  if (run?.cancel_requested_at) {
    return { node_run_id: row.node_run_id, node_id: row.node_id, status: 'skipped', reason: 'run_cancelled' }
  }
  const spec = p.nodes[row.node_id]
  if (!spec) {
    return { node_run_id: row.node_run_id, node_id: row.node_id, status: 'skipped', reason: 'no_node_spec' }
  }
  // 控制节点配置只能来自已签名的工作流定义：请求体里带 control 一律拒绝，
  // 否则派发方可以把一个已发布的 subworkflow 节点改指到别的工作流版本。
  if ((spec as { control?: unknown }).control !== undefined) {
    const reason = '控制节点配置必须写在已签名的工作流定义里，请求体不能指定'
    const code = 'PAYLOAD_SCHEMA_INVALID'
    // 服务层也要保持状态一致：返回 failed 就必须把 queued 节点收成 failed 并留事件，
    // 不能只靠 HTTP 层拦请求——commands.dispatch 是可直接调用的服务接口（审计 P2-1）。
    return outcomeForSettlement(failQueuedNode(deps, p, row, reason, code), row, reason, code as DispatchOutcomeErrorCode)
  }
  let control: ControlNodeConfig | null
  try {
    control = resolveControlConfig(deps, p, row)
  } catch (err) {
    // 配置解析失败是这一行的确定性错误：留在 queued 会让 run 永远收不了口，直接按失败收口
    const reason = err instanceof Error ? err.message : String(err)
    const code = dispatchErrorCode(err)
    return outcomeForSettlement(failQueuedNode(deps, p, row, reason, code), row, reason, code as DispatchOutcomeErrorCode)
  }
  if (control) {
    return dispatchControlNode(deps, p, row, control)
  }
  // 一个节点失败不拖垮同批别的节点：异常在这里收成一条 failed 结果
  try {
    const params: RunNodeParams = {
      nodeRunId: row.node_run_id,
      nodeId: row.node_id,
      attempt: Number(row.attempt),
      input: spec.input ?? {},
      outputSchema: spec.outputSchema ?? {},
      tools: spec.tools,
      now: p.now,
      ownerEpoch: p.ownerEpoch ?? deps.db.epoch,
      leaseTtlMs: p.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      leaseRenewIntervalMs: p.leaseRenewIntervalMs,
      ...deps.executionLimits,
    }
    if (!deps.executeNode && !deps.executor) {
      // 直接调 dispatchRun 且没装执行器：与配置类错误一致，把 queued 收成 failed 并留事件，
      // 不能只返回失败让节点永远排队（S2 第 59 轮 P2-3）。
      const reason = '执行器没有装配，不能跑 agent 节点'
      return outcomeForSettlement(
        failQueuedNode(deps, p, row, reason, 'EVIDENCE_SOURCE_UNAVAILABLE'),
        row,
        reason,
        'EVIDENCE_SOURCE_UNAVAILABLE',
      )
    }
    const res = deps.executeNode
      ? await deps.executeNode(params)
      : await runNode(deps.executor!, params)
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: res.final_status === 'done' ? 'done' : 'failed',
      reason: res.final_status === 'done' ? undefined : 'final_status_' + res.final_status,
      agent_id: res.agent_id,
      evidence_source: res.evidence?.source,
    }
  } catch (err) {
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      error_code: dispatchErrorCode(err),
    }
  }
}

type ControlNodeConfig =
  | { kind: 'wait'; waitKind: WaitKind; match: WaitMatch; idempotencyKey: string; fromSeq?: number; maxWaitMs: number }
  | { kind: 'subworkflow'; workflowId: string; workflowVersion: number; resumeFrom: string | null }

type RunBinding = {
  workflow_id: string | null
  workflow_version: number | null
  workflow_definition_hash: string | null
}

/**
 * 派发前的确定性失败：把还留在 queued 的节点收成 failed。
 * 留成 queued 会让 run 永远等一个不会执行的节点（维护扫描也不碰 queued）。
 */
export function failQueuedNode(
  deps: Pick<DispatchDeps, 'db' | 'secret'>,
  p: DispatchParams,
  row: { node_run_id: string; attempt: number },
  reason: string,
  code: string,
): DispatchSettlement {
  try {
    return inTx(deps.db, (tx): DispatchSettlement => {
      applyTransition(tx, deps.secret, {
        nodeRunId: row.node_run_id,
        from: ['queued'],
        to: 'failed',
        // 派发期确定性错误走 liveness 的失败边，并显式点名，避免借控制节点的出口
        ruleId: 'M-48',
        attempt: row.attempt,
        now: p.now,
        context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
        patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 },
      })
      appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'dispatch.failed', {
        reason,
        error_code: code,
      })
      return { kind: 'applied' }
    })
  } catch (err) {
    // 先分清「被别人接管」和「写库失败」：前者不能覆盖，后者必须让调用方看见
    const current = currentStatusOf(deps, row.node_run_id)
    if (current !== null && current !== 'queued') return { kind: 'already_moved', currentStatus: current }
    return { kind: 'storage_error', error: err, persistedStatus: current === null ? 'unknown' : current }
  }
}

/** 把收口结果翻译成派发结果：applied→failed，already_moved→skipped，storage_error→显式失败 */
export function outcomeForSettlement(
  settlement: DispatchSettlement,
  row: { node_run_id: string; node_id: string },
  reason: string,
  code: DispatchOutcomeErrorCode,
): DispatchOutcome {
  if (settlement.kind === 'applied') {
    return { node_run_id: row.node_run_id, node_id: row.node_id, status: 'failed', reason, error_code: code, settlement: 'applied' }
  }
  if (settlement.kind === 'already_moved') {
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'skipped',
      reason: reason + '（节点已被并发流程接管，当前状态 ' + settlement.currentStatus + '）',
      error_code: code,
      current_status: settlement.currentStatus,
      settlement: 'already_moved',
    }
  }
  const detail = settlement.error instanceof Error ? settlement.error.message : String(settlement.error)
  return {
    node_run_id: row.node_run_id,
    node_id: row.node_id,
    status: 'failed',
    reason: '收口失败，节点状态保持不变：' + reason + '（' + detail + '）。重派前先查节点状态',
    error_code: 'DISPATCH_SETTLE_FAILED',
    settlement: 'storage_error',
    persisted_status: settlement.persistedStatus ?? 'unknown',
  }
}

function currentStatusOf(deps: Pick<DispatchDeps, 'db'>, nodeRunId: string): string | null {
  try {
    const row = deps.db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as
      | { status: string }
      | undefined
    return row?.status ?? null
  } catch {
    return null
  }
}

// 控制节点类型与数据库行上的 node_type 必须一一对应：
// 请求不能把 agent 节点变成控制节点，也不能把 parallel/decision 当成 wait 执行。
const CONTROL_KINDS: Record<string, 'wait' | 'subworkflow' | null> = {
  wait: 'wait',
  subworkflow: 'subworkflow',
  agent: null,
}

/**
 * 从 run 绑定的（workflow_id, workflow_version, definition_hash）重读定义，取出这个节点的控制配置。
 * 定义哈希也参与校验：目录里的定义被换过就不能继续派发。
 */
function resolveControlConfig(
  deps: DispatchDeps,
  p: DispatchParams,
  row: { node_run_id: string; node_id: string; attempt: number },
): ControlNodeConfig | null {
  const node = deps.db.raw.prepare('SELECT node_type FROM node_runs WHERE node_run_id = ?').get(row.node_run_id) as
    | { node_type: string }
    | undefined
  if (!node) {
    throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: row.node_run_id })
  }
  const nodeType = node.node_type
  const kind = CONTROL_KINDS[nodeType]
  if (kind === undefined) {
    // parallel / decision 目前只有状态机与用例，没有生产派发实现：
    // 明确拒绝并持久化失败，不能悄悄落进 agent 执行路径。
    const message = nodeType === 'parallel' || nodeType === 'decision'
      ? nodeType + ' 节点还没有执行实现，不能派发'
      : '未知节点类型，不能派发'
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', message, {
      nodeRunId: row.node_run_id,
      nodeType,
    })
  }
  const run = deps.db.raw.prepare(
    'SELECT workflow_id, workflow_version, workflow_definition_hash FROM runs WHERE run_id = ?',
  ).get(p.runId) as RunBinding | undefined
  const bound = Boolean(run?.workflow_id) && run?.workflow_version !== null
  if (!bound) {
    // 控制节点必须有绑定才能取到已签名配置；agent 节点仍走执行器自己的工具授权
    if (kind === null) return null
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'run 没有绑定工作流定义，控制节点不能派发', {
      runId: p.runId,
      nodeRunId: row.node_run_id,
    })
  }
  if (!deps.catalog) {
    if (kind === null) return null
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '控制节点缺少工作流目录，不能固定执行配置', {
      nodeRunId: row.node_run_id,
    })
  }
  // 控制节点的执行配置完全依赖签名定义：哈希为空说明这个 run 没有可校验的定义身份，
  // 不能靠“老数据兼容”把闸门静默放开，一律 fail closed。
  if (!run!.workflow_definition_hash) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'run 没有绑定定义哈希，控制节点不能派发', {
      runId: p.runId,
      nodeRunId: row.node_run_id,
      workflow_id: run!.workflow_id,
      workflow_version: run!.workflow_version,
    })
  }
  const def = deps.catalog.get(run!.workflow_id!, run!.workflow_version!)
  if (definitionHashOf(def) !== run!.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', 'run 绑定的定义哈希与目录不一致，不能派发', {
      runId: p.runId,
      workflow_id: run!.workflow_id,
      workflow_version: run!.workflow_version,
    })
  }
  const declared = def.nodes.find((item) => item.node_id === row.node_id)
  if (!declared) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在已签名的工作流定义里', {
      runId: p.runId,
      nodeId: row.node_id,
    })
  }
  // 库里的 node_type 也必须与定义一致：不能让改过行的节点被当成另一种类型执行
  if (declared.type !== nodeType) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点类型与已签名定义不一致', {
      nodeId: row.node_id,
      databaseType: nodeType,
      definitionType: declared.type,
    })
  }
  if (kind === null) return null
  if (kind === 'wait') {
    const cfg = declared.wait
    if (!cfg) {
      throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'wait 节点在定义里没有等待配置', { nodeId: row.node_id })
    }
    return {
      kind: 'wait',
      waitKind: cfg.wait_kind,
      match: cfg.match,
      // 幂等键由 run/node/attempt 派生：定义是共享的，键必须按实例唯一。
      idempotencyKey: `${p.runId}:${row.node_id}:${row.attempt}`,
      fromSeq: cfg.from_seq,
      maxWaitMs: cfg.max_wait_ms,
    }
  }
  const cfg = declared.subworkflow
  if (!cfg) {
    throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'subworkflow 节点在定义里没有目标工作流配置', { nodeId: row.node_id })
  }
  return {
    kind: 'subworkflow',
    workflowId: cfg.workflow_id,
    workflowVersion: cfg.pinned_version,
    resumeFrom: cfg.resume_from ?? null,
  }
}

// 控制节点只推进状态机：wait 进等待登记，subworkflow 建子运行并让父节点等待。
// 它们与 agent 节点共用 acquire/started 这两步，避免出现绕过租约与 Ga 的第二条入口。
async function dispatchControlNode(
  deps: DispatchDeps,
  p: DispatchParams,
  row: { node_run_id: string; node_id: string; seq: number; attempt: number },
  control: ControlNodeConfig,
): Promise<DispatchOutcome> {
  try {
    acquireNodeRun(deps.runtime, {
      nodeRunId: row.node_run_id,
      ownerEpoch: p.ownerEpoch ?? deps.db.epoch,
      leaseTtlMs: p.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      now: p.now,
    })
    const now = p.now
    if (control.kind === 'wait') {
      inTx(deps.db, (tx) => {
        tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE node_run_id = ?", [row.node_run_id])
        const current = loadNodeRun(tx, row.node_run_id)
        // 控制节点只走 applyTransition：transitionNode 是报告/执行器那条入口，不接受控制节点
        applyTransition(tx, deps.secret, {
          nodeRunId: row.node_run_id,
          from: ['dispatched'],
          to: 'started',
          attempt: current.attempt,
          expectedRevision: current.revision,
          now,
        })
        enterWaiting(tx, deps.secret, {
          nodeRunId: row.node_run_id,
          attempt: current.attempt,
          runId: current.run_id,
          waitKind: control.waitKind,
          match: control.match,
          idempotencyKey: control.idempotencyKey,
          fromSeq: control.fromSeq,
          maxWaitMs: control.maxWaitMs,
          now,
          clock: deps.runtime.clock,
        })
      })
      return { node_run_id: row.node_run_id, node_id: row.node_id, status: 'waiting', reason: 'wait_registered' }
    }
    if (!deps.catalog) {
      throw new Error('subworkflow 节点缺少工作流目录，不能固定子流程版本')
    }
    const child = inTx(deps.db, (tx) => {
      const current = loadNodeRun(tx, row.node_run_id)
      applyTransition(tx, deps.secret, {
        nodeRunId: row.node_run_id,
        from: ['dispatched'],
        to: 'started',
        attempt: current.attempt,
        expectedRevision: current.revision,
        now,
      })
      // 父节点的副作用等级由 startSubworkflowNode 按子图静态下界写入，不能在这里写死 pure。
      return startSubworkflowNode(tx, deps.secret, deps.catalog!, {
        nodeRunId: row.node_run_id,
        attempt: current.attempt,
        workflowId: control.workflowId,
        workflowVersion: control.workflowVersion,
        resumeFrom: control.resumeFrom,
        now,
      })
    })
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'waiting',
      reason: 'child_run:' + child.run_id,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const code = dispatchErrorCode(err)
    // 初始化失败必须把已经拿到的租约与 dispatched 状态一起收干净：
    // 只返回 failed 而不改库，会留下“API 说失败、节点还 dispatched 且持租约”的分叉，
    // closeRun 也永远等不到终态（审计 P2-2）。
    return outcomeForSettlement(failControlDispatch(deps, p, row, reason, code), row, reason, code as DispatchOutcomeErrorCode)
  }
}

/**
 * 控制节点初始化失败的收口：按当前 revision 做 CAS，清租约与执行器绑定，落 dispatch.failed 事件。
 * 返回是否真的把这一行收成终态；并发已改走的行不覆盖别人的结论。
 */
export function failControlDispatch(
  deps: Pick<DispatchDeps, 'db' | 'secret'>,
  p: { now: string },
  row: { node_run_id: string; node_id: string; attempt: number },
  reason: string,
  code: string,
): DispatchSettlement {
  try {
    return inTx(deps.db, (tx): DispatchSettlement => {
      const current = loadNodeRun(tx, row.node_run_id)
      if (!['leased', 'dispatched', 'started'].includes(current.status)) {
        return { kind: 'already_moved', currentStatus: current.status }
      }
      applyTransition(tx, deps.secret, {
        nodeRunId: row.node_run_id,
        from: ['leased', 'dispatched', 'started'],
        to: 'failed',
        // 派发期初始化失败走 liveness 的失败边，显式点名，不借控制节点出口
        ruleId: 'M-48',
        attempt: current.attempt,
        expectedRevision: current.revision,
        now: p.now,
        patch: {
          lease_id: null,
          lease_expires_at: null,
          executor_session_id: null,
          executor_agent_id: null,
          wait_started_at: null,
          // 控制节点在派发期没有执行任何工具：副作用事实是「零副作用、无需核实」，
          // 不能让 run 终态误报成 failed_with_unverified（S3 第 11 轮 P2-1）。
          side_effect_policy: 'pure',
          side_effect_verified_none: 1,
        },
        context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
      })
      appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'dispatch.failed', { reason, error_code: code })
      return { kind: 'applied' }
    })
  } catch (err) {
    const current = currentStatusOf(deps, row.node_run_id)
    if (current !== null && !['leased', 'dispatched', 'started'].includes(current)) {
      return { kind: 'already_moved', currentStatus: current }
    }
    return { kind: 'storage_error', error: err, persistedStatus: current === null ? 'unknown' : current }
  }
}
