// src/index.ts —— DSH 插件入口 + 生产装配（规格 12.5 行 1088-1092）
import { OrchError } from './core/errors.ts'
import { openDb, type Db } from './infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from './infra/db/migrate.ts'
import { bumpEpoch, openServiceDb } from './infra/db/open.ts'
import { acquireDbLock } from './infra/lock.ts'
import { nullLogger, type Logger } from './infra/logger.ts'
import { WorkflowCatalog } from './service/workflows.ts'
import { createRun } from './service/runs.ts'
import { dispatchRun } from './service/dispatcher.ts'
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
  executor?: Omit<RunNodeDeps, 'runtime' | 'db' | 'secret'>
  // 执行并发闸：agent 执行是长时间任务，不占写队列的名额，并发上限在这里生效（第二次意见 P1）
  scheduler?: ExecutionScheduler
  // 生产装配读配置的路径；读不到就退回默认并发（并发 3、人工名额 1）
  configPath?: string
}

export type Orchestra = {
  db: Db
  runtime: RuntimeDeps
  catalog: WorkflowCatalog
  commands: NodeCommands
  close: () => void
}

// 只有走完取锁与 epoch 自增的启动链才许可建装配：单写者是启动前提，不是可选装饰（第五轮审计 P1-3）
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
  const executorDeps: RunNodeDeps | null = executor
    ? { runtime, db, secret: opts.secret, ...executor }
    : null
  // 节点执行只有一个底层实现；调度只在装配层包一次（S2 第三十七轮 P0-01）。
  const executeNode = async (p: RunNodeParams): Promise<RunNodeResult> => {
    if (!executorDeps) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑节点', { nodeRunId: p.nodeRunId })
    }
    return runNode(executorDeps, p)
  }
  // 两条入口（/v1/runs/dispatch 与 /v1/node-runs/run）共用这一个带闸函数：
  // 不允许 dispatcher 自己再排一次，否则同一次执行会重复占两个并发名额。
  const executeScheduled = (p: RunNodeParams): Promise<RunNodeResult> =>
    runThroughScheduler(opts.scheduler, () => executeNode(p), { label: p.nodeId })
  const commands: NodeCommands = {
    acquireLease: (b) => acquireNodeRun(runtime, b),
    renewLease: (b) => renewNodeLease(runtime, b),
    report: (b) => submitReport(runtime, b as Parameters<typeof submitReport>[1]),
    cancel: (b) => submitCancel(runtime, { ...b, cancelResult: b.cancelResult as CancelResult }),
    loadWorkflow: (body) => catalog.load(body as Parameters<WorkflowCatalog['load']>[0]),
    createRun: (b) => createRun(db, catalog, {
      taskTitle: b.taskTitle,
      workflowVersion: b.workflowVersion,
      nodeIds: b.nodeIds,
      now: b.now,
    }),
    dispatch: async (b) => {
      if (!opts.executor) {
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能派发节点', { runId: b.runId })
      }
      return dispatchRun({ ...executorDeps!, executeNode: executeScheduled }, {
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
      return executeScheduled({
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
      })
    },
  }
  return {
    db,
    runtime,
    catalog,
    commands,
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
  try {
    const epoch = bumpEpoch(opts.dbFile)
    const db = openServiceDb(opts.dbFile, epoch)
    orchestra = createOrchestra({ ...opts, db }, ORCHESTRA_LOCK_PROOF)
    return {
      orchestra,
      release: async () => {
        orchestra?.close()
        await releaseLock()
      },
    }
  } catch (err) {
    if (orchestra) orchestra.close()
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