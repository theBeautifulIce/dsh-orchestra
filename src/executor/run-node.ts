import { resolvePinnedNodeId } from '../service/rework-extra-steps.ts'
// src/executor/run-node.ts —— 单节点执行主链（规格 5.2 行 442-449）
// 生产路径的顺序固定：租约 → 建执行器 → 上报 started → 只读工具出强证据 → 核命令哈希 → 进 verifying → 上报 done。
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../core/errors.ts'
import { completionBlockReason, readExecutionCompletion } from '../core/execution-completion.ts'
import type { Report } from '../core/report.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { makeTx, withTx } from '../infra/sqlite/driver.ts'
import { transitionNode, DEFAULT_VERIFY_TIMEOUT_MS } from '../service/commands/node-state.ts'
import { appendEvent, appendNodeRunEvent } from '../infra/db/ledger.ts'
import { loadNodeRun, releaseLease, type NodeRunRow } from '../service/commands/lease.ts'
import { applyTransition } from '../service/commands/nodes.ts'
import { acquireNodeRun, renewNodeLease, submitReport, type RuntimeDeps } from '../service/commands/runtime.ts'
import { buildInstruction, checkToolPolicy, createExecutorAgent, type HostAgentFactory, type ToolPolicy } from './session.ts'
import { assertToolsAuthorized, type ReadOnlyToolRunner, type StrongEvidence, type ToolRegistry } from './tools.ts'
import type { BridgeClient } from './bridge.ts'
import { AgentLifecycle, type AgentReportEnvelope } from './agent-lifecycle.ts'
import { canTransition } from '../core/state-machine.ts'
import type { ClockProvider } from '../core/clock.ts'
import { MODEL_COMPLEXITIES, MODEL_REF_RE, selectExecutionModel, type ModelAssignment, type ModelProfile, type ModelRouting } from './model-routing.ts'
import { requireTrialFlow } from '../service/trial-circles.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import { getTaskPlanRecommendation } from '../service/task-planning.ts'
import { approvedModelProfiles, effectiveModelCatalog, readModelRoutingSettings } from '../service/model-routing-settings.ts'
import { executionFeedbackContext } from '../service/rework-execution.ts'
import { noteAgentStopped, type createModelEscalationHost } from '../service/model-escalation.ts'
import { RELEASE_CHECK_WORKFLOW_ID } from '../core/wf-release-v1.ts'
import type { createRunSharedContext } from '../service/run-shared-context.ts'
import { groupStopIntent, isVerifiedParallelMembership, verifiedPropagatedGroupStop } from '../service/workflow-parallel.ts'
import { recordOrdinaryHostStop, recordOrdinaryUnsentAttempt } from '../service/decision/ordinary-recovery.ts'
import { applyObservedReport } from '../service/commands/apply-report.ts'
import { superviseOrdinaryAttempt } from './ordinary-supervision.ts'

export type RunNodeParams = {
  /** Internal dispatcher entry. The standalone runner rechecks the persisted node kind and definition. */
  standaloneTool?: true
  /** The scheduler derives this from the persisted workflow and node identity at admission. */
  workflowHelperLimit?: number
  /** Controlled by the dedicated release entrypoint. */
  releaseCheckCwd?: string
  nodeRunId: string
  nodeId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  // 这一轮要跑的只读命令；每条都要落强证据
  tools: { command: string; args: string[]; cwd: string; timeoutMs: number }[]
  now: string
  ownerEpoch: number
  leaseTtlMs: number
  // 执行期心跳间隔；不传就用 10 秒（规格 4.3 行 309-310；门记录 G2.md 的本批定值）
  leaseRenewIntervalMs?: number
  // verifying 阶段的判定时限；不传就用 120 秒（规格 4.4 行 333）
  verifyTimeoutMs?: number
  // 动作总时限；不传就用 120 秒（规格 execution.action_timeout_ms；第五轮审计 P2-1）
  actionTimeoutMs?: number
  // 宿主建会话的上限；不传就用 30 秒。spawn 挂住时不能把节点永远留在 dispatched。
  startupTimeoutMs?: number
  // startup_unknown 的 unknown_watchdog 预算；不传就用 120 秒
  unknownWatchdogMs?: number
}

// 租约 30 秒、心跳 10 秒：与门记录 G2.md 的本批定值一致（第四轮审计 M4）
export const DEFAULT_LEASE_TTL_MS = 30_000
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000
export const DEFAULT_ACTION_TIMEOUT_MS = 120_000
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const STOP_RPC_TIMEOUT_MS = 2_000

export type RunNodeResult = {
  node_run_id: string
  final_status: string
  evidence: StrongEvidence | null
  agent_id: string
  reason?: string
}

export type RunNodeDeps = {
  runtime: RuntimeDeps
  db: Db
  secret: string
  registry: ToolRegistry
  agents: HostAgentFactory
  runner: ReadOnlyToolRunner
  // 生产路径必须走桥：spawn 由 agents 负责，事件流、工具回传、取消/释放都由这里持有
  bridge: BridgeClient
  // 未确认事件的落盘目录；同 node_run+agent+attempt 的文件前缀彼此隔离
  spillDir?: string
  // 外部取消信号：只用于把取消请求送进当前 attempt，不改变账本状态
  cancelSignal?: AbortSignal
  /** Trusted host routing. Incoming execution requests cannot set a model. */
  modelRouting?: ModelRouting
  modelEscalation?: Pick<ReturnType<typeof createModelEscalationHost>, 'prepare' | 'select'>
  sharedContext?: ReturnType<typeof createRunSharedContext>
}

export async function runNode(deps: RunNodeDeps, p: RunNodeParams): Promise<RunNodeResult> {
  if (deps.cancelSignal?.aborted) {
    throw new OrchError('SERVICE_UNAVAILABLE', '节点执行已被取消', { nodeRunId: p.nodeRunId, attempt: p.attempt })
  }
  // 工具策略只从服务端加载过的定义取：请求体给什么不算数（第五轮审计 P1-2）
  const policy = policyForNodeRun(deps, p)
  if (policy.allow?.includes(RELEASE_CHECK_WORKFLOW_ID) && !p.releaseCheckCwd) {
    throw new OrchError('FORBIDDEN', '发布检查工具只能由已授权的隔离发布运行调用')
  }
  // 前向路径只接只读工具；有副作用的动作走补偿或不可逆流程（规格 4.7 行 396）
  const derived = checkToolPolicy(deps.registry, policy)
  if (derived !== 'pure') {
    throw new OrchError('FORBIDDEN', '前向路径只接只读工具', { derived })
  }
  // 授权边界：真正要跑的工具必须落在定义给的授权集合里，deny 永远优先（规格 5.2 行 444-445；第四轮审计 M2）
  assertToolsAuthorized(deps.registry, policy, p.tools)
  const leaseTtlMs = p.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const lease = acquireNodeRun(deps.runtime, {
    nodeRunId: p.nodeRunId,
    ownerEpoch: p.ownerEpoch,
    leaseTtlMs,
    now: p.now,
  })
  // 执行期心跳：动作比租约长时把租约往后推，合法动作不许被扫描判成租约过期（规格 4.3 行 309-310；第四轮审计 M4）
  const nowAt = startElapsedClock(deps, p.now)
  // 续租失败不再空吞：留一条 lease_lost 事件，动作结束前按租约丢失收口（第五轮审计 P2-1）
  const leaseState: { lost: string | null; allowRenew?: () => boolean } = { lost: null }
  const renewTimer = setInterval(() => {
    try {
      if (leaseState.allowRenew?.() === false) return
      renewNodeLease(deps.runtime, { nodeRunId: p.nodeRunId, leaseTtlMs, now: nowAt() })
    } catch (err) {
      const code = err instanceof OrchError ? err.code : 'SERVICE_UNAVAILABLE'
      leaseState.lost = code
      try {
        withTx(deps.db, (tx) => {
          appendNodeRunEvent(tx, deps.secret, p.nodeRunId, 'lease_lost', { attempt: p.attempt, reason: code })
        })
      } catch {
        // 账本也写不进去时保留 lost 标记，收口会拦住 done
      }
    }
  }, p.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS)
  renewTimer.unref?.()
  try {
    return await runNodeActions(deps, p, lease, nowAt, policy, leaseState)
  } finally {
    clearInterval(renewTimer)
  }
}

// 只有“宿主明确拒绝且没有建会话”的码才落 blocked_pre。
// 回包缺 agentId 的 PROTOCOL_VERSION_MISMATCH 不能算明确失败：宿主可能已经建了会话。
const DETERMINISTIC_SPAWN_FAILURES: ReadonlySet<string> = new Set([
  'FORBIDDEN',
  'TOOL_NOT_ALLOWED',
  'TOOL_NOT_REGISTERED',
  'RUN_TOOL_NOT_READ_ONLY',
  'VERIFIER_TOOL_POLICY_MUTATING',
  'PAYLOAD_SCHEMA_INVALID',
])

function isDeterministicSpawnFailure(err: unknown): boolean {
  return err instanceof OrchError && DETERMINISTIC_SPAWN_FAILURES.has(err.code)
}

// 启动阶段的超时：spawn 可能永远不回来，不能让 runNode 无界等待（复审 P1 残留）。
function withTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => OrchError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(onTimeout()) }, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([task, expired]).finally(() => { if (timer) clearTimeout(timer) })
}

// 从 node_run 反查 run 绑定的工作流版本，再取该节点定义里的工具清单
function policyForNodeRun(deps: RunNodeDeps, p: RunNodeParams): ToolPolicy {
  const row = deps.db.raw.prepare(
    'SELECT n.node_id AS node_id, r.workflow_id AS workflow_id, r.workflow_version AS workflow_version, r.workflow_definition_hash AS workflow_definition_hash FROM node_runs n JOIN runs r ON r.run_id = n.run_id WHERE n.node_run_id = ?',
  ).get(p.nodeRunId) as { node_id: string; workflow_id?: string | null; workflow_version?: number | null; workflow_definition_hash?: string | null } | undefined
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: p.nodeRunId })
  requireTrialFlow(makeTx(deps.db.raw), row.workflow_id, row.workflow_definition_hash)
  // 节点身份以账本为准：调用方传别的 nodeId 不许借到另一份工具授权
  if (row.node_id !== p.nodeId) {
    throw new OrchError('STALE_GENERATION', 'node_id 与账本不一致，不许借别的节点授权', { nodeRunId: p.nodeRunId, ledgerNodeId: row.node_id, requestedNodeId: p.nodeId })
  }
  if (row.workflow_version === null || row.workflow_version === undefined) {
    throw new OrchError('VERDICT_UNSUPPORTED', '这个 run 没有绑定工作流版本', { nodeRunId: p.nodeRunId })
  }
  const workflowId = row.workflow_id ?? 'default'
  if (row.workflow_definition_hash === null || row.workflow_definition_hash === undefined) {
    throw new OrchError('VERDICT_UNSUPPORTED', '这个 run 没有绑定工作流定义哈希', { nodeRunId: p.nodeRunId })
  }
  // 与收口同一条口径：取工具授权前先复核 run 绑定的定义哈希，重启后同版本换内容不能改变可调用工具
  const currentHash = deps.runtime.catalog.definitionHash(workflowId, row.workflow_version)
  if (currentHash !== row.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', 'run 绑定的工作流定义与当前版本不一致，执行期工具授权不许中途换', {
      nodeRunId: p.nodeRunId,
      workflow_id: workflowId,
      workflow_version: String(row.workflow_version),
      bound: row.workflow_definition_hash,
      current: currentHash,
    })
  }
  // 旧 run 的 workflow_id 为空，归到 default 命名空间；新 run 必须按自己的 workflow_id 取工具授权
  const def = deps.runtime.catalog.toolPolicyFor(workflowId, row.workflow_version, resolvePinnedNodeId(makeTx(deps.db.raw), p.nodeRunId))
  return { allow: def.allow, deny: def.deny, declaredPolicy: 'pure' }
}

// 动作主体：建执行器 → 事件驱动工具 → 等结构化报告 → 收口。心跳定时器在所有出口都被清掉。
async function runNodeActions(
  deps: RunNodeDeps,
  p: RunNodeParams,
  lease: { lease_id: string; action_generation: number },
  nowAt: () => string,
  policy: ToolPolicy,
  leaseState: { lost: string | null; allowRenew?: () => boolean },
): Promise<RunNodeResult> {
  const generation = lease.action_generation
  const actionTimeoutMs = p.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
  let agent: Awaited<ReturnType<typeof createExecutorAgent>> | null = null
  let lifecycle: AgentLifecycle | null = null
  let stopped = false
  let evidence: StrongEvidence | null = null
  let failed: unknown = null
  let spawnUnknown = false
  let spawnRejected = false
  let stopFailure: unknown = null
  let assignment: ModelAssignment | undefined
  let usageRecorded = false
  const saveModelUse = (use: NonNullable<AgentReportEnvelope['modelUse']>) => {
    if (usageRecorded) return
    const selected = assignment
    if (!selected || use.model_ref !== selected.model_ref
      || (selected.provider !== undefined && use.provider !== selected.provider)
      || (selected.model !== undefined && use.model !== selected.model)
      || (typeof selected.reasoning_effort === 'string' && use.reasoning_effort !== selected.reasoning_effort)) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', '宿主的实际模型回执与派发模型不一致')
    }
    const { model_ref: _ref, ...usage } = use
    withTx(deps.db, (tx) => {
      const row = loadNodeRun(tx, p.nodeRunId)
      if (row.attempt !== p.attempt || row.action_generation !== generation) {
        throw new OrchError('STALE_GENERATION', '执行模型回执已过期')
      }
      recordModel(tx, deps.secret, row, { ...selected, usage }, 'confirmed', 'executor.model_used')
    })
    usageRecorded = true
  }
  try {
    // spawn 回包失败时也可能已经在宿主建了会话；放进 try，外层 catch 至少能 markBlocked，
    // finally 再按 agentId 做有界释放，不能把节点留在 dispatched。
    let spawnTask: Promise<Awaited<ReturnType<typeof createExecutorAgent>>> | null = null
    try {
      if (deps.modelRouting) {
        try {
          await deps.modelRouting.refresh?.(deps.cancelSignal)
          deps.cancelSignal?.throwIfAborted()
          await deps.modelEscalation?.prepare(p.nodeRunId, generation, nowAt())
          deps.cancelSignal?.throwIfAborted()
          assignment = chooseModelForAttempt(deps, p, generation, deps.modelRouting, nowAt())
        } catch (error) {
          if (deps.cancelSignal?.aborted) throw new OrchError('SERVICE_UNAVAILABLE', '节点执行已被取消')
          if (error instanceof OrchError) throw error
          throw new OrchError('FORBIDDEN', '当前节点无法取得可信的模型分配建议')
        }
      }
      if (deps.runtime.phase === 'S6') {
        const row = loadNodeRun(makeTx(deps.db.raw), p.nodeRunId)
        deps.cancelSignal?.throwIfAborted()
        if (row.status !== 'dispatched' || row.attempt !== p.attempt || row.action_generation !== generation
          || row.lease_id !== lease.lease_id || row.hang_reason !== null) {
          throw new OrchError('STALE_GENERATION', '当前执行尝试已不可创建宿主会话')
        }
      }
      spawnTask = createExecutorAgent(deps.agents, deps.registry, {
        nodeRunId: p.nodeRunId,
        attempt: p.attempt,
        input: p.input,
        outputSchema: p.outputSchema,
        toolPolicy: p.releaseCheckCwd ? { ...policy, releaseCheckCwd: p.releaseCheckCwd }
          : { ...policy, workflowHelperLimit: p.workflowHelperLimit },
        modelRef: assignment?.model_ref,
        sessionModelFallback: assignment?.session_model_fallback,
        reasoningEffort: assignment?.reasoning_effort,
        ...(deps.modelRouting || deps.runtime.phase === 'S6' ? { actionGeneration: generation } : {}),
      })
      agent = await withTimeout(
        spawnTask,
        p.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        () => new OrchError('OPERATION_TIMEOUT', 'Agent 启动超过上限', {
          nodeRunId: p.nodeRunId, attempt: p.attempt, startupTimeoutMs: p.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        }),
      )
    } catch (err) {
      // 宿主明确拒绝（4xx 类错误）：没有副作用，落 blocked_pre，不冒充“启动结果未知”。
      // 超时/传输错误才可能是“会话已建但回包丢了”，落 startup_unknown 交人工核。
      if (!spawnTask || isDeterministicSpawnFailure(err)) {
        withTx(deps.db, (tx) => {
          const row = loadNodeRun(tx, p.nodeRunId)
          if (row.attempt !== p.attempt || row.action_generation !== generation) return
          if (!spawnTask && finishParallelAgentStop(tx, deps, row, p, generation, nowAt(), true)) return
          if (!spawnTask && deps.cancelSignal?.aborted && row.status === 'timing_out'
            && row.fence_state === 'armed' && row.side_effect_policy === 'pure') {
            // The bridge was never called. No stop acknowledgement is needed or fabricated.
            const stoppedAt = nowAt()
            applyTransition(tx, deps.secret, {
              nodeRunId: row.node_run_id, from: ['timing_out'], to: 'timeout', ruleId: 'M-24',
              attempt: row.attempt, actionGeneration: generation, expectedRevision: row.revision, now: stoppedAt,
              patch: { fence_state: null, fence_grace_until: null, fence_grace_boot_id: null, fence_grace_monotonic_ns: null, fence_remaining_ns: null },
            })
            releaseLease(tx, { nodeRunId: row.node_run_id, now: stoppedAt })
          } else if (row.status === 'dispatched') {
            const now = nowAt()
            const reason = spawnTask ? 'agent_spawn_rejected' : deps.cancelSignal?.aborted ? 'pre_spawn_cancelled' : 'model_assignment_unavailable'
            transitionNode(tx, deps.secret, {
              nodeRunId: p.nodeRunId, from: 'dispatched', to: 'blocked_pre',
              attempt: row.attempt, revision: row.revision, now, reason, actionGeneration: generation,
              verifyHuman: { reason, missing: [] },
            })
            if (!spawnTask) releaseLease(tx, { nodeRunId: row.node_run_id, now })
          }
        })
        spawnRejected = true
        throw err
      }
      // spawn 回包失败时宿主可能已经建了会话，但我们拿不到 agentId：不能声称已停，
      // 也不能留在 dispatched。按规格落 startup_unknown，交给 sweep/人工核副作用。
      const unknownRearm = withTx(deps.db, (tx) => {
        const row = loadNodeRun(tx, p.nodeRunId)
        if (row.status === 'dispatched' && row.attempt === p.attempt && row.action_generation === generation) {
          transitionNode(tx, deps.secret, {
            nodeRunId: p.nodeRunId, from: 'dispatched', to: 'startup_unknown',
            attempt: row.attempt, revision: row.revision, now: nowAt(), reason: 'agent_spawn_unknown',
            unknownWatchdogMs: p.unknownWatchdogMs,
            startupUnknownAnchor: deps.runtime.clock?.sample(),
          })
          return row.rearm_generation
        }
        return undefined
      })
      spawnUnknown = true
      // 超时后底层 spawn 仍可能晚到；晚到的会话必须被释放，不能变成无人认领的孤儿。
      if (spawnTask) {
        void spawnTask.then(async (late) => {
          if (deps.runtime.phase === 'S6' && unknownRearm !== undefined && !deps.cancelSignal?.aborted) {
            const binding = { nodeRunId: p.nodeRunId, attempt: p.attempt, actionGeneration: generation, executorAgentId: late.agentId }
            const retired = await withTimeout(deps.bridge.retireUnsentAttempt(binding), STOP_RPC_TIMEOUT_MS, () =>
              new OrchError('OPERATION_TIMEOUT', '未发送请求的宿主会话停止确认超时'))
            if (retired) {
              if (!deps.cancelSignal?.aborted) withTx(deps.db, (tx) =>
                recordOrdinaryUnsentAttempt(tx, deps.secret, binding, unknownRearm, nowAt()))
              return
            }
          }
          await bestEffortReleaseAgent(deps, late.agentId, p.nodeRunId, p.attempt)
        }).catch(() => {
          // A lost response or closed database cannot establish an authoritative receipt.
        })
      }
      throw err
    }
    const created = agent
    if (assignment && (created.effectiveModelRef !== assignment.model_ref
      || (assignment.reasoning_effort !== undefined && created.effectiveReasoningEffort !== assignment.reasoning_effort))) {
      const selected = assignment
      withTx(deps.db, (tx) => {
        const row = loadNodeRun(tx, p.nodeRunId)
        if (row.status !== 'dispatched' || row.attempt !== p.attempt || row.action_generation !== generation) return
        recordModel(tx, deps.secret, row, selected, 'rejected')
        transitionNode(tx, deps.secret, { nodeRunId: row.node_run_id, from: 'dispatched', to: 'blocked_pre',
          attempt: row.attempt, revision: row.revision, now: nowAt(), reason: 'model_assignment_unconfirmed',
          verifyHuman: { reason: 'model_assignment_unconfirmed', missing: [] } })
      })
      spawnRejected = true
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', '宿主未确认指定模型或思考设置，执行请求未发送')
    }
    // started 是状态迁移不是完成上报：没过证据门的上报不该用来推进状态
    withTx(deps.db, (tx) => {
      const row = loadNodeRun(tx, p.nodeRunId)
      const startedAt = nowAt()
      if (assignment) {
        if (row.attempt !== p.attempt || row.action_generation !== generation) throw new OrchError('STALE_GENERATION', '执行模型确认已过期')
        recordModel(tx, deps.secret, row, assignment, 'confirmed')
      }
      transitionNode(tx, deps.secret, {
        nodeRunId: p.nodeRunId, from: 'dispatched', to: 'started',
        attempt: row.attempt, revision: row.revision, now: startedAt, reason: 'executor_started',
      })
      if (deps.runtime.phase === 'S6') {
        tx.run('UPDATE node_runs SET executor_session_id=?, executor_agent_id=? WHERE node_run_id=?',
          [created.sessionId, created.agentId, p.nodeRunId])
      }
      if (deps.modelEscalation) tx.run('UPDATE node_runs SET started_at=? WHERE node_run_id=?', [startedAt, p.nodeRunId])
    })
    const feedback = ['S5','S6'].includes(deps.runtime.phase)
      ? executionFeedbackContext(deps.db, deps.runtime.catalog, p.nodeRunId, nowAt(), p.input, deps.secret) : null
    const sharedContext = await deps.sharedContext?.(p.nodeRunId, p.nodeId, feedback?.inputs ?? [])
    deps.cancelSignal?.throwIfAborted()
    const supervision = deps.runtime.phase === 'S6' && deps.runtime.clock && !p.releaseCheckCwd ? superviseOrdinaryAttempt({
      db: deps.db, secret: deps.secret, clock: deps.runtime.clock, bridge: deps.bridge, nowAt, timeoutMs: actionTimeoutMs,
      leaseId: lease.lease_id, ownerEpoch: p.ownerEpoch, unknownWatchdogMs: p.unknownWatchdogMs ?? 120_000,
      binding: { nodeRunId: p.nodeRunId, attempt: p.attempt, actionGeneration: generation,
        executorAgentId: created.agentId, executorSessionId: created.sessionId },
      signal: deps.cancelSignal,
    }) : undefined
    lifecycle = new AgentLifecycle({
      db: deps.db,
      secret: deps.secret,
      client: deps.bridge,
      registry: deps.registry,
      runner: deps.runner,
      policy,
      allowedTools: p.tools.map((tool) => tool.command),
      nodeRunId: p.nodeRunId,
      attempt: p.attempt,
      agent,
      lease,
      instruction: nodeInstruction(p, feedback, sharedContext),
      timeoutMs: actionTimeoutMs,
      supervision,
      idleTimeoutMs: 5_000,
      onStopModelUse: saveModelUse,
      nowAt,
      clock: deps.runtime.clock,
      spillDir: deps.spillDir ?? join(tmpdir(), 'dsh-orchestra-bridge'),
    })
    if (supervision) leaseState.allowRenew = () => !lifecycle?.hasMonitor || supervision.mayUseTools()
    const envelope = await lifecycle.run(deps.cancelSignal ?? new AbortController().signal)
    const late = lifecycle.hasMonitor ? supervision?.lateStatus() : undefined
    if (typeof assignment?.reasoning_effort === 'string' && !envelope.modelUse) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', '宿主未提供指定思考深度的实际请求回执')
    }
    if (envelope.modelUse) saveModelUse(envelope.modelUse)
    // 取消请求可能刚好落在报告与收口之间：此时不能再把 done 写进账本。
    if (deps.cancelSignal?.aborted) {
      throw new OrchError('SERVICE_UNAVAILABLE', '节点执行已被取消', { nodeRunId: p.nodeRunId, attempt: p.attempt })
    }
    const trace = lifecycle.trace
    evidence = (envelope.evidence as StrongEvidence | null) ?? null
    // 停止确认必须在任何状态收口之前：stop 失败时节点还在 started，能落 blocked_post；
    // 若先 submitReport 到 done，done 没有出边，stop 失败就只能留下“账本 done、Agent 未停”的矛盾。
    try {
      await lifecycle.stop()
      stopped = true
      if (deps.runtime.phase === 'S6') withTx(deps.db, (tx) => recordOrdinaryHostStop(tx, deps.secret, {
        nodeRunId: p.nodeRunId, attempt: p.attempt, generation, agentId: created.agentId, stoppedAt: nowAt(),
      }))
      if (deps.modelEscalation) withTx(deps.db, (tx) => noteAgentStopped(tx, deps.secret, loadNodeRun(tx, p.nodeRunId), p.attempt, generation))
    } catch (stopErr) {
      stopFailure = stopErr
      throw stopErr
    }

    if (late && envelope.bridgeSeq !== undefined) {
      const report = reportFromAgent(p, envelope.report, evidence, trace, true)
      const applied = withTx(deps.db, (tx) => applyObservedReport(tx, deps.secret, {
        nodeRunId: p.nodeRunId, attempt: p.attempt, report, expectedStatus: late.status, generation, now: nowAt(),
      }, deps.runtime.catalog, {
        executorAgentId: created.agentId, executorSessionId: created.sessionId, rearmGeneration: late.rearmGeneration, bridgeSeq: envelope.bridgeSeq!,
      }, p.tools.length === 0 && trace.length === 0 && evidence === null))
      if (!applied.accepted) throw new OrchError('VERDICT_POLICY_UNMET', '观察到的原尝试报告未通过结算', { reason: applied.reason })
      return { node_run_id: p.nodeRunId, final_status: applied.next_status ?? 'unknown', evidence, agent_id: created.agentId }
    }

    // 续租失败过：动作已经失去合法租约，不许再进 verifying 收口（第五轮审计 P2-1）
    if (leaseState.lost) {
      markBlocked(deps, p, 'lease_lost', nowAt())
      throw new OrchError('LEASE_EXPIRED', '执行期续租失败，节点按租约丢失收口', { nodeRunId: p.nodeRunId, reason: leaseState.lost })
    }

    // 系统级判失败：任一工具 exitCode≠0 就中断后续工具，节点不许落 done（审计 R3-01）
    const failedTool = trace.find((t) => t.exitCode !== 0)
    if (failedTool) {
      markBlocked(deps, p, 'tool_execution_failed', nowAt())
      throw new OrchError('VERDICT_POLICY_UNMET', '节点没过判定条件：工具 exitCode 不是 0，收口被拒', {
        nodeRunId: p.nodeRunId,
        tool: failedTool.tool,
        exit_code: failedTool.exitCode,
      })
    }

    // Agent 的报告只提供 output；evidence 必须来自宿主执行器，evidence_trace 由宿主回填
    const report = reportFromAgent(p, envelope.report, evidence, trace)
    withTx(deps.db, (tx) => {
      const row = loadNodeRun(tx, p.nodeRunId)
      transitionNode(tx, deps.secret, {
        nodeRunId: p.nodeRunId,
        from: 'started',
        to: 'verifying',
        attempt: row.attempt,
        revision: row.revision,
        now: nowAt(),
        reason: 'work_submitted',
        verifyTimeoutMs: p.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        // 判定锚点：墙钟只作展示，判定只读 boot_id 与单调纳秒（规格 3.4 行 171）
        verifyAnchor: deps.runtime.clock ? anchorOf(deps.runtime.clock, nowAt()) : undefined,
      })
    })

    const applied = submitReport(deps.runtime, {
      nodeRunId: p.nodeRunId,
      attempt: p.attempt,
      report,
      expectedStatus: 'verifying',
      generation,
      now: nowAt(),
    }, deps.runtime.phase === 'S6' && p.tools.length === 0 && trace.length === 0 && evidence === null)
    if (!applied.accepted) {
      // 收口被拒：转 blocked_post 并留 verify_human，等人补证据或判失败，不许留 verifying 死等
      markBlocked(deps, p, applied.reason ?? 'verdict_unmet', nowAt())
      throw new OrchError('VERDICT_POLICY_UNMET', '节点没过判定条件，收口被拒', {
        nodeRunId: p.nodeRunId,
        reason: applied.reason,
        registry_state: applied.registry_state,
      })
    }
    return { node_run_id: p.nodeRunId, final_status: applied.next_status ?? 'unknown', evidence, agent_id: created.agentId }
  } catch (err) {
    failed = err
    // spawn 结果未知已经落 startup_unknown；再走 blocked_post 会把“副作用未知”误写成“已确认阻断”。
    // 外部取消已经由 cancel 路径落 timing_out/stopping；这里再写 blocked_post 会撞状态机或改错归属。
    if (!spawnUnknown && !spawnRejected && !deps.cancelSignal?.aborted) {
      const reason = stopFailure !== null
        ? 'agent_stop_unconfirmed'
        : err instanceof OrchError && err.code === 'OPERATION_TIMEOUT' ? 'action_timeout' : 'agent_execution_failed'
      const completion = err instanceof OrchError && err.details.execution_completion
        ? readExecutionCompletion({ output: { completion: err.details.execution_completion } }) : undefined
      markBlocked(deps, p, completion && completion.outcome !== 'completed' ? completionBlockReason(completion) : reason,
        nowAt(), completion?.missing)
    }
    throw err
  } finally {
    if (lifecycle) {
      if (!stopped) {
        try {
          await lifecycle.stop()
          stopped = true
          if (deps.runtime.phase === 'S6' && agent) {
            const agentId = agent.agentId
            withTx(deps.db, (tx) => recordOrdinaryHostStop(tx, deps.secret, {
              nodeRunId: p.nodeRunId, attempt: p.attempt, generation, agentId, stoppedAt: nowAt(),
            }))
          }
          if (deps.modelEscalation) withTx(deps.db, (tx) => noteAgentStopped(tx, deps.secret, loadNodeRun(tx, p.nodeRunId), p.attempt, generation))
        } catch (stopErr) {
          if (failed === null) {
            markBlocked(deps, p, 'agent_stop_unconfirmed', nowAt())
            throw stopErr
          }
        }
      }
      if (stopped && (deps.modelEscalation || deps.cancelSignal?.aborted)) {
        withTx(deps.db, (tx) => {
          const row = loadNodeRun(tx, p.nodeRunId)
          if (row.attempt !== p.attempt || row.action_generation !== generation) return
          if (finishParallelAgentStop(tx, deps, row, p, generation, nowAt(), false)) return
          // Only the confirmed stop of this pure attempt can clear its interruption fence.
          if (deps.cancelSignal?.aborted && row.status === 'timing_out' && row.fence_state === 'armed' && row.side_effect_policy === 'pure') {
            const stoppedAt = nowAt()
            if (!deps.modelEscalation) noteAgentStopped(tx, deps.secret, row, p.attempt, generation)
            applyTransition(tx, deps.secret, {
              nodeRunId: row.node_run_id, from: ['timing_out'], to: 'timeout', ruleId: 'M-24',
              attempt: row.attempt, actionGeneration: generation, expectedRevision: row.revision, now: stoppedAt,
              patch: { fence_state: null, fence_grace_until: null, fence_grace_boot_id: null, fence_grace_monotonic_ns: null, fence_remaining_ns: null },
            })
            releaseLease(tx, { nodeRunId: p.nodeRunId, now: stoppedAt })
          } else if (deps.modelEscalation && row.lease_id && ['done','blocked_post','failed','timeout'].includes(row.status)) {
            releaseLease(tx, { nodeRunId: p.nodeRunId, now: nowAt() })
          }
        })
      }
    } else if (agent) {
      // lifecycle 还没建起来就失败时，Agent 可能已经 spawn；按 agentId 做一次有界兜底释放。
      await bestEffortReleaseAgent(deps, agent.agentId, p.nodeRunId, p.attempt)
    }
  }
}

function finishParallelAgentStop(tx: Tx, deps: RunNodeDeps, row: NodeRunRow, p: RunNodeParams, generation: number, now: string, neverLaunched: boolean): boolean {
  const reason = deps.cancelSignal?.reason
  if (typeof reason !== 'string' || !reason.startsWith('parallel-group:') || row.side_effect_policy === 'irreversible') return false
  const groupId = reason.slice('parallel-group:'.length)
  const stop = groupStopIntent(tx, row.node_run_id, groupId)
  if (!stop) return false
  if (stop.member_id && stop.child_run_id && row.status === 'stopping'
      && verifiedPropagatedGroupStop(tx, deps.secret, groupId, row.run_id, stop.member_id, stop.child_run_id)) {
    const pure = row.side_effect_policy === 'pure' || neverLaunched
    applyTransition(tx, deps.secret, { nodeRunId: row.node_run_id, from: ['stopping'], to: pure ? 'failed' : 'indeterminate_side_effect',
      ruleId: pure ? 'M-48' : 'M-35', attempt: p.attempt, actionGeneration: generation, now,
      patch: pure ? { side_effect_policy: 'pure', side_effect_verified_none: 1 } : {},
    })
    appendNodeRunEvent(tx, deps.secret, row.node_run_id, pure ? 'parallel.member_cancelled' : 'parallel.member_stop_unverified',
      { group_id: groupId, member_id: stop.member_id, reason: 'host_stopped' })
    releaseLease(tx, { nodeRunId: row.node_run_id, now })
    return true
  }
  if (row.parent_node_run_id !== groupId || !['dispatched','started','verifying'].includes(row.status)
      || !isVerifiedParallelMembership(tx, deps.secret, groupId, row.node_run_id)) return false
  const from = row.status as 'dispatched' | 'started' | 'verifying'
  if (row.side_effect_policy !== 'pure' && !neverLaunched) {
    if (from === 'verifying') return false
    applyTransition(tx, deps.secret, { nodeRunId: row.node_run_id, from: [from], to: 'indeterminate_side_effect', ruleId: 'M-30',
      attempt: p.attempt, actionGeneration: generation, now,
      context: { hasToolCall: true, cancelResult: 'already_stopped', hangReason: null, sideEffectVerifiedNone: false },
    })
    appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'parallel.member_stop_unverified', { group_id: groupId, reason: 'host_stopped' })
    releaseLease(tx, { nodeRunId: row.node_run_id, now })
    return true
  }
  applyTransition(tx, deps.secret, { nodeRunId: row.node_run_id, from: [from], to: 'timing_out', ruleId: 'M-23',
    attempt: p.attempt, actionGeneration: generation, now,
    context: { hasToolCall: false, cancelResult: 'interrupted', hangReason: null, sideEffectVerifiedNone: true },
  })
  applyTransition(tx, deps.secret, { nodeRunId: row.node_run_id, from: ['timing_out'], to: 'timeout', ruleId: 'M-24',
    attempt: p.attempt, actionGeneration: generation, now, patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 } })
  appendNodeRunEvent(tx, deps.secret, row.node_run_id, 'parallel.member_cancelled', { group_id: groupId, reason: 'host_stopped', from, to: 'timeout' })
  releaseLease(tx, { nodeRunId: row.node_run_id, now })
  return true
}

function chooseModelForAttempt(deps: RunNodeDeps, p: RunNodeParams, generation: number, routing: ModelRouting, now: string): ModelAssignment {
  return withTx(deps.db, (tx) => {
    const row = loadNodeRun(tx, p.nodeRunId)
    if (row.status !== 'dispatched' || row.attempt !== p.attempt || row.action_generation !== generation) {
      throw new OrchError('STALE_GENERATION', '模型分配对应的执行尝试已失效')
    }
    const selected = resolveModelAssignment(tx, deps.db, row, routing, (profiles, base) =>
      deps.modelEscalation?.select(tx, row, profiles, base, now) ?? base)
    recordModel(tx, deps.secret, row, selected, 'selected')
    return selected
  })
}

export function resolveModelAssignment(tx: Tx, db: Db, row: NodeRunRow, routing: ModelRouting,
  escalate?: (profiles: readonly ModelProfile[], assignment: ModelAssignment) => ModelAssignment): ModelAssignment {
  const run = tx.get<{ task_id: string; workflow_id: string | null; workflow_version: string | null }>(
    'SELECT task_id, workflow_id, CAST(workflow_version AS TEXT) AS workflow_version FROM runs WHERE run_id = ?', [row.run_id],
  )
  if (!run) throw new OrchError('NOT_FOUND', '模型分配找不到对应运行')
  const context = { taskId: run.task_id, runId: row.run_id, nodeId: resolvePinnedNodeId(tx, row.node_run_id), nodeRunId: row.node_run_id,
    attempt: row.attempt, actionGeneration: row.action_generation, workflowId: run.workflow_id, workflowVersion: run.workflow_version }
  const proposed = getTaskPlanRecommendation(db, context) ?? routing.recommend(context)
  const settings = readModelRoutingSettings(tx)
  const catalog = routing.catalog?.()
  const effective = effectiveModelCatalog(catalog?.profiles ?? routing.profiles, settings)
  const profiles = approvedModelProfiles(effective)
  const preferred = settings.mapping[proposed.complexity]
  const capacity = MODEL_COMPLEXITIES.indexOf(proposed.complexity)
  const adequate = profiles.filter((profile) => MODEL_COMPLEXITIES.indexOf(profile.capacity) >= capacity)
  if (preferred && !adequate.some(({ ref }) => ref === preferred)) {
    throw new OrchError('FORBIDDEN', '指定模型已从 DSH 目录移除或能力不足，请重新读取并更新子智能体模型分配')
  }
  const recommended = !catalog || adequate.some(({ ref }) => ref === proposed.preferredModel) ? proposed.preferredModel : undefined
  const session = effective.find(({ ref }) => ref === catalog?.session_execution_model_ref)
  let assignment: ModelAssignment
  if (!preferred && adequate.length === 0 && capacity >= 0 && capacity <= MODEL_COMPLEXITIES.indexOf('advanced')
    && session?.capacity === null && session.provider && session.model && MODEL_REF_RE.test(session.ref)) {
    const reason = typeof proposed.reason === 'string' ? proposed.reason.trim() : ''
    if (reason.length === 0 || reason.length > 240) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑的模型建议缺少合法复杂度或依据')
    }
    const fallback = '暂无满足该节点档位的模型，自动沿用当前 DSH 会话已授权的执行模型。该模型能力未评估。'
    assignment = { model_ref: session.ref, complexity: proposed.complexity, session_model_fallback: true,
      reason: fallback + ' 规划依据：' + reason.slice(0, 240 - fallback.length - ' 规划依据：'.length) }
  } else {
    assignment = selectExecutionModel(profiles, { ...proposed, preferredModel: preferred ?? recommended })
  }
  if (preferred) assignment.settings_revision = settings.revision
  const selected = escalate?.(profiles, assignment) ?? assignment
  const tierEffort = selected.model_ref === preferred ? settings.reasoning_efforts[proposed.complexity] : undefined
  const modelEffort = settings.model_reasoning_defaults.find(({ ref }) => ref === selected.model_ref)?.effort
  const effort = tierEffort ?? modelEffort
  if (catalog || effort != null) {
    const profile = effective.find(({ ref }) => ref === selected.model_ref)
    if (effort != null && !profile?.reasoning?.efforts.some(({ id }) => id === effort)) {
      throw new OrchError('FORBIDDEN', '指定思考深度已从 DSH 模型目录移除，请重新读取并更新子智能体模型分配')
    }
    if (profile?.provider && profile.model) {
      selected.provider = profile.provider
      selected.model = profile.model
    }
    if (effort != null) selected.settings_revision = settings.revision
    selected.reasoning_effort = effort ?? null
  }
  return selected
}

function recordModel(tx: Tx, secret: string, row: ReturnType<typeof loadNodeRun>, assignment: ModelAssignment,
  state: 'selected' | 'confirmed' | 'rejected', type = `executor.model_${state}`): void {
  const payload = { ...assignment, state, attempt: row.attempt, action_generation: row.action_generation }
  appendNodeRunEvent(tx, secret, row.node_run_id, type, payload)
  appendEvent(tx, { type, runId: row.run_id, nodeRunId: row.node_run_id, payload: { state } })
}

// 建 Agent 成功、lifecycle 尚未建立就失败：不能把宿主会话留成孤儿。
// 只做有界清理；确认不了停止就保留，不把原始错误盖掉。
async function bestEffortReleaseAgent(deps: RunNodeDeps, agentId: string, nodeRunId: string, attempt: number): Promise<void> {
  const bounded = <T>(task: Promise<T>, method: string): Promise<T> => withTimeout(
    task,
    STOP_RPC_TIMEOUT_MS,
    () => new OrchError('OPERATION_TIMEOUT', `Agent 释放确认超时：${method}`, { agentId, method }),
  )
  try {
    await bounded(deps.bridge.cancel({ executorAgentId: agentId, attempt }), 'cancel')
  } catch {
    // 取消不可用也继续查状态
  }
  let idle: { idle: boolean; timedOut: boolean } | null = null
  try {
    idle = await bounded(deps.bridge.whenIdle({ executorAgentId: agentId, timeoutMs: 1_000 }), 'whenIdle')
  } catch {
    idle = null
  }
  let state: { state: string; toolCallSeq: number; hasToolCall: boolean } | null = null
  try {
    state = await bounded(deps.bridge.state({ executorAgentId: agentId }), 'state')
  } catch {
    state = null
  }
  const idleOk = idle?.idle === true
  const stateOk = state?.state === 'idle' || state?.state === 'unloaded' || state?.state === 'deleted'
  if (!idleOk || !stateOk) return
  // 不能拿 0/0 绕过 ACK 滞后保护：按本 attempt 的已处理位与已落账最大桥序号真实取值。
  // 若桥事件位仍领先确认位，dispose 会被 BRIDGE_ACK_LAG 拒绝，这正是我们要保留的语义。
  try {
    const ack = deps.db.raw.prepare(
      'SELECT last_handled_seq AS n FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get(nodeRunId, attempt, agentId) as { n: number } | undefined
    const last = deps.db.raw.prepare(
      'SELECT COALESCE(MAX(bridge_seq), 0) AS n FROM bridge_event_receipts WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get(nodeRunId, attempt, agentId) as { n: number } | undefined
    await bounded(deps.bridge.dispose({
      executorAgentId: agentId,
      serviceAckSeq: Number(ack?.n ?? 0),
      bridgeLastSeq: Number(last?.n ?? 0),
    }), 'dispose')
  } catch {
    // 清理是尽力而为：ACK 滞后、桥不可用或查询失败时保留会话，且不覆盖节点上的原始错误
  }
}

// 发给 Agent 的任务文本只描述节点与输出约束；完成与否仍由服务端收口。
function nodeInstruction(p: RunNodeParams, feedback: ReturnType<typeof executionFeedbackContext> | null, sharedContext?: string): string {
  return [
    buildInstruction({ nodeId: p.nodeId, outputSchema: p.outputSchema }),
    // 指令里只列本次节点真正允许的清单，避免把 Agent 引向随后必被拒绝的工具。
    '可用只读工具：' + p.tools.map((tool) => tool.command).join(', '),
    '节点输入：' + JSON.stringify(p.input ?? null),
    ...(feedback ? [
      '本次运行的成果与修订上下文：' + JSON.stringify(feedback),
      '宿主提供 orchestra_rework 时可读取 inputs 中的成果。交付文本请用 publish 登记。revision 要求先读取原成果，按保留要求修订同名文件。review 要求核对候选版本，取得本次执行证据并完成验收后再提交报告。plan_instruction 是本次获批的局部修订要求。工具权限以宿主为准。',
    ] : []),
    ...(sharedContext ? [sharedContext] : []),
  ].join('\n')
}

// Agent 的 report 只许是结构化 done；evidence 与 trace 由宿主覆盖，Agent 自报不算数。
function reportFromAgent(
  p: RunNodeParams,
  raw: unknown,
  evidence: StrongEvidence | null,
  trace: { tool: string; toolSeq: number; executionId: string; exitCode: number; stdoutHash: string; stderrHash: string; commandHash: string }[],
  allowObservedFailure = false,
): Report {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'Agent 报告必须是结构化对象', {})
  }
  const report = raw as Record<string, unknown>
  const completion = readExecutionCompletion(report)
  const observedFailure = allowObservedFailure && report.status === 'failed'
    && completion !== undefined && completion.outcome !== 'completed'
  if (completion && completion.outcome !== 'completed' && !observedFailure) {
    throw new OrchError('VERDICT_POLICY_UNMET', '执行未完成，已保留原因和下一步', { execution_completion: completion })
  }
  if (report.status !== 'done' && !observedFailure) {
    throw new OrchError('VERDICT_POLICY_UNMET', 'Agent 没有提交 done 报告，节点不收口', { status: report.status })
  }
  const output = report.output !== null && typeof report.output === 'object' && !Array.isArray(report.output)
    ? { ...(report.output as Record<string, unknown>), evidence_trace: trace }
    : { evidence_trace: trace }
  return reportOf(p, observedFailure ? 'failed' : 'done', evidence, output)
}

// 执行期时刻：以调用方给的时刻为基准，按单调钟往前推；墙钟跳变不该影响租约与时长判断（规格 3.4 行 171）
function startElapsedClock(deps: RunNodeDeps, base: string): () => string {
  const clock = deps.runtime.clock
  const baseMs = Date.parse(base)
  if (!clock || !Number.isFinite(baseMs)) return () => base
  const startNs = clock.sample().monotonicNs
  return () => {
    // 整秒推进：毫秒级抖动会让门证据每次重跑都变字节，证据就不可复算（同 N1 的教训）
    const elapsedSec = Math.max(0, Math.floor((clock.sample().monotonicNs - startNs) / 1e9))
    // 基时刻的毫秒位保持原样，只按整秒往前推，账本时刻不重新对齐墙钟零点
    return new Date(baseMs + elapsedSec * 1000).toISOString()
  }
}

// 判定锚点：取一次时钟采样，墙钟给展示用，单调纳秒给判定用（规格 3.4 行 171）
function anchorOf(clock: ClockProvider, now: string): { bootId: string; monotonicNs: number; wallClockMs: number } {
  const sample = clock.sample()
  return { bootId: sample.bootId, monotonicNs: sample.monotonicNs, wallClockMs: Date.parse(now) }
}

// 失败或证据不足：从当前非终态落到 blocked_post，并留一条 verify_human 说明为什么卡住
function markBlocked(deps: RunNodeDeps, p: RunNodeParams, reason: string, now: string, missing: string[] = []): void {
  try {
    withTx(deps.db, (tx) => {
      const row = loadNodeRun(tx, p.nodeRunId)
      if (!canTransition(row.status, 'blocked_post')) return
      transitionNode(tx, deps.secret, {
        nodeRunId: p.nodeRunId,
        from: row.status,
        to: 'blocked_post',
        attempt: row.attempt,
        revision: row.revision,
        now,
        reason: 'executor_blocked',
        verifyHuman: { reason, missing },
      })
    })
  } catch {
    // 已经被取消或别的流程改过状态：保留原错抛出，不把第二层错误盖上去
  }
}

function reportOf(p: RunNodeParams, status: 'started' | 'done' | 'failed', evidence?: StrongEvidence | null, output?: unknown): Report {
  return {
    // 同一次执行里各状态报告的 id 固定可推，重放时也对得上
    report_id: 'rep_' + p.nodeRunId + '_' + String(p.attempt) + '_' + status,
    node_run_id: p.nodeRunId,
    attempt: p.attempt,
    status,
    ...(evidence ? { evidence: { ...evidence } } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}
