// src/index.ts —— DSH 插件入口 + 生产装配（规格 12.5 行 1088-1092）
import { existsSync } from 'node:fs'
import { OrchError } from './core/errors.ts'
import { openDb, type Db } from './infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from './infra/db/migrate.ts'
import { bumpEpoch, openServiceDb } from './infra/db/open.ts'
import { acquireDbLock } from './infra/lock.ts'
import { nullLogger, type Logger } from './infra/logger.ts'
import { WorkflowCatalog } from './service/workflows.ts'
import { createRun, reserveTask } from './service/runs.ts'
import { createWorkflowCommand, openDraftCommand, updateDraftCommand, publishWorkflowCommand, publishContextFor, getWorkflow as getWorkflowSummary, listWorkflows as listWorkflowSummaries } from './service/commands/workflows.ts'
import { requireCapability } from './core/config.ts'
import { startRun } from './service/commands/start-run.ts'
import { resolveDecision } from './service/commands/decisions.ts'
import { resolveEffect } from './service/commands/effects.ts'
import { resumeFromBlockedPre } from './service/commands/nodes.ts'
import { confirmStartup } from './service/commands/confirm-start.ts'
import { dispatchRun } from './service/dispatcher.ts'
import { closeRun } from './service/commands/run-close.ts'
import { settleCompensation, startCompensation } from './service/commands/compensation.ts'
import { wakeOnEvent } from './service/commands/wait.ts'
import { propagateRunCancellation } from './service/commands/subworkflow.ts'
import { resolveRecoveryUncertain } from './service/commands/recovery.ts'
import { listRecoveryUncertain } from './service/queries/recovery.ts'
import { listTaskSummaries, getTaskSummarySnapshot } from './service/queries/tasks.ts'
import { listRuns, getRun } from './service/queries/runs.ts'
import { listNodes, getNodeSnapshot } from './service/queries/nodes.ts'
import { getArtifactSnapshot } from './service/queries/artifacts.ts'
import { getAttestationSnapshot } from './service/queries/attestations.ts'
import { getDecisionSnapshot, listDecisions } from './service/queries/decisions.ts'
import { getEvidenceSnapshot } from './service/queries/evidence.ts'
import { verifyLedgerSnapshot } from './service/queries/verify_ledger.ts'
import { getWorkflowSnapshot, getWorkflowVersionSnapshot, listWorkflowSummaries as listWorkflowQuery } from './service/queries/workflows.ts'
import { listUnverifiedEffects } from './service/queries/effects.ts'
import { listEvents as listEventPage } from './service/queries/list_events.ts'
import { getOperationSnapshot } from './service/queries/get_operation.ts'
import { inTx } from './infra/db/tx.ts'
import type { NodeCommands, ServerDeps } from './service/server.ts'
import { startServer } from './service/server.ts'
import {
  acquireNodeRun, renewNodeLease, submitCancel, submitReport, sweepNow, type RuntimeDeps,
} from './service/commands/runtime.ts'
import type { Phase } from './core/config.ts'
import type { CancelResult } from './service/commands/cancel.ts'
import {
  runNode, DEFAULT_LEASE_TTL_MS,
  type RunNodeDeps, type RunNodeParams, type RunNodeResult,
} from './executor/run-node.ts'
import { bridgeHostAgentFactory } from './executor/bridge.ts'
import type { HostAgentFactory } from './executor/session.ts'
import { ExecutionCancels } from './service/execution-cancels.ts'
import {
  createExecutionScheduler, createExecutionSchedulerFromConfig, runThroughScheduler, type ExecutionScheduler,
} from './service/execution-scheduler.ts'
import { loadConfig } from './core/config.ts'
import { SystemClock } from './core/clock.ts'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-orchestra'
export const version = '0.1.0'

export type OrchestraOptions = {
  dbFile: string
  secret: string
  phase: Phase
  log?: Logger
  // 生产执行器：装配了就开 /v1/node-runs/run，没装配时该路由明确报未配置（审计 F-01）
  // agents 省略时由 bridge.spawn 兜底，生产路径不靠外部顺手塞一个宿主工厂。
  executor?: Omit<RunNodeDeps, 'runtime' | 'db' | 'secret' | 'agents'> & { agents?: HostAgentFactory }
  // 执行并发闸：agent 执行是长时间任务，不占写队列的名额，并发上限在这里生效（第二次意见 P1）
  scheduler?: ExecutionScheduler
  // 生产装配读配置的路径；读不到就退回默认并发（并发 3、人工名额 1）
  configPath?: string
  // 桥未确认事件的落盘目录；不传则读配置 bridge.spill_dir，再退回临时目录
  spillDir?: string
}

export type Orchestra = {
  db: Db
  runtime: RuntimeDeps
  catalog: WorkflowCatalog
  commands: NodeCommands
  // 执行中取消的进程内注册表：账本记取消事实，这里把 AbortSignal 送到对应的 runNode
  cancels: ExecutionCancels
  close: () => void
}

// 只有走完取锁与 epoch 自增的启动链才许可建装配：单写者是启动前提，不是可选装饰（第五轮审计 P1-3）
// run 终态集合：取消接口只在这些状态下回报 terminalStatus（S1 第 59 轮 P2-4）

// 生产派发真正实现了的节点类型：parallel / decision 只有状态机与测试，允许发布会让 run 起不来（审计 P1-4）
const RUNTIME_NODE_TYPES: ReadonlySet<string> = new Set(['agent', 'subworkflow', 'wait'])
const RUN_TERMINAL = new Set(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled'])

const ORCHESTRA_LOCK_PROOF = Symbol('orchestra-lock-proof')
// 生产装配：一个进程一个写者，迁移在打开时跑完，命令统一走 runtime
// 外部只能走 openServiceOrchestra；直接调用拿不到凭证（第五轮审计 P1-3）
export function createOrchestra(opts: OrchestraOptions & { db?: Db }, proof?: symbol): Orchestra {
  if (proof !== ORCHESTRA_LOCK_PROOF) {
    throw new OrchError('FORBIDDEN', '建 orchestra 必须走 openServiceOrchestra：单写者锁与 epoch 是启动前提', {})
  }
  const db = opts.db ?? openDb(opts.dbFile)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  const catalog = new WorkflowCatalog(opts.phase, db)
  // 定义落库是跨重启的事实来源：不先把已签发的版本装回内存，重启后同版本会被当成新定义（第六轮审计 P1-1）
  catalog.hydrate()
  // 生产时钟：墙钟与单调钟同时取样，漂移超过 2 秒就判不确定（规格 3.4 行 171）
  const clock = new SystemClock(randomUUID())
  const runtime: RuntimeDeps = { db, secret: opts.secret, phase: opts.phase, catalog, clock }
  const executor = opts.executor
  const spillDir = executor?.spillDir ?? opts.spillDir ?? bridgeSpillDirFromConfig(opts.configPath)
  // 执行时限同样只能来自配置：不把 action_timeout_ms / startup_timeout_ms / verify_timeout_ms
  // 读进来，配置写了也不生效（复审 P2-1）。读不到就交给 runNode 的默认值。
  const executionLimits = executionLimitsFromConfig(opts.configPath)
  const agents = executor ? (executor.agents ?? bridgeHostAgentFactory(executor.bridge)) : null
  const cancels = new ExecutionCancels()
  const executorDeps: RunNodeDeps | null = executor && agents
    ? { runtime, db, secret: opts.secret, ...executor, agents, ...(spillDir ? { spillDir } : {}) }
    : null
  // 节点执行只有一个底层实现；调度只在装配层包一次（S2 第三十七轮 P0-01）。
  const executeNode = async (p: RunNodeParams): Promise<RunNodeResult> => {
    if (!executorDeps) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑节点', { nodeRunId: p.nodeRunId })
    }
    const signal = cancels.register(p.nodeRunId, p.attempt)
    try {
      return await runNode({ ...executorDeps, cancelSignal: signal }, p)
    } finally {
      cancels.release(p.nodeRunId, p.attempt)
    }
  }
  // 两条入口（/v1/runs/dispatch 与 /v1/node-runs/run）共用这一个带闸函数：
  // 不允许 dispatcher 自己再排一次，否则同一次执行会重复占两个并发名额。
  const executeScheduled = (p: RunNodeParams): Promise<RunNodeResult> =>
    runThroughScheduler(opts.scheduler, () => executeNode(p), { label: p.nodeId })
  const commands: NodeCommands = {
    listRecoveryUncertain: () => listRecoveryUncertain(db),
    resolveRecoveryUncertain: (b) => inTx(db, (tx) => resolveRecoveryUncertain(tx, opts.secret, b)),
    acquireLease: (b) => acquireNodeRun(runtime, b),
    renewLease: (b) => renewNodeLease(runtime, b),
    report: (b) => submitReport(runtime, b as Parameters<typeof submitReport>[1]),
    cancel: (b) => {
      const out = submitCancel(runtime, { ...b, cancelResult: b.cancelResult as CancelResult })
      // 账本先落取消事实，再把停止请求送到正在跑的那个 attempt；
      // 已停的节点没有在跑实例，不打断任何东西。
      if (out.cancel_result !== 'already_stopped') {
        cancels.abort(b.nodeRunId, b.attempt, `cancel:${out.cancel_result}`)
      }
      return out
    },
    loadWorkflow: (body) => catalog.load(body as Parameters<WorkflowCatalog['load']>[0]),
    // S4：四个写命令都收 operation_id，业务与回执同笔；actor 由路由层的认证主体传入
    createWorkflow: (b) => inTx(db, (tx) => createWorkflowCommand(tx, {
      workflowId: b.workflowId, name: b.name, definition: b.definition, scope: b.scope,
      ownerTaskId: b.ownerTaskId, actor: b.actor, now: b.now, operationId: b.operationId,
    })),
    openWorkflowDraft: (b) => inTx(db, (tx) => openDraftCommand(tx, {
      workflowId: b.workflowId, baseVersion: b.baseVersion, actor: b.actor, now: b.now, operationId: b.operationId,
    })),
    updateWorkflowDraft: (b) => inTx(db, (tx) => updateDraftCommand(tx, {
      workflowId: b.workflowId, revision: b.revision, definition: b.definition,
      actor: b.actor, now: b.now, operationId: b.operationId,
    })),
    // 发布从 S4 起才许（规格 2.4）：闸门装在命令装配层，HTTP 与内部调用都绕不过
    publishWorkflow: (b) => {
      requireCapability(opts.phase, 'workflow_publish')
      const out = inTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: b.workflowId, revision: b.revision, baseVersion: b.baseVersion, note: b.note,
      actor: b.actor, now: b.now, operationId: b.operationId,
    }, publishContextFor(tx, RUNTIME_NODE_TYPES)))
      // 发布成功 = 当前进程立即可跑：目录同步注册，哈希不符会当场抛（审计 P1-1）
      catalog.adopt(out.definition, out.definition_hash)
      return out
    },
    reserveTask: (b) => reserveTask(db, { title: b.title, actor: b.actor, now: b.now, operationId: b.operationId }),
    getWorkflow: (b) => inTx(db, (tx) => getWorkflowSummary(tx, b.workflowId)),
    listWorkflows: (b) => inTx(db, (tx) => listWorkflowSummaries(tx, { ownerTaskId: b.ownerTaskId })),
    createRun: (b) => createRun(db, catalog, {
      taskTitle: b.taskTitle,
      workflowId: b.workflowId,
      workflowVersion: b.workflowVersion,
      nodeIds: b.nodeIds,
      now: b.now,
    }),
    startRun: (b) => startRun(db, catalog, {
      taskId: b.taskId,
      taskTitle: b.taskTitle,
      workflowId: b.workflowId,
      workflowVersion: b.workflowVersion,
      nodeIds: b.nodeIds,
      autonomy: b.autonomy,
      escalations: b.escalations,
      operationId: b.operationId,
      now: b.now,
    }),
    resolveDecision: (b) => inTx(db, (tx) => {
      const out = resolveDecision(tx, opts.secret, {
        decisionId: b.decisionId,
        revision: b.revision,
        resolution: b.resolution,
        payload: b.payload,
        actor: b.actor,
        evidenceProducers: b.evidenceProducers,
        confirm: b.confirm,
        contentHash: b.contentHash,
        now: b.now,
      })
      // 生产入口必须把审批结论落回节点：批准回 queued，拒绝/过期落 failed。
      // 两步在同一事务里，不会出现“卡已 resolved、节点还卡在 blocked_pre”。
      if (out.blockedNode && (out.closedReason === 'approved' || out.closedReason === 'rejected' || out.closedReason === 'expired_final')) {
        resumeFromBlockedPre(tx, opts.secret, {
          nodeRunId: out.blockedNode.nodeRunId,
          attempt: out.blockedNode.attempt,
          decisionId: out.decisionId,
          approved: out.closedReason === 'approved',
          contentHash: b.contentHash ?? null,
          now: b.now,
        })
        if (out.closedReason !== 'approved') closeRun(tx, opts.secret, out.runId, b.now)
      }
      return out
    }),
    resolveEffect: (b) => inTx(db, (tx) => resolveEffect(tx, opts.secret, {
      basis: b.basis,
      nodeRunId: b.nodeRunId,
      runId: b.runId ?? null,
      evidenceId: b.evidenceId ?? null,
      decisionId: b.decisionId ?? null,
      stopEvidence: b.stopEvidence ?? null,
      evidenceSource: b.evidenceSource ?? null,
      expected: {
        revision: b.expected.revision,
        decisionRevision: b.expected.decisionRevision ?? null,
      },
      operationId: b.operationId,
      actor: b.actor,
      now: b.now,
    })),
    confirmStart: (b) => confirmStartup(db, opts.secret, { ...b, clock }),
    startCompensation: (b) => inTx(db, (tx) => startCompensation(tx, opts.secret, {
      nodeRunId: b.nodeRunId,
      attempt: b.attempt,
      descriptor: b.descriptor,
      now: b.now,
    })),
    settleCompensation: (b) => inTx(db, (tx) => ({
      settled: settleCompensation(tx, opts.secret, {
        compensationId: b.compensationId,
        state: b.state,
        evidence: b.evidence,
        reason: b.reason,
        now: b.now,
      }),
    })),
    wakeOnEvent: (b) => inTx(db, (tx) => wakeOnEvent(tx, opts.secret, {
      runId: b.runId,
      eventType: b.eventType,
      payload: b.payload,
      idempotencyKey: b.idempotencyKey ?? null,
      now: b.now,
    })),
    cancelRun: (b) => inTx(db, (tx) => {
      const out = propagateRunCancellation(tx, opts.secret, {
        runId: b.runId,
        cancelResult: b.cancelResult as CancelResult,
        graceMs: b.graceMs,
        extendDeadlineMs: b.extendDeadlineMs,
        now: b.now,
        clock,
      })
      // 终态 run 不再接受取消写入；还压着人工裁决的 run 明确返回 cancellation_pending。
      // 纯控制节点取消后立即终态；若还有执行器节点在围栏里，sweep 后续再收口。
      if (out.runStatus !== 'already_stopped') closeRun(tx, opts.secret, b.runId, b.now)
      // 对外契约：runStatus 是请求层的取消进展，terminalStatus/outcome 是库里的实际结果。
      // 只给 cancelled 会让调用方以为“取消成功=业务成功”，所以把业务结果一并返回（审计 P2-3）。
      const statusRow = tx.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', [b.runId])
      const terminalEvent = tx.get<{ payload: string }>(
        "SELECT payload_redacted AS payload FROM events WHERE type = 'run.terminal' AND run_id = ? ORDER BY seq DESC LIMIT 1",
        [b.runId],
      )
      let outcome: string | null = null
      if (terminalEvent) {
        try {
          outcome = (JSON.parse(terminalEvent.payload) as { outcome?: string }).outcome ?? null
        } catch {
          outcome = null
        }
      }
      const terminalStatus = statusRow && RUN_TERMINAL.has(statusRow.status) ? statusRow.status : null
      return { ...out, terminalStatus, outcome }
    }),
    dispatch: async (b) => {
      // 控制节点（wait / subworkflow）不需要宿主执行器：只跑它们的工作流在无执行器进程里也能推进。
      // 只有 agent 节点必须要有执行器；parallel / decision 没有执行实现，交给 dispatcher 明确拒绝。
      const agentNodes = db.raw.prepare(
        "SELECT COUNT(*) AS n FROM node_runs WHERE run_id = ? AND status = 'queued' AND node_type = 'agent'",
      ).get(b.runId) as { n: number }
      if (Number(agentNodes.n) > 0 && !executorDeps) {
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能派发 agent 节点', { runId: b.runId })
      }
      return dispatchRun({
        db,
        secret: opts.secret,
        runtime,
        ...(executorDeps ? { executor: executorDeps, executeNode: executeScheduled } : {}),
        executionLimits,
        catalog,
      }, {
        runId: b.runId,
        nodes: b.nodes,
        now: b.now,
        ownerEpoch: b.ownerEpoch ?? db.epoch,
        leaseTtlMs: b.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        leaseRenewIntervalMs: b.leaseRenewIntervalMs,
      })
    },
    runNode: async (b) => {
      if (!opts.executor) {
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑节点', { nodeRunId: b.nodeRunId })
      }
      const out = await executeScheduled({
        nodeRunId: b.nodeRunId,
        nodeId: b.nodeId,
        attempt: b.attempt,
        input: b.input ?? {},
        outputSchema: b.outputSchema ?? {},
        tools: b.tools,
        now: b.now,
        ownerEpoch: b.ownerEpoch ?? db.epoch,
        leaseTtlMs: b.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        leaseRenewIntervalMs: b.leaseRenewIntervalMs,
        ...executionLimits,
      })
      // 单节点入口也要收口：run 下所有节点都终态且无活跃 decision 时写运行终态。
      const row = db.raw.prepare('SELECT run_id FROM node_runs WHERE node_run_id = ?').get(b.nodeRunId) as { run_id?: string } | undefined
      if (row?.run_id) inTx(db, (tx) => { closeRun(tx, opts.secret, row.run_id!, b.now) })
      return out
    },
  }
  return {
    db,
    runtime,
    catalog,
    commands,
    cancels,
    close: () => { db.raw.close() },
  }
}

// 服务启动的完整生命周期：文件锁 → epoch 自增 → 打开服务库 → 迁移 → 起服务
// 单写者靠两件事保证：同一时刻只有一个进程拿得到文件锁；epoch 递增后老进程的写入会被围栏挡下（规格 行 105；第四轮审计 M3）
export async function openServiceOrchestra(opts: OrchestraOptions): Promise<{
  orchestra: Orchestra
  release: () => Promise<void>
}> {
  const releaseLock = await acquireDbLock(opts.dbFile)
  let orchestra: Orchestra | null = null
  let db: Db | null = null
  try {
    const epoch = bumpEpoch(opts.dbFile)
    db = openServiceDb(opts.dbFile, epoch)
    orchestra = createOrchestra({ ...opts, db }, ORCHESTRA_LOCK_PROOF)
    return {
      orchestra,
      release: async () => {
        orchestra?.close()
        await releaseLock()
      },
    }
  } catch (err) {
    // createOrchestra 可能在读完配置后抛错；此时 orchestra 还没建出来，
    // 但 db 已经打开，必须在这里关掉，否则临时目录删除会报 EPERM。
    if (orchestra) orchestra.close()
    else {
      try { db?.raw.close() } catch { /* 关闭失败不覆盖原始错误 */ }
    }
    await releaseLock()
    throw err
  }
}

// 供宿主接进 DSH：返回 endpoint 与关闭句柄
export async function serveOrchestra(opts: OrchestraOptions & {
  asOfSeq: ServerDeps['asOfSeq']
  listTasks: ServerDeps['listTasks']
  listEvents: ServerDeps['listEvents']
  appendLedgerEvent: ServerDeps['appendLedgerEvent']
}): Promise<{ orchestra: Orchestra; endpoint: string; close: () => Promise<void> }> {
  const log = opts.log ?? nullLogger
  // 并发闸在生产装配这一层建：配置里的 execution.concurrency 与 human_slots 在这里真正生效。
  // 配置读不到时退回默认定值（并发 3、人工名额 1），不让一个可选配置文件挡住服务启动。
  const scheduler = opts.scheduler ?? schedulerFromConfig(opts.configPath, log)
  // 服务启动顺序固定：文件锁 → epoch → 打开服务库 → 迁移 → 起服务（第四轮审计 M3）
  const service = await openServiceOrchestra({ ...opts, scheduler })
  const orchestra = service.orchestra
  // 维护扫描：租约过期、围栏宽限到点，2 秒一轮；失败只记日志，下一轮继续
  const sweepTimer = setInterval(() => {
    try {
      sweepNow(orchestra.runtime, new Date().toISOString())
    } catch (err) {
      log.error('维护扫描失败', { err: err instanceof Error ? err.message : String(err) })
    }
  }, 2000)
  sweepTimer.unref?.()
  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      secret: opts.secret,
      phase: opts.phase,
      epoch: orchestra.db.epoch,
      asOfSeq: opts.asOfSeq,
      listTasks: opts.listTasks,
      listEvents: opts.listEvents,
      queries: {
        listEvents: (fromSeq, limit) => listEventPage(orchestra.db, { fromSeq, limit }),
        listTaskSummaries: (params) => listTaskSummaries(orchestra.db, params),
        getTaskSummary: (taskId, now) => getTaskSummarySnapshot(orchestra.db, taskId, now),
        listRuns: (query) => listRuns(orchestra.db, query),
        getRun: (runId) => getRun(orchestra.db, runId),
        listNodes: (runId, limit) => listNodes(orchestra.db, runId, limit),
        getNode: (nodeRunId) => getNodeSnapshot(orchestra.db, nodeRunId),
        getArtifact: (artifactId, now) => getArtifactSnapshot(orchestra.db, artifactId, now),
        getAttestation: (attestationId) => getAttestationSnapshot(orchestra.db, attestationId),
        listDecisions: (params) => listDecisions(orchestra.db, params),
        getDecision: (decisionId) => getDecisionSnapshot(orchestra.db, decisionId),
        getEvidence: (evidenceId) => getEvidenceSnapshot(orchestra.db, opts.secret, evidenceId),
        verifyLedger: () => verifyLedgerSnapshot(orchestra.db, opts.secret),
        listWorkflows: (params) => listWorkflowQuery(orchestra.db, params),
        getWorkflow: (workflowId) => getWorkflowSnapshot(orchestra.db, workflowId),
        getWorkflowVersion: (workflowId, version) => getWorkflowVersionSnapshot(orchestra.db, workflowId, version),
        getOperation: (operationId, now) => getOperationSnapshot(orchestra.db, operationId, now),
        listUnverifiedEffects: (params) => listUnverifiedEffects(orchestra.db, params),
      },
      appendLedgerEvent: opts.appendLedgerEvent,
      commands: orchestra.commands,
      log,
    })
  } catch (err) {
    clearInterval(sweepTimer)
    await service.release()
    throw err
  }
  return {
    orchestra,
    endpoint: server.endpoint,
    close: async () => {
      clearInterval(sweepTimer)
      try {
        await server.close()
      } finally {
        // 先停入口，再把在跑与排队的任务收干净，最后才释放服务锁。
        await scheduler.close({ drain: true })
        await service.release()
      }
    },
  }
}

// 执行时限：配置文件不存在时返回空对象沿用默认值；文件存在但非法时必须报错，不能静默吞掉配置错误。
function executionLimitsFromConfig(configPath: string | undefined): Pick<RunNodeParams, 'actionTimeoutMs' | 'startupTimeoutMs' | 'verifyTimeoutMs'> {
  const path = configPath ?? 'orchestra.config.json'
  if (!existsSync(path)) return {}
  const cfg = loadConfig(path)
  return {
    actionTimeoutMs: cfg.execution.action_timeout_ms,
    startupTimeoutMs: cfg.execution.startup_timeout_ms,
    verifyTimeoutMs: cfg.execution.verify_timeout_ms,
  }
}

// 桥 spill 目录优先取装配参数，其次读配置；配置缺失时交给 runNode 的临时目录兜底。
function bridgeSpillDirFromConfig(configPath: string | undefined): string | undefined {
  try {
    return loadConfig(configPath ?? 'orchestra.config.json').bridge.spill_dir
  } catch {
    return undefined
  }
}

// 配置是并发的唯一来源；配置缺失或读不动时退回默认定值，不让服务起不来
function schedulerFromConfig(configPath: string | undefined, log: Logger): ExecutionScheduler {
  try {
    return createExecutionSchedulerFromConfig(loadConfig(configPath ?? 'orchestra.config.json'), log)
  } catch (err) {
    log.warn('读不到执行配置，按默认并发装配', {
      path: configPath ?? 'orchestra.config.json',
      err: err instanceof Error ? err.message : String(err),
    })
    return createExecutionScheduler({ log })
  }
}

export { renewNodeLease, runNode, sweepNow, submitReport }
