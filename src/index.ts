// src/index.ts —— DSH 插件入口 + 生产装配（规格 12.5 行 1088-1092）
import { OrchError } from './core/errors.ts'
import { openDb, type Db } from './infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from './infra/db/migrate.ts'
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
import { runNode, type RunNodeDeps } from './executor/run-node.ts'
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
export function createOrchestra(opts: OrchestraOptions): Orchestra {
  const db = openDb(opts.dbFile)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  const catalog = new WorkflowCatalog(opts.phase)
  // 生产时钟：墙钟与单调钟同时取样，漂移超过 2 秒就判不确定（规格 3.4 行 171）
  const clock = new SystemClock(randomUUID())
  const runtime: RuntimeDeps = { db, secret: opts.secret, phase: opts.phase, catalog, clock }
  const commands: NodeCommands = {
    acquireLease: (b) => acquireNodeRun(runtime, b),
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
        leaseTtlMs: b.leaseTtlMs ?? 600000,
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
        leaseTtlMs: b.leaseTtlMs ?? 600000,
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

// 供宿主接进 DSH：返回 endpoint 与关闭句柄
export async function serveOrchestra(opts: OrchestraOptions & {
  asOfSeq: ServerDeps['asOfSeq']
  listTasks: ServerDeps['listTasks']
  listEvents: ServerDeps['listEvents']
  appendLedgerEvent: ServerDeps['appendLedgerEvent']
}): Promise<{ orchestra: Orchestra; endpoint: string; close: () => Promise<void> }> {
  const orchestra = createOrchestra(opts)
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
  const server = await startServer({
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
  return {
    orchestra,
    endpoint: server.endpoint,
    close: async () => { clearInterval(sweepTimer); await server.close(); orchestra.close() },
  }
}

export { renewNodeLease, runNode, sweepNow, submitReport }
