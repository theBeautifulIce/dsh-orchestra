// src/service/commands/runtime.ts —— 生产路径的命令装配（规格 12.5 行 1088-1092）
import type { Phase } from '../../core/config.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withTx } from '../../infra/sqlite/driver.ts'
import type { Report } from '../../core/report.ts'
import { applyCancel, type CancelOutcome, type CancelResult } from './cancel.ts'
import { applyReport } from './apply-report.ts'
import type { ApplyResult } from '../../core/report.ts'
import { acquireLease, renewLease } from './lease.ts'
import { sweep, type SweepResult } from '../sweep.ts'
import type { WorkflowCatalog } from '../workflows.ts'
import type { ClockProvider } from '../../core/clock.ts'

export type RuntimeDeps = {
  db: Db
  secret: string
  phase: Phase
  catalog: WorkflowCatalog
  // 判定用的时钟：生产用系统时钟，测试与注入脚本用可编排时钟（规格 3.4 行 171）
  clock?: ClockProvider
}

export type AcquireNodeRunResult = { lease_id: string; expires_at: string; action_generation: number }

export function acquireNodeRun(deps: RuntimeDeps, p: { nodeRunId: string; ownerEpoch: number; leaseTtlMs: number; now: string }): AcquireNodeRunResult {
  return withTx(deps.db, (tx) => {
    const out = acquireLease(tx, deps.secret, p)
    return { lease_id: out.leaseId, expires_at: out.expiresAt, action_generation: out.actionGeneration }
  })
}

export function renewNodeLease(deps: RuntimeDeps, p: { nodeRunId: string; leaseTtlMs: number; now: string }): { expires_at: string } {
  return withTx(deps.db, (tx) => ({ expires_at: renewLease(tx, p) }))
}

// 判定条件由服务端按 run 上的 workflow_version 取，请求体里带不了（规格 6.1 行 839）
export function submitReport(deps: RuntimeDeps, p: {
  nodeRunId: string
  attempt: number
  report: Report
  expectedStatus: string
  generation: number
  now: string
}): ApplyResult {
  // 判定条件由 applyReport 自己按 run 绑定的工作流版本取，命令层不再经手（审计 M5）
  return withTx(deps.db, (tx) => applyReport(tx, deps.secret, p, deps.catalog))
}

export function submitCancel(deps: RuntimeDeps, p: {
  nodeRunId: string
  attempt: number
  revision: number
  cancelResult: CancelResult
  now: string
  graceMs: number
  extendDeadlineMs?: number
}): CancelOutcome {
  return withTx(deps.db, (tx) => applyCancel(tx, deps.secret, p))
}

export function sweepNow(deps: RuntimeDeps, now: string): SweepResult {
  return sweep(deps.db, deps.secret, { now, clock: deps.clock })
}
