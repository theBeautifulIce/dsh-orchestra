// src/service/dispatcher.ts —— 主脑派发：把 run 下排队的节点交给生产执行器（审计 F-01）
// 评审 P1：agent 执行是长时间任务，不许占着写队列的名额；并发闸由装配层统一注入。
// 调度器不再由 dispatcher 自己持有：否则 /v1/node-runs/run 与 /v1/runs/dispatch 各走一套，
// 或者同一次 runNode 被调度两次、重复占用名额（S2 第三十七轮 P0-01）。
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
import { OrchError } from '../core/errors.ts'

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

export type DispatchOutcome = {
  node_run_id: string
  node_id: string
  status: 'done' | 'failed' | 'skipped' | 'waiting'
  reason?: string
  error_code?: string
  agent_id?: string
  evidence_source?: string
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
export async function dispatchRun(deps: DispatchDeps, p: DispatchParams): Promise<DispatchOutcome[]> {
  const rows = deps.db.raw.prepare(
    "SELECT node_run_id, node_id, seq, attempt FROM node_runs WHERE run_id = ? AND status = 'queued' ORDER BY seq ASC",
  ).all(p.runId) as { node_run_id: string; node_id: string; seq: number; attempt: number }[]
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
  inTx(deps.db, (tx) => { closeRun(tx, p.runId, p.now) })
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
    const settled = failQueuedNode(deps, p, row, reason, code)
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'failed',
      reason: settled ? reason : reason + '（节点已被并发流程接管，未覆盖其状态）',
      error_code: code,
    }
  }
  let control: ControlNodeConfig | null
  try {
    control = resolveControlConfig(deps, p, row)
  } catch (err) {
    // 配置解析失败是这一行的确定性错误：留在 queued 会让 run 永远收不了口，直接按失败收口
    const reason = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string }).code ?? ''
    failQueuedNode(deps, p, row, reason, code)
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'failed',
      reason,
      error_code: code,
    }
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
    const res = deps.executeNode
      ? await deps.executeNode(params)
      : deps.executor
        ? await runNode(deps.executor, params)
        : (() => {
            throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑 agent 节点', {
              nodeRunId: row.node_run_id,
            })
          })()
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
      error_code: (err as { code?: string }).code ?? '',
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
function failQueuedNode(
  deps: DispatchDeps,
  p: DispatchParams,
  row: { node_run_id: string; attempt: number },
  reason: string,
  code: string,
): boolean {
  try {
    return inTx(deps.db, (tx) => {
      applyTransition(tx, {
        nodeRunId: row.node_run_id,
        from: ['queued'],
        to: 'failed',
        // 派发期确定性错误走 liveness 的失败边，并显式点名，避免借控制节点的出口
        ruleId: 'M-48',
        attempt: row.attempt,
        now: p.now,
        context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
      })
      appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'dispatch.failed', {
        reason,
        error_code: code,
      })
      return true
    })
  } catch {
    // 并发已把这一行改走：保持原状，不覆盖别人的结论
    return false
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
        applyTransition(tx, {
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
      applyTransition(tx, {
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
    const code = (err as { code?: string }).code ?? ''
    // 初始化失败必须把已经拿到的租约与 dispatched 状态一起收干净：
    // 只返回 failed 而不改库，会留下“API 说失败、节点还 dispatched 且持租约”的分叉，
    // closeRun 也永远等不到终态（审计 P2-2）。
    const settled = failControlDispatch(deps, p, row, reason, code)
    return {
      node_run_id: row.node_run_id,
      node_id: row.node_id,
      status: 'failed',
      reason: settled ? reason : reason + '（状态收口失败，已留给维护扫描）',
      error_code: code,
    }
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
): boolean {
  try {
    return inTx(deps.db, (tx) => {
      const current = loadNodeRun(tx, row.node_run_id)
      if (!['leased', 'dispatched', 'started'].includes(current.status)) return false
      applyTransition(tx, {
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
        },
        context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
      })
      appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'dispatch.failed', { reason, error_code: code })
      return true
    })
  } catch {
    // 并发已把这一行改走：不覆盖别人的结论，留给维护扫描
    return false
  }
}
