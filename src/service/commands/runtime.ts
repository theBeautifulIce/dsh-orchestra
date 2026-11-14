// src/service/commands/runtime.ts —— 生产路径的命令装配（规格 12.5 行 1088-1092）
import type { Phase } from '../../core/config.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
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
  decision?: { decisionId: string; revision: number; resolution: 'confirm_applied' | 'confirm_not_applied' | 'uphold_report' | 'uphold_decision' }
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
  return withTx(deps.db, (tx) => applyCancel(tx, deps.secret, { ...p, clock: deps.clock }))
}

// 桥接执行器仍被状态机视为“在跑”的状态；这些节点失联只能由显式信号收口
const BRIDGE_BOUND = ['dispatched', 'started', 'waiting', 'verifying', 'stopping', 'timing_out', 'startup_unknown'] as const
const BRIDGE_SILENCE_MS = 10 * 60_000

/**
 * 生产侧的桥接信号只从持久账本推导：
 * - 有游标但十分钟没推进：桥断，挂起该节点；
 * - paused_bridge_missing 且游标恢复更新：桥回来了；
 * - 从没建立游标且启动已超过十分钟：执行器失联，置 orphaned。
 * 不把“没有事件”直接当成断线，也不拿内存状态猜。
 */
function bridgeSignals(tx: Tx, now: string): { missing: string[]; restored: string[]; lost: string[] } {
  const cutoff = new Date(Date.parse(now) - BRIDGE_SILENCE_MS).toISOString()
  const boundPlaceholders = BRIDGE_BOUND.map(() => '?').join(', ')
  const missing = tx.all<{ node_run_id: string }>(
    'SELECT n.node_run_id FROM node_runs n '
    + 'JOIN bridge_stream_cursors c ON c.node_run_id = n.node_run_id AND c.attempt = n.attempt '
    + `WHERE n.status IN (${boundPlaceholders}) AND n.started_at IS NOT NULL AND n.started_at < ? `
    + 'GROUP BY n.node_run_id HAVING MAX(c.updated_at) < ?',
    [...BRIDGE_BOUND, cutoff, cutoff],
  ).map((r) => r.node_run_id)
  const restored = tx.all<{ node_run_id: string }>(
    'SELECT DISTINCT n.node_run_id FROM node_runs n '
    + 'JOIN bridge_stream_cursors c ON c.node_run_id = n.node_run_id AND c.attempt = n.attempt '
    + "WHERE n.status = 'paused_bridge_missing' AND c.updated_at >= ?",
    [cutoff],
  ).map((r) => r.node_run_id)
  const lost = tx.all<{ node_run_id: string }>(
    'SELECT n.node_run_id FROM node_runs n '
    + 'LEFT JOIN bridge_stream_cursors c ON c.node_run_id = n.node_run_id AND c.attempt = n.attempt '
    + "WHERE n.status IN ('dispatched', 'started') AND c.node_run_id IS NULL "
    + 'AND n.started_at IS NOT NULL AND n.started_at < ?',
    [cutoff],
  ).map((r) => r.node_run_id)
  return { missing, restored, lost }
}

export function sweepNow(deps: RuntimeDeps, now: string): SweepResult {
  const signals = withTx(deps.db, (tx) => bridgeSignals(tx, now))
  return sweep(deps.db, deps.secret, {
    now,
    clock: deps.clock,
    catalog: deps.catalog,
    bridgeMissing: signals.missing,
    bridgeRestored: signals.restored,
    executorLost: signals.lost,
  })
}
