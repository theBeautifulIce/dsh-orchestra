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
import { runNode, DEFAULT_LEASE_TTL_MS, type RunNodeDeps } from './executor/run-node.ts'
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
}

export type Orchestra = {
  db: Db
  runtime: RuntimeDeps
  catalog: WorkflowCatalog
  commands: NodeCommands
  close: () => void
}

// 生产装配：一个进程一个写者，迁移在打开时跑完，命令统一走 runtime
export function createOrchestra(opts: OrchestraOptions & { db?: Db }): Orchestra {
  // 生产装配走 openServiceOrchestra：那里已经拿过文件锁并递增过 epoch（第四轮审计 M3）
  const db = opts.db ?? openDb(opts.dbFile)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  const catalog = new WorkflowCatalog(opts.phase)
  // 生产时钟：墙钟与单调钟同时取样，漂移超过 2 秒就判不确定（规格 3.4 行 171）
  const clock = new SystemClock(randomUUID())
  const runtime: RuntimeDeps = { db, secret: opts.secret, phase: opts.phase, catalog, clock }
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
      return dispatchRun({ runtime, db, secret: opts.secret, ...opts.executor }, {
        runId: b.runId,
        nodes: b.nodes,
        now: b.now,
        ownerEpoch: b.ownerEpoch ?? db.epoch,
        leaseTtlMs: b.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      })
    },
    runNode: async (b) => {
      if (!opts.executor) {
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '执行器没有装配，不能跑节点', { nodeRunId: b.nodeRunId })
      }
      return runNode({ runtime, db, secret: opts.secret, ...opts.executor }, {
        nodeRunId: b.nodeRunId,
        nodeId: b.nodeId,
        attempt: b.attempt,
        input: b.input ?? {},
        outputSchema: b.outputSchema ?? {},
        toolPolicy: b.toolPolicy,
        tools: b.tools,
        now: b.now,
        ownerEpoch: b.ownerEpoch ?? db.epoch,
        leaseTtlMs: b.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
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
    orchestra = createOrchestra({ ...opts, db })
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
  // 服务启动顺序固定：文件锁 → epoch → 打开服务库 → 迁移 → 起服务（第四轮审计 M3）
  const service = await openServiceOrchestra(opts)
  const orchestra = service.orchestra
  const log = opts.log ?? nullLogger
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
    close: async () => { clearInterval(sweepTimer); await server.close(); await service.release() },
  }
}

export { renewNodeLease, runNode, sweepNow, submitReport }
