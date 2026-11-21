import { rememberManualDispatchSpecs, resolveManualReworkSpecs } from './service/rework-dispatch-specs.ts'
import { configureReceiptRetention } from './service/receipt-retention.ts'
import { installConfiguredLocalDshHost, localDshHostConfig } from './service/local-dsh-host.ts'
import type { Context } from '@deepseek-ai/cordis'
// src/index.ts —— DSH 插件入口 + 生产装配（规格 12.5 行 1088-1092）
import { existsSync, realpathSync, statSync } from 'node:fs'
import { OrchError } from './core/errors.ts'
import { openDb, type Db } from './infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from './infra/db/migrate.ts'
import { bumpEpoch, openServiceDb } from './infra/db/open.ts'
import { acquireDbLock } from './infra/lock.ts'
import { nullLogger, type Logger } from './infra/logger.ts'
import { WorkflowCatalog } from './service/workflows.ts'
import { createRun, reserveTask } from './service/runs.ts'
import { createWorkflowCommand, openDraftCommand, updateDraftCommand, publishWorkflowCommand, publishContextFor, setWorkflowStatus, getWorkflow as getWorkflowSummary, listWorkflows as listWorkflowSummaries } from './service/commands/workflows.ts'
import { getWorkflowDraftTest, testWorkflowDraft } from './service/commands/workflows.ts'
import { withReadTx } from './service/queries/read-tx.ts'
import { phaseIndex, requireCapability } from './core/config.ts'
import { sweepIntake } from './service/trial-access.ts'
export { createIntakeControl, type IntakeOptions } from './service/trial-access.ts'
import { bindTrialHost, trialAllowsMemoryApply, type TrialOptions } from './service/trial-circles.ts'
export type { TrialOptions, TrialScope } from './service/trial-circles.ts'
import { startRun } from './service/commands/start-run.ts'
import { setTaskArchive } from './service/commands/task-archive.ts'
import { createTaskTriggerHost } from './service/task-triggers.ts'
import { createTriggerDispatchPump, type ResolveTriggerNodeSpecs } from './service/task-trigger-dispatch.ts'
export type { ResolveTriggerNodeSpecs, TriggerRunReady } from './service/task-trigger-dispatch.ts'
export type { TaskTriggerCreate, TaskTriggerOccurrence, TaskTriggerView } from './core/task-trigger.ts'
export {
  listTriggerExecutionStates,
  type TaskTriggerExecutionFilter,
  type TaskTriggerExecutionRow,
  type TaskTriggerReadiness,
} from './service/task-triggers.ts'
import { acknowledgeDecision, resolveDecision } from './service/commands/decisions.ts'
import { requestHashOf } from './service/commands/idempotency.ts'
import { runDecisionCommand } from './service/decision/confirmation.ts'
import { inspectEffectEvidence, resolveEffect } from './service/commands/effects.ts'
import { recoverChatModelAssignment } from './service/chat-model-recovery.ts'
import { resumeFromBlockedPre } from './service/commands/nodes.ts'
import { confirmStartup } from './service/commands/confirm-start.ts'
import { dispatchRun } from './service/dispatcher.ts'
import { closeRun } from './service/commands/run-close.ts'
import { settleCompensation, startCompensation } from './service/commands/compensation.ts'
import { wakeOnEvent } from './service/commands/wait.ts'
import { propagateRunCancellation } from './service/commands/subworkflow.ts'
import { resolveRecoveryUncertain } from './service/commands/recovery.ts'
import { listRecoveryUncertain } from './service/queries/recovery.ts'
import { listTaskSummaries, getTaskSummarySnapshot, getWorkspaceOverview } from './service/queries/tasks.ts'
import { listRuns, getRun } from './service/queries/runs.ts'
import { listNodes, getNodeSnapshot } from './service/queries/nodes.ts'
import { getArtifactContent, getArtifactSnapshot, listRunArtifacts } from './service/queries/artifacts.ts'
import { getAttestationSnapshot } from './service/queries/attestations.ts'
import { getDecisionSnapshot, listDecisions } from './service/queries/decisions.ts'
import { getEvidenceSnapshot } from './service/queries/evidence.ts'
import { verifyLedgerSnapshot } from './service/queries/verify_ledger.ts'
import { getWorkflowSnapshot, getWorkflowVersionSnapshot, listWorkflowSummaries as listWorkflowQuery } from './service/queries/workflows.ts'
import { listUnverifiedEffects } from './service/queries/effects.ts'
import { listMemoryBatches } from './service/queries/memory-batches.ts'
import { listEvents as listEventPage, listEventHistory } from './service/queries/list_events.ts'
import { listExecutionHistory } from './service/queries/execution-history.ts'
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
  runNode, DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_LEASE_TTL_MS,
  type RunNodeDeps, type RunNodeParams, type RunNodeResult,
} from './executor/run-node.ts'
import { bridgeHostAgentFactory } from './executor/bridge.ts'
import { createDshExecutor, createDshPlanningCallback } from './executor/dsh-host.ts'
import { createCollaborationHost, type CollaborationHost } from './service/collaboration.ts'
import { callDshCollaboration } from './service/dsh-collaboration.ts'
import { createReworkHost, type ReworkHost } from './service/rework-coordinator.ts'
import { createDeliveryReviewHost } from './service/delivery-review.ts'
import { createReworkPlanningHost, type ReworkPlanner } from './service/rework-planning.ts'
import { createPlanningSettingsHost, type PlanningSettingsHost } from './service/planning-settings.ts'
import { createExecutionCapacitySettingsHost, type ExecutionCapacitySettingsHost } from './service/execution-capacity-settings.ts'
import { createWorkflowConcurrencyHost, type WorkflowConcurrencyHost } from './service/workflow-concurrency-settings.ts'
import { resolvePinnedNodeId } from './service/rework-extra-steps.ts'
import { callDshRework } from './service/dsh-rework.ts'
import { createReworkInspectionHost } from './service/rework-inspection.ts'
import { createModelEscalationHost } from './service/model-escalation.ts'
import { createReleaseWorkflowHost, type ReleaseWorkspace } from './service/release-workflow.ts'
import { isReleaseWorkflow, RELEASE_CHECK_WORKFLOW_ID, RELEASE_GROUPS, type ReleaseGroup } from './core/wf-release-v1.ts'
import { commandHashOf, resolveInside } from './executor/tools.ts'
import { approvedModelProfiles, createModelRoutingSettingsHost, effectiveModelCatalog, readModelRoutingSettings } from './service/model-routing-settings.ts'
export type { ModelRouting, ModelRoutingContext, ModelComplexity, ModelRecommendation, ModelProfile } from './executor/model-routing.ts'
export { createDshExecutor, createDshPlanningCallback, type DshExecutionModel } from './executor/dsh-host.ts'
export { ReadOnlyToolRunner, ToolRegistry } from './executor/tools.ts'
export type { EffectVerifier, EffectVerificationTarget, EffectVerdict } from './executor/tools.ts'

export const Config = localDshHostConfig

/** Host half of the dual-face package. The Desktop bundle selects the personal adapter. */
export function apply(ctx: Context, config: typeof Config._output): void {
  installConfiguredLocalDshHost(ctx, config.local, serveDshOrchestra)
}

/** Mount inside DSH's Cordis context with a host-authorized parent and model catalog. */
export async function serveDshOrchestra(options: Omit<Parameters<typeof serveOrchestra>[0], 'executor' | 'plannerModelConfigurable'> & {
  dsh: Parameters<typeof createDshExecutor>[0]
  dshPlanner?: Omit<Parameters<typeof createDshPlanningCallback>[0], 'context'> & { useModelRoutingSettings?: boolean }
  tools: Pick<RunNodeDeps, 'registry' | 'runner'>
}) {
  const { dsh, dshPlanner, tools, ...serviceOptions } = options
  let plannerDb: Db | undefined
  let collaboration: CollaborationHost | undefined
  let installed: { db: Db; feedback: ReworkHost } | undefined
  const host = createDshExecutor({ ...dsh,
    ...(serviceOptions.phase === 'S5' || serviceOptions.phase === 'S6' ? {
      rework(binding, input) {
        if (!installed) throw new OrchError('SERVICE_UNAVAILABLE', '成果审核服务尚未就绪')
        return callDshRework(installed.db, installed.feedback, binding, input, undefined,
          serviceOptions.phase === 'S6' ? serviceOptions.secret : undefined)
      },
    } : {}), ...(serviceOptions.collaboration ? {
    collaboration: (binding, input) => {
      if (!collaboration) throw new OrchError('SERVICE_UNAVAILABLE', '核验服务尚未就绪')
      return callDshCollaboration(collaboration, binding, input)
    },
  } : {}) })
  try {
    const planner = dshPlanner && { context: dsh.context, parent: dshPlanner.parent, model: dshPlanner.model }
    if (planner && dshPlanner.useModelRoutingSettings) {
      const fallback = planner.model
      planner.model = (parent, signal) => {
        if (!plannerDb) throw new OrchError('SERVICE_UNAVAILABLE', '主脑模型设置尚未就绪')
        const selected = withReadTx(plannerDb, ({ tx }) => readModelRoutingSettings(tx).planner_model)
        if (selected) return host.resolvePlanningModel(selected.ref, selected.effort, signal)
        return typeof fallback === 'function' ? fallback(parent, signal) : fallback
      }
    }
    const generateWorkflow = planner && createDshPlanningCallback(planner, 'workflow')
    // 同一个流程生成回调既接给服务端入口，也接给规划侧：没有可复用的合适流程时，规划侧自动生成任务专属流程
    const workflowGenerator = generateWorkflow ? (input: { goal: string }, signal: AbortSignal, onProgress?: () => void) =>
      generateWorkflow({ ...input, tools: tools.registry.list().filter((tool) => tool.capability === 'read_only').map((tool) => tool.name) }, signal, onProgress) : undefined
    const service = await serveOrchestra({
      ...serviceOptions,
      plannerModelConfigurable: dshPlanner?.useModelRoutingSettings === true,
      ...(planner ? { reworkPlanner: createDshPlanningCallback(planner, 'rework') } : {}),
      ...(planner ? { planning: {
        propose: createDshPlanningCallback(planner),
        streamProgress: true,
        ...(workflowGenerator ? { workflowGenerator, workflowStreamProgress: true } : {}),
      } } : {}),
      ...(workflowGenerator ? { workflowGenerator, workflowGeneratorStreamProgress: true } : {}),
      workflowHelpersAvailable: true,
      executor: { ...tools, bridge: host.bridge, modelRouting: host.modelRouting },
    })
    plannerDb = service.orchestra.db
    collaboration = service.collaboration
    if (service.rework) installed = { db: service.orchestra.db, feedback: service.rework }
    return { ...service, close: async () => {
      host.stopModelRefresh()
      try { await service.close() } finally { await host.close() }
    } }
  } catch (error) {
    await host.close()
    throw error
  }
}
import type { HostAgentFactory } from './executor/session.ts'
import { ExecutionCancels } from './service/execution-cancels.ts'
import {
  createExecutionScheduler, createExecutionSchedulerFromConfig, runThroughScheduler, type ExecutionScheduler,
  type ConfigurableExecutionScheduler,
} from './service/execution-scheduler.ts'
import { loadConfig } from './core/config.ts'
import { SystemClock } from './core/clock.ts'
import { randomUUID } from 'node:crypto'
import { createMemoryHost, type MemoryHostOptions } from './service/memory-host.ts'
import { createTaskPlanningHost, resolveApprovedPlanNodeSpecs, type TaskPlanningOptions, type TaskPlanningHost } from './service/task-planning.ts'
import { createRunSharedContext } from './service/run-shared-context.ts'
import type { ProjectContextSource } from './service/project-shared-context.ts'
export type { MemoryHostOptions, MemoryPluginWriter } from './service/memory-host.ts'

export const name = 'dsh-orchestra'
export const version = '0.1.0'

export { inspectMemoryRecovery, resolveMemoryRecovery } from './service/commands/memory-recovery.ts'
export { createMemoryRuntime, type MemoryRuntimeOptions } from './service/commands/memory-runtime.ts'
export { registerRunArtifact, type RegisterRunArtifact } from './service/artifact-store.ts'
export { getTaskPlanRecommendation, type TaskPlanningOptions, type TaskPlanProposal } from './service/task-planning.ts'
export { withPlanningBudget, type PlanningTimeoutSnapshot } from './service/planning-settings.ts'
export { createCollaborationHost, type CollaborationBinding, type CollaborationHost } from './service/collaboration.ts'
export type { MemoryRecoveryRequest, MemoryWriteEvidence } from './service/commands/memory-recovery.ts'
export type { InspectMemoryWrite, MemoryWriteInspection } from './service/commands/memory-ports.ts'

export type OrchestraOptions = {
  /** Set by the production DSH executor that implements bounded node assistants. */
  workflowHelpersAvailable?: boolean
  dbFile: string
  secret: string
  phase: Phase
  trial?: TrialOptions
  planning?: TaskPlanningOptions
  projectContext?: ProjectContextSource
  reworkPlanner?: ReworkPlanner
  release?: Omit<ReleaseWorkspace, 'runGroup'> & { checkDirectories: Record<ReleaseGroup, string> }
  collaboration?: boolean
  log?: Logger
  // 生产执行器：装配了就开 /v1/node-runs/run，没装配时该路由明确报未配置（审计 F-01）
  // agents 省略时由 bridge.spawn 兜底，生产路径不靠外部顺手塞一个宿主工厂。
  executor?: Omit<RunNodeDeps, 'runtime' | 'db' | 'secret' | 'agents' | 'sharedContext'> & { agents?: HostAgentFactory }
  // 执行并发闸：agent 执行是长时间任务，不占写队列的名额，并发上限在这里生效（第二次意见 P1）
  scheduler?: ExecutionScheduler
  // 生产装配读配置的路径；读不到就退回默认并发（并发 3、人工名额 1）
  configPath?: string
  // 桥未确认事件的落盘目录；不传则读配置 bridge.spill_dir，再退回临时目录
  spillDir?: string
}

export type Orchestra = {
  db: Db
  trial?: ReturnType<typeof bindTrialHost>
  runtime: RuntimeDeps
  catalog: WorkflowCatalog
  commands: NodeCommands
  modelEscalation?: ReturnType<typeof createModelEscalationHost>
  executionCapacitySettings?: ExecutionCapacitySettingsHost
  workflowConcurrencySettings?: WorkflowConcurrencyHost
  release?: ReturnType<typeof createReleaseWorkflowHost>
  // 执行中取消的进程内注册表：账本记取消事实，这里把 AbortSignal 送到对应的 runNode
  cancels: ExecutionCancels
  close: () => void
}

// 只有走完取锁与 epoch 自增的启动链才许可建装配：单写者是启动前提，不是可选装饰（第五轮审计 P1-3）
// run 终态集合：取消接口只在这些状态下回报 terminalStatus（S1 第 59 轮 P2-4）

// 生产派发真正实现了的节点类型：parallel / decision 只有状态机与测试，允许发布会让 run 起不来（审计 P1-4）
const RUNTIME_NODE_TYPES: ReadonlySet<string> = new Set(['agent', 'policy', 'approval', 'subworkflow', 'wait'])
const RUN_TERMINAL = new Set(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled'])

const ORCHESTRA_LOCK_PROOF = Symbol('orchestra-lock-proof')
// 生产装配：一个进程一个写者，迁移在打开时跑完，命令统一走 runtime
// 外部只能走 openServiceOrchestra；直接调用拿不到凭证（第五轮审计 P1-3）
export function createOrchestra(opts: OrchestraOptions & { db?: Db }, proof?: symbol): Orchestra {
  if (proof !== ORCHESTRA_LOCK_PROOF) {
    throw new OrchError('FORBIDDEN', '建 orchestra 必须走 openServiceOrchestra：单写者锁与 epoch 是启动前提', {})
  }
  const db = opts.db ?? openDb(opts.dbFile)
  const configPath = opts.configPath ?? 'orchestra.config.json'
  if (existsSync(configPath)) configureReceiptRetention(db, loadConfig(configPath).retention)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  if (opts.trial && opts.phase !== 'S6') throw new OrchError('FORBIDDEN', '试用圈仅在 S6 开放')
  const trial = opts.trial ? bindTrialHost(db, opts.trial, opts.executor?.runner.root) : undefined
  const registry = opts.executor?.registry
  const catalog = new WorkflowCatalog(opts.phase, db, registry ? name => registry.lookup(name)?.capability === 'read_only' : undefined, registry)
  // 定义落库是跨重启的事实来源：不先把已签发的版本装回内存，重启后同版本会被当成新定义（第六轮审计 P1-1）
  catalog.hydrate()
  // 生产时钟：墙钟与单调钟同时取样，漂移超过 2 秒就判不确定（规格 3.4 行 171）
  const clock = new SystemClock(randomUUID())
  const runtime: RuntimeDeps = { db, secret: opts.secret, phase: opts.phase, catalog, clock }
  const executor = opts.executor
  const routing = executor?.modelRouting
  const modelEscalation = opts.phase === 'S6' && routing
    ? createModelEscalationHost(db, opts.secret, (tx) => approvedModelProfiles(effectiveModelCatalog(
      routing.catalog?.().profiles ?? routing.profiles, readModelRoutingSettings(tx))), opts.reworkPlanner,
      (error) => opts.log?.error('模型诊断失败', { code: error instanceof OrchError ? error.code : 'INTERNAL_ERROR' }), undefined, true)
    : undefined
  const spillDir = executor?.spillDir ?? opts.spillDir ?? bridgeSpillDirFromConfig(opts.configPath)
  // 读取执行器的宿主默认时限；S6 面板可以覆盖单步执行时限。
  const executionLimits = executionLimitsFromConfig(opts.configPath)
  const scheduler = opts.scheduler
  const workflowConcurrencySettings = opts.phase === 'S6' && scheduler?.configureWorkflowLimits
    ? createWorkflowConcurrencyHost(db, scheduler, opts.workflowHelpersAvailable === true) : undefined
  const executionCapacitySettings = opts.phase === 'S6' && scheduler && 'setCapacity' in scheduler
    && typeof scheduler.setCapacity === 'function'
    ? createExecutionCapacitySettingsHost(db, scheduler as ConfigurableExecutionScheduler,
      executionLimits.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
    : undefined
  const agents = executor ? (executor.agents ?? bridgeHostAgentFactory(executor.bridge)) : null
  const cancels = new ExecutionCancels()
  const sharedContext = opts.phase === 'S6' && opts.projectContext ? createRunSharedContext(db, opts.projectContext) : undefined
  const executorDeps: RunNodeDeps | null = executor && agents
    ? { runtime, db, secret: opts.secret, ...executor, agents, modelEscalation, sharedContext, ...(spillDir ? { spillDir } : {}) }
    : null
  // 节点执行只有一个底层实现；调度只在装配层包一次（S2 第三十七轮 P0-01）。
  const executeNode = async (p: RunNodeParams): Promise<RunNodeResult> => {
    if (!executorDeps) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑节点', { nodeRunId: p.nodeRunId })
    }
    if (cancels.has(p.nodeRunId, p.attempt)) {
      throw new OrchError('STALE_GENERATION', '同一次节点执行已在运行', { nodeRunId: p.nodeRunId, attempt: p.attempt })
    }
    const signal = cancels.register(p.nodeRunId, p.attempt)
    try {
      const actionTimeoutMs = executionCapacitySettings?.actionTimeoutMs() ?? p.actionTimeoutMs
      return await runNode({ ...executorDeps, cancelSignal: signal }, { ...p, actionTimeoutMs })
    } finally {
      cancels.release(p.nodeRunId, p.attempt)
    }
  }
  // 两条入口（/v1/runs/dispatch 与 /v1/node-runs/run）共用这一个带闸函数：
  // 不允许 dispatcher 自己再排一次，否则同一次执行会重复占两个并发名额。
  const executeScheduled = (p: RunNodeParams): Promise<RunNodeResult> => {
    const enqueuedAt = performance.now()
    const workflowScope = workflowConcurrencySettings && !p.releaseCheckCwd ? withReadTx(db, ({ tx }) => {
      const row = tx.get<{runId:string; workflowId:string; node_type:string}>(
        'SELECT n.run_id AS runId,r.workflow_id AS workflowId,n.node_type FROM node_runs n JOIN runs r USING(run_id) WHERE n.node_run_id=?',
        [p.nodeRunId])
      if (!row || !row.workflowId || row.node_type !== 'agent' || isReleaseWorkflow(row.workflowId)) return undefined
      return { runId: row.runId, workflowId: row.workflowId, nodeId: resolvePinnedNodeId(tx, p.nodeRunId) }
    }) : undefined
    return runThroughScheduler(opts.scheduler, () => {
      const waitedMs = Math.floor(performance.now() - enqueuedAt)
      const workflowHelperLimit = workflowScope ? workflowConcurrencySettings?.helperLimit(workflowScope) : undefined
      return executeNode({ ...p, workflowHelperLimit, now: new Date(Date.parse(p.now) + waitedMs).toISOString() })
    }, { label: p.nodeId, nodeRunId: p.nodeRunId, attempt: p.attempt, workflowScope })
  }
  const releaseOptions = opts.release
  const release = releaseOptions && (() => {
    requireCapability(opts.phase, 'release')
    const descriptor = registry?.lookup(RELEASE_CHECK_WORKFLOW_ID)
    if (!executorDeps || descriptor?.capability !== 'read_only') {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '发布运行需要已隔离的生产执行器与固定只读检查命令')
    }
    const root = executorDeps.runner.root
    const groupDirectories = new Map((Object.keys(RELEASE_GROUPS) as ReleaseGroup[]).map((group) => {
      const configured = releaseOptions.checkDirectories[group]
      if (typeof configured !== 'string') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '缺少发布检查组的隔离目录', { group })
      const cwd = realpathSync(resolveInside(root, configured))
      if (!statSync(cwd).isDirectory()) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '发布检查组路径必须是目录', { group })
      return [group, resolveInside(root, cwd)]
    }))
    if (new Set(groupDirectories.values()).size !== groupDirectories.size) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '发布检查组必须使用各自登记的隔离目录')
    }
    const hashes = new Map([...groupDirectories].map(([group, cwd]) => [group, commandHashOf(descriptor.command.bin, descriptor.command.args, cwd, root)]))
    return createReleaseWorkflowHost({ db, secret: opts.secret, catalog, clock, workspace: { ...releaseOptions,
      verifyGroup(request) { return hashes.get(request.group) === request.execution.command_hash && releaseOptions.verifyGroup(request) },
      async runGroup(request) {
        const started = new Date().toISOString()
        const cwd = groupDirectories.get(request.group)!
        await executeScheduled({ nodeRunId: request.check_node_run_id, nodeId: 'check', attempt: 1,
          input: { ...request, instruction: '调用固定检查工具一次，用检查结果说明本组证据。' }, outputSchema: {},
          tools: [{ command: RELEASE_CHECK_WORKFLOW_ID, args: [], cwd, timeoutMs: 120_000 }], releaseCheckCwd: cwd,
          now: started, ownerEpoch: db.epoch, leaseTtlMs: DEFAULT_LEASE_TTL_MS, ...executionLimits })
        inTx(db, (tx) => closeRun(tx, opts.secret, request.child_run_id, new Date().toISOString()))
      },
    } })
  })()
  function assertOrdinaryRun(id: string, byNode = false) {
    const row = db.raw.prepare(byNode
      ? 'SELECT r.workflow_id FROM node_runs n JOIN runs r USING(run_id) WHERE n.node_run_id=?'
      : 'SELECT workflow_id FROM runs WHERE run_id=?').get(id) as { workflow_id?: string } | undefined
    if (isReleaseWorkflow(row?.workflow_id)) throw new OrchError('FORBIDDEN', '发布运行只能通过专用受信入口推进')
  }
  const commands: NodeCommands = {
    listRecoveryUncertain: () => listRecoveryUncertain(db),
    resolveRecoveryUncertain: (b) => inTx(db, (tx) => resolveRecoveryUncertain(tx, opts.secret, b)),
    acquireLease: (b) => { assertOrdinaryRun(b.nodeRunId, true); return acquireNodeRun(runtime, b) },
    renewLease: (b) => { assertOrdinaryRun(b.nodeRunId, true); return renewNodeLease(runtime, b) },
    report: (b) => { assertOrdinaryRun(b.nodeRunId, true); return submitReport(runtime, b as Parameters<typeof submitReport>[1]) },
    cancel: (b) => {
      assertOrdinaryRun(b.nodeRunId, true)
      const out = submitCancel(runtime, { ...b, cancelResult: b.cancelResult as CancelResult })
      // 账本先落取消事实，再把停止请求送到正在跑的那个 attempt；
      // 已停的节点没有在跑实例，不打断任何东西。
      scheduler?.cancelWaiting?.(b.nodeRunId, b.attempt)
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
    testWorkflowDraft: (b) => {
      requireCapability(opts.phase, 'workflow_publish')
      return inTx(db, (tx) => testWorkflowDraft(tx, b, publishContextFor(tx, RUNTIME_NODE_TYPES), opts.executor?.registry))
    },
    getWorkflowDraftTest: (workflowId) => withReadTx(db, ({ tx }) => getWorkflowDraftTest(tx, workflowId)),
    setWorkflowStatus: (b) => {
      requireCapability(opts.phase, 'workflow_publish')
      return inTx(db, (tx) => setWorkflowStatus(tx, b))
    },
    // 发布从 S4 起才许（规格 2.4）：闸门装在命令装配层，HTTP 与内部调用都绕不过
    publishWorkflow: (b) => {
      requireCapability(opts.phase, 'workflow_publish')
      const out = inTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: b.workflowId, revision: b.revision, baseVersion: b.baseVersion, note: b.note,
      actor: b.actor, now: b.now, operationId: b.operationId,
    }, publishContextFor(tx, RUNTIME_NODE_TYPES), { requireTest: phaseIndex(opts.phase) >= phaseIndex('S5'), tools: opts.executor?.registry, catalog }))
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
      triggerKind: b.triggerKind,
      escalations: b.escalations,
      operationId: b.operationId,
      startedBy: opts.phase === 'S6' ? b.startedBy : undefined,
      now: b.now,
    }),
    setTaskArchive: (body, actor, now) => {
      requireCapability(opts.phase, 'panel')
      return setTaskArchive(db, body, actor, now)
    },
    acknowledgeDecision: (b) => inTx(db, (tx) => acknowledgeDecision(tx, b)),
    resolveDecision: (input) => inTx(db, (tx) => {
      const { operationId, now, confirmChallenge, bindActor, ...b } = input
      return runDecisionCommand(tx, opts.secret, input, requestHashOf('decision.resolve', b), false, (confirmed, requireEffectSettlement) => {
        const out = resolveDecision(tx, opts.secret, {
          decisionId: b.decisionId,
          revision: b.revision,
          resolution: b.resolution,
          payload: b.payload,
          actor: b.actor,
          evidenceProducers: b.evidenceProducers,
          confirm: confirmed,
          requireEffectSettlement,
          contentHash: b.contentHash,
          now,
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
            now,
          })
          if (out.closedReason !== 'approved') closeRun(tx, opts.secret, out.runId, now)
        }
        return { decisionId: out.decisionId, revision: b.revision + 1 }
      })
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
    wakeOnEvent: (b) => {
      assertOrdinaryRun(b.runId)
      return inTx(db, (tx) => wakeOnEvent(tx, opts.secret, { runId: b.runId, eventType: b.eventType,
        payload: b.payload, idempotencyKey: b.idempotencyKey ?? null, now: b.now }))
    },
    cancelRun: (b) => {
      assertOrdinaryRun(b.runId)
      const { response, attemptsToStop } = inTx(db, (tx) => {
        const out = propagateRunCancellation(tx, opts.secret, {
          runId: b.runId,
          cancelResult: b.cancelResult as CancelResult,
          graceMs: b.graceMs,
          extendDeadlineMs: b.extendDeadlineMs,
          now: b.now,
          clock,
        })
        // A run may still need stop evidence or human verification.
        if (out.runStatus !== 'already_stopped') closeRun(tx, opts.secret, b.runId, b.now)
        const statusRow = tx.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', [b.runId])
        const terminalEvent = tx.get<{ payload: string }>(
          "SELECT payload_redacted AS payload FROM events WHERE type = 'run.terminal' AND run_id = ? ORDER BY seq DESC LIMIT 1",
          [b.runId],
        )
        let outcome: string | null = null
        if (terminalEvent) {
          try {
            outcome = (JSON.parse(terminalEvent.payload) as { outcome?: string | null }).outcome ?? null
          } catch {
            outcome = null
          }
        }
        const terminalStatus = statusRow && RUN_TERMINAL.has(statusRow.status) ? statusRow.status : null
        const attemptsToStop = out.cancelledNodes.map((id) => ({
          id, attempt: tx.get<{ attempt: number }>('SELECT attempt FROM node_runs WHERE node_run_id=?', [id])!.attempt,
        }))
        return { response: { ...out, terminalStatus, outcome }, attemptsToStop }
      })
      for (const { id, attempt } of attemptsToStop) {
        scheduler?.cancelWaiting?.(id, attempt)
        if (b.cancelResult !== 'already_stopped') cancels.abort(id, attempt, `cancel:${b.cancelResult}`)
      }
      return response
    },
    dispatch: async (b, progress) => {
      assertOrdinaryRun(b.runId)
      if (registry && ['S5','S6'].includes(opts.phase)) inTx(db, tx => rememberManualDispatchSpecs(tx, opts.secret, catalog, registry, b.runId, b.nodes, b.now))
      // policy、approval、wait 和 subworkflow 不依赖宿主执行器。
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
      }, progress)
    },
    runNode: async (b) => {
      assertOrdinaryRun(b.nodeRunId, true)
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
    modelEscalation,
    executionCapacitySettings,
    workflowConcurrencySettings,
    release,
    trial,
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
  resolveHttpHuman?: ServerDeps['resolveHttpHuman']
  plannerModelConfigurable?: boolean
  memory?: MemoryHostOptions
  workflowGenerator?: ServerDeps['workflowGenerator']
  workflowGeneratorStreamProgress?: boolean
  resolveTriggerNodeSpecs?: ResolveTriggerNodeSpecs
  asOfSeq: ServerDeps['asOfSeq']
  listTasks: ServerDeps['listTasks']
  listEvents: ServerDeps['listEvents']
  appendLedgerEvent: ServerDeps['appendLedgerEvent']
}): Promise<{ orchestra: Orchestra; endpoint: string; collaboration?: CollaborationHost; rework?: ReworkHost;
    planning: TaskPlanningHost; planningSettings?: PlanningSettingsHost;
    recoverChatModelAssignment?: (input: Parameters<typeof recoverChatModelAssignment>[3]) => Promise<string[]>;
    close: () => Promise<void> }> {
  const log = opts.log ?? nullLogger
  // 并发闸在生产装配这一层建：配置里的 execution.concurrency 与 human_slots 在这里真正生效。
  // 配置读不到时退回默认定值（并发 3、人工名额 1），不让一个可选配置文件挡住服务启动。
  const scheduler = opts.scheduler ?? schedulerFromConfig(opts.configPath, log)
  const isWaitingForExecution = (nodeRunId: string) => scheduler.isWaiting?.(nodeRunId) ?? false
  // 服务启动顺序固定：文件锁 → epoch → 打开服务库 → 迁移 → 起服务（第四轮审计 M3）
  const service = await openServiceOrchestra({ ...opts, scheduler })
  const orchestra = service.orchestra
  const collaboration = opts.collaboration ? createCollaborationHost(orchestra.db, opts.secret) : undefined
  const humanReviewOnly = opts.phase === 'S6'
  const rework = opts.phase === 'S5' || humanReviewOnly
    ? createReworkHost(orchestra.db, opts.secret, { clock: orchestra.runtime.clock, humanOnly: humanReviewOnly }) : undefined
  const delivery = rework && createDeliveryReviewHost(orchestra.db, opts.secret, humanReviewOnly)
  const localPlanning = rework && createReworkPlanningHost(orchestra.db, opts.secret, opts.reworkPlanner, humanReviewOnly)
  const inspection = rework && createReworkInspectionHost(orchestra.db, opts.secret, rework, opts.reworkPlanner, humanReviewOnly)
  const modelRouting = opts.executor?.modelRouting
  const modelSettings = modelRouting && createModelRoutingSettingsHost(orchestra.db,
    modelRouting.catalog ?? modelRouting.profiles, modelRouting.refresh, Boolean(opts.planning && opts.plannerModelConfigurable))
  const modelEscalation = orchestra.modelEscalation
  const taskTriggers = phaseIndex(opts.phase) >= phaseIndex('S5')
    ? createTaskTriggerHost(orchestra.db, orchestra.catalog, { executorReady: () => Boolean(opts.resolveTriggerNodeSpecs) })
    : undefined
  const triggerResolver = taskTriggers ? opts.resolveTriggerNodeSpecs : undefined
  const registry = opts.executor?.registry
  const planResolver = registry && (opts.phase === 'S5' || opts.phase === 'S6')
    ? (run: Parameters<typeof resolveApprovedPlanNodeSpecs>[3]) => resolveApprovedPlanNodeSpecs(orchestra.db, orchestra.catalog, registry, run)
    : undefined
  const manualResolver = registry && ['S5','S6'].includes(opts.phase)
    ? (run: Parameters<typeof resolveManualReworkSpecs>[4]) => resolveManualReworkSpecs(orchestra.db, opts.secret, orchestra.catalog, registry, run)
    : undefined
  const triggerDispatch = (triggerResolver || planResolver || manualResolver) && createTriggerDispatchPump(
    orchestra.db,
    triggerResolver,
    (run, nodes, progress) => orchestra.commands.dispatch({ runId: run.run_id, nodes, now: new Date().toISOString() }, progress),
    (error) => log.error('运行自动派发失败', { code: error instanceof OrchError ? error.code : 'INTERNAL_ERROR' }),
    planResolver,
    { secret: opts.secret, resolveManual: manualResolver },
  )
  const tickTaskTriggers = () => {
    try {
      taskTriggers?.tick(new Date().toISOString(), (error) => {
        log.error('任务触发器推进失败', { code: error instanceof OrchError ? error.code : 'INTERNAL_ERROR' })
      })
      triggerDispatch?.tick()
    } catch (error) {
      log.error('任务触发器读扫描失败', { code: error instanceof OrchError ? error.code : 'INTERNAL_ERROR' })
    }
  }
  let memory: ReturnType<typeof createMemoryHost> | undefined
  const memoryDecisionAccess = () => !memory ? false : trialAllowsMemoryApply(orchestra.db) ? true : 'proposal_only' as const
  // 维护扫描：租约过期、围栏宽限到点，2 秒一轮；失败只记日志，下一轮继续
  const sweepTimer = setInterval(() => {
    try {
      sweepNow(orchestra.runtime, new Date().toISOString())
      if (opts.phase === 'S6') sweepIntake(orchestra.db, new Date().toISOString())
      memory?.resume()
      collaboration?.sweep(new Date().toISOString())
      rework?.recover(new Date().toISOString())
      modelEscalation?.tick(new Date().toISOString())
    } catch (err) {
      log.error('维护扫描失败', { code: err instanceof OrchError ? err.code : 'INTERNAL_ERROR' })
    }
    tickTaskTriggers()
  }, 2000)
  sweepTimer.unref?.()
  let server: Awaited<ReturnType<typeof startServer>>
  let planning: TaskPlanningHost
  let planningSettings: PlanningSettingsHost | undefined
  try {
    if (opts.planning) requireCapability(opts.phase, 'panel')
    if (collaboration) requireCapability(opts.phase, 'panel')
    const taskOptions = opts.planning ? {
      ...opts.planning,
      workflowGenerator: opts.planning.workflowGenerator ?? opts.workflowGenerator,
      workflowStreamProgress: opts.planning.workflowGenerator ? opts.planning.workflowStreamProgress : opts.workflowGeneratorStreamProgress,
      runtimeNodeTypes: RUNTIME_NODE_TYPES,
    } : undefined
    const branch = (callback: unknown, streaming: boolean | undefined) => !callback ? 'unavailable' : streaming ? 'streaming' : 'fixed'
    if (taskOptions || opts.workflowGenerator) planningSettings = createPlanningSettingsHost(orchestra.db, {
      task: branch(taskOptions?.propose, taskOptions?.streamProgress),
      automatic_workflow: branch(taskOptions?.workflowGenerator, taskOptions?.workflowStreamProgress),
      standalone_workflow: branch(opts.workflowGenerator, opts.workflowGeneratorStreamProgress),
    }, taskOptions?.timeoutMs)
    planning = createTaskPlanningHost(orchestra.db, orchestra.catalog, opts.executor?.registry, taskOptions,
      modelSettings ? async () => {
        await modelSettings.refresh?.()
        return modelSettings.planningProfiles()
      } : undefined, planningSettings?.snapshot)
    if (opts.memory) {
      requireCapability(opts.phase, 'memory')
      memory = createMemoryHost(orchestra.db, opts.secret, opts.memory, (error) => {
        log.error('记忆运行推进失败', { code: error instanceof OrchError ? error.code : 'INTERNAL_ERROR' })
      })
    }
    server = await startServer({
      secret: opts.secret,
      resolveHttpHuman: opts.resolveHttpHuman,
      phase: opts.phase,
      epoch: orchestra.db.epoch,
      asOfSeq: opts.asOfSeq,
      listTasks: opts.listTasks,
      listEvents: opts.listEvents,
      queries: {
        listEvents: (fromSeq, limit) => listEventPage(orchestra.db, { fromSeq, limit }),
        listEventHistory: (params) => listEventHistory(orchestra.db, params),
        listExecutionHistory: (params) => listExecutionHistory(orchestra.db, params),
        listTaskSummaries: (params) => listTaskSummaries(orchestra.db, params),
        getTaskSummary: (taskId, now) => getTaskSummarySnapshot(orchestra.db, taskId, now),
        getWorkspaceOverview: () => getWorkspaceOverview(orchestra.db, Boolean(orchestra.release)),
        listRuns: (query) => listRuns(orchestra.db, query),
        getRun: (runId) => getRun(orchestra.db, runId),
        listNodes: (runId, limit) => listNodes(orchestra.db, runId, limit, isWaitingForExecution),
        getNode: (nodeRunId) => getNodeSnapshot(orchestra.db, nodeRunId, isWaitingForExecution),
        getArtifact: (artifactId, now) => getArtifactSnapshot(orchestra.db, artifactId, now),
        getArtifactContent: (runId, artifactId, mode, now) => getArtifactContent(orchestra.db, runId, artifactId, mode, now),
        listRunArtifacts: (runId, now) => listRunArtifacts(orchestra.db, runId, now),
        getAttestation: (attestationId) => getAttestationSnapshot(orchestra.db, attestationId),
        listDecisions: (params) => listDecisions(orchestra.db, { ...params, memoryEnabled: memoryDecisionAccess() }),
        getDecision: (decisionId, now) => getDecisionSnapshot(orchestra.db, decisionId, now, memoryDecisionAccess()),
        getEvidence: (evidenceId) => getEvidenceSnapshot(orchestra.db, opts.secret, evidenceId),
        verifyLedger: () => verifyLedgerSnapshot(orchestra.db, opts.secret),
        listWorkflows: (params) => listWorkflowQuery(orchestra.db, params),
        getWorkflow: (workflowId) => getWorkflowSnapshot(orchestra.db, workflowId),
        getWorkflowVersion: (workflowId, version) => getWorkflowVersionSnapshot(orchestra.db, workflowId, version),
        getOperation: (operationId, now) => getOperationSnapshot(orchestra.db, operationId, now),
        listUnverifiedEffects: (params) => listUnverifiedEffects(orchestra.db, params),
        inspectEffectEvidence: (nodeRunId) => inspectEffectEvidence(orchestra.db, opts.secret, nodeRunId),
        listMemoryBatches: (params) => listMemoryBatches(orchestra.db, { ...params, recoveryEnabled: memory !== undefined }),
      },
      appendLedgerEvent: opts.appendLedgerEvent,
      commands: {
        ...orchestra.commands,
        resolveDecision: (request) => memory?.resolveApproval(request) ?? orchestra.commands.resolveDecision(request),
      },
      memory,
      memoryProposalOnly: () => Boolean(memory) && (memoryDecisionAccess() === 'proposal_only' || (opts.phase === 'S6' && !opts.resolveHttpHuman)),
      planning,
      planningSettings,
      executionCapacitySettings: orchestra.executionCapacitySettings,
      workflowConcurrencySettings: orchestra.workflowConcurrencySettings,
      collaboration,
      rework, delivery, localPlanning, inspection, modelEscalation,
      modelSettings,
      workflowGenerator: opts.workflowGenerator,
      workflowGeneratorStreamProgress: opts.workflowGeneratorStreamProgress,
      taskTriggers,
      log,
    })
    memory?.resume()
    rework?.recover(new Date().toISOString())
    tickTaskTriggers()
  } catch (err) {
    clearInterval(sweepTimer)
    await service.release()
    throw err
  }
  return {
    orchestra,
    endpoint: server.endpoint,
    planning,
    collaboration,
    rework,
    planningSettings,
    recoverChatModelAssignment: opts.phase === 'S6' && modelRouting?.refresh && triggerDispatch
      ? async (input: Parameters<typeof recoverChatModelAssignment>[3]) => {
        const { resumed, retrying } = await recoverChatModelAssignment(orchestra.db, opts.secret, modelRouting, input)
        if (resumed > 0) triggerDispatch.tick()
        return retrying
      }
      : undefined,
    close: async () => {
      clearInterval(sweepTimer)
      const closingTriggerDispatch = triggerDispatch?.close()
      try {
        await server.close()
      } finally {
        // 先停入口，再把在跑与排队的任务收干净，最后才释放服务锁。
        await memory?.close()
        await scheduler.close({ drain: true })
        await closingTriggerDispatch
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

// 配置提供默认并发与排队上限，缺失时退回默认值。
function schedulerFromConfig(configPath: string | undefined, log: Logger): ConfigurableExecutionScheduler {
  try {
    return createExecutionSchedulerFromConfig(loadConfig(configPath ?? 'orchestra.config.json'), log)
  } catch (err) {
    log.warn('读不到执行配置，按默认并发装配', { code: err instanceof OrchError ? err.code : 'INTERNAL_ERROR' })
    return createExecutionScheduler({ log })
  }
}

export { renewNodeLease, runNode, sweepNow, submitReport }
