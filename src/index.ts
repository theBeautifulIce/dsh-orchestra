// src/index.ts —— DSH 插件入口 + 生产装配（规格 12.5 行 1088-1092）
import { openDb, type Db } from './infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from './infra/db/migrate.ts'
import { nullLogger, type Logger } from './infra/logger.ts'
import { WorkflowCatalog } from './service/workflows.ts'
import type { NodeCommands, ServerDeps } from './service/server.ts'
import { startServer } from './service/server.ts'
import {
  acquireNodeRun, renewNodeLease, submitCancel, submitReport, sweepNow, type RuntimeDeps,
} from './service/commands/runtime.ts'
import type { Phase } from './core/config.ts'
import type { CancelResult } from './service/commands/cancel.ts'

export const name = 'dsh-orchestra'
export const version = '0.1.0'

export type OrchestraOptions = {
  dbFile: string
  secret: string
  phase: Phase
  log?: Logger
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
  const runtime: RuntimeDeps = { db, secret: opts.secret, phase: opts.phase, catalog }
  const commands: NodeCommands = {
    acquireLease: (b) => acquireNodeRun(runtime, b),
    report: (b) => submitReport(runtime, b as Parameters<typeof submitReport>[1]),
    cancel: (b) => submitCancel(runtime, { ...b, cancelResult: b.cancelResult as CancelResult }),
    loadWorkflow: (body) => catalog.load(body as Parameters<WorkflowCatalog['load']>[0]),
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
  const server = await startServer({
    secret: opts.secret,
    phase: opts.phase,
    epoch: orchestra.db.epoch,
    asOfSeq: opts.asOfSeq,
    listTasks: opts.listTasks,
    listEvents: opts.listEvents,
    appendLedgerEvent: opts.appendLedgerEvent,
    commands: orchestra.commands,
    log: opts.log ?? nullLogger,
  })
  return {
    orchestra,
    endpoint: server.endpoint,
    close: async () => { await server.close(); orchestra.close() },
  }
}

export { renewNodeLease, sweepNow, submitReport }
