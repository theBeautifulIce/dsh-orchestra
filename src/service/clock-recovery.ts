// 跨服务实例的截止锚点恢复（规格 4.4 行 328-342）
//
// 生产时钟每次 createOrchestra 都拿新的 bootId，持久化的 deadline 在新实例里
// 一律被 decide() 判成 uncertain；如果没人处理，fence、wait timer、动作截止与
// startup_unknown 会永久停住。这里在扫描读取这些行之前把旧锚点换算成当前时钟：
// 预算按通道策略重算，换算过程留事件，算不出就显式报不确定，绝不静默跳过。
import { deadlineFromSample, type ClockProvider } from '../core/clock.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'

export type ReanchorChannel = 'action_deadline' | 'timing_out_grace' | 'wait_timer' | 'startup_unknown'

export type ReanchorReport = {
  reanchored: string[]
  expired: string[]
  /** 无法可靠换算的节点：保留原锚点，写 timer_uncertain 事件，交宿主/人工处理 */
  uncertain: string[]
}

// 跨 boot 的剩余量只能从墙钟差值估算，不可信：估出「已到期」时不能直接放行超时，
// 先给一小段确认窗口并落 timer_uncertain，让真正的超时晚一拍到、而不是被墙钟跳变误杀。
export const CLOCK_RECOVERY_CONFIRM_MS = 30_000

type AnchoredRow = {
  node_run_id: string
  deadline_at: string | null
  deadline_boot_id: string | null
}

// 通道策略：动作截止与 wait 计时按「继续走」算；startup_unknown 用冻结剩余量
// （规格 4.4 的 unknown_watchdog = freeze）；取消宽限重锚后把 armed_at 推到当前，
// 避免每次重启都拿最初的 armed_at 重新放大预算。
export function remainingAfterRestart(
  channel: ReanchorChannel,
  row: { deadlineAt: string; armedAt?: string | null; frozenRemainingMs?: number | null },
  nowIso: string,
): { remainingMs: number; trusted: boolean } {
  const now = Date.parse(nowIso)
  const at = Date.parse(row.deadlineAt)
  if (channel === 'startup_unknown' && row.frozenRemainingMs != null) {
    return { remainingMs: Math.max(0, row.frozenRemainingMs), trusted: true }
  }
  if (Number.isNaN(at) || Number.isNaN(now)) return { remainingMs: 0, trusted: false }
  // 跨 boot 的墙钟差值只能当估算：前跳可能把没到期的计时器算成已到期。
  return { remainingMs: Math.max(0, at - now), trusted: false }
}

const TERMINAL = "'done','failed','failed_with_unverified','succeeded','succeeded_with_unverified','superseded','cancelled','orphaned'"

/**
 * 事务内换算：把上一个 boot 写下的锚点改写成当前 boot 的锚点。
 * 必须在读取这些行之前调用；重复调用幂等（换完 boot_id 就等于当前时钟）。
 * skipNodeRunIds 里的节点（如哈希链已断）一律不动：坏账本不许被恢复动作往前推。
 */
export function reanchorInTx(
  tx: Tx,
  secret: string,
  clock: ClockProvider,
  nowIso: string,
  report: ReanchorReport,
  skipNodeRunIds?: ReadonlySet<string>,
): void {
  const rebase = (channel: ReanchorChannel, nodeRunId: string, budget: { remainingMs: number; trusted: boolean }) => {
    // 不可信的「已到期」不许直接放行：给确认窗口，避免墙钟跳变误杀计时器。
    const useMs = (!budget.trusted && budget.remainingMs <= 0) ? CLOCK_RECOVERY_CONFIRM_MS : budget.remainingMs
    if (!budget.trusted && budget.remainingMs <= 0) {
      report.uncertain.push(nodeRunId)
      appendNodeRunEvent(tx, secret, nodeRunId, 'timer_uncertain', {
        channel,
        reason: 'wall_clock_estimate_expired',
        confirm_ms: CLOCK_RECOVERY_CONFIRM_MS,
      })
    }
    const deadline = deadlineFromSample(clock, useMs)
    report.reanchored.push(nodeRunId)
    if (budget.remainingMs <= 0 && budget.trusted) report.expired.push(nodeRunId)
    appendNodeRunEvent(tx, secret, nodeRunId, 'deadline.reanchored', {
      channel,
      remaining_ms: useMs,
      trusted: budget.trusted,
      expired: budget.trusted && budget.remainingMs <= 0,
    })
    return deadline
  }
  const skip = (id: string) => skipNodeRunIds?.has(id) === true

  const actions = tx.all<AnchoredRow>(
    'SELECT node_run_id, deadline_at, deadline_boot_id FROM node_runs WHERE deadline_boot_id IS NOT NULL AND deadline_boot_id != ? AND deadline_at IS NOT NULL AND status NOT IN (' + TERMINAL + ')',
    [clock.bootId],
  )
  for (const row of actions) {
    if (skip(row.node_run_id)) continue
    const budget = remainingAfterRestart('action_deadline', { deadlineAt: row.deadline_at! }, nowIso)
    const next = rebase('action_deadline', row.node_run_id, budget)
    tx.run(
      'UPDATE node_runs SET deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ? WHERE node_run_id = ? AND deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.node_run_id, row.deadline_boot_id],
    )
  }

  type FenceRow = AnchoredRow & { fence_armed_at: string | null }
  const fences = tx.all<FenceRow>(
    "SELECT node_run_id, fence_grace_until AS deadline_at, fence_grace_boot_id AS deadline_boot_id, fence_armed_at FROM node_runs WHERE fence_state = 'armed' AND fence_grace_boot_id IS NOT NULL AND fence_grace_boot_id != ? AND fence_grace_until IS NOT NULL",
    [clock.bootId],
  )
  for (const row of fences) {
    if (skip(row.node_run_id)) continue
    const budget = remainingAfterRestart('timing_out_grace', { deadlineAt: row.deadline_at!, armedAt: row.fence_armed_at }, nowIso)
    const next = rebase('timing_out_grace', row.node_run_id, budget)
    // armed_at 推到当前：下一次重启拿新 pair 算剩余，不会把最初的 30s 反复放大
    tx.run(
      'UPDATE node_runs SET fence_grace_until = ?, fence_grace_boot_id = ?, fence_grace_monotonic_ns = ?, fence_armed_at = ? WHERE node_run_id = ? AND fence_grace_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, nowIso, row.node_run_id, row.deadline_boot_id],
    )
  }

  const waits = tx.all<AnchoredRow>(
    "SELECT node_run_id, wait_deadline_at AS deadline_at, wait_deadline_boot_id AS deadline_boot_id FROM node_runs WHERE wait_deadline_boot_id IS NOT NULL AND wait_deadline_boot_id != ? AND wait_deadline_at IS NOT NULL AND status = 'waiting'",
    [clock.bootId],
  )
  for (const row of waits) {
    if (skip(row.node_run_id)) continue
    const budget = remainingAfterRestart('wait_timer', { deadlineAt: row.deadline_at! }, nowIso)
    const next = rebase('wait_timer', row.node_run_id, budget)
    tx.run(
      'UPDATE node_runs SET wait_deadline_at = ?, wait_deadline_boot_id = ?, wait_deadline_monotonic_ns = ? WHERE node_run_id = ? AND wait_deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.node_run_id, row.deadline_boot_id],
    )
  }

  // startup_unknown（unknown_watchdog）：冻结剩余量优先，其次用墙钟估算（S2/S3 r64 P1-2）
  type UnknownRow = AnchoredRow & { startup_unknown_remaining_ns: number | null }
  const unknowns = tx.all<UnknownRow>(
    "SELECT node_run_id, startup_unknown_deadline_at AS deadline_at, startup_unknown_boot_id AS deadline_boot_id, startup_unknown_remaining_ns FROM node_runs WHERE status = 'startup_unknown' AND startup_unknown_boot_id IS NOT NULL AND startup_unknown_boot_id != ? AND startup_unknown_deadline_at IS NOT NULL",
    [clock.bootId],
  )
  for (const row of unknowns) {
    if (skip(row.node_run_id)) continue
    const frozenMs = row.startup_unknown_remaining_ns == null ? null : row.startup_unknown_remaining_ns / 1e6
    const budget = remainingAfterRestart('startup_unknown', { deadlineAt: row.deadline_at!, frozenRemainingMs: frozenMs }, nowIso)
    const next = rebase('startup_unknown', row.node_run_id, budget)
    tx.run(
      'UPDATE node_runs SET startup_unknown_deadline_at = ?, startup_unknown_boot_id = ?, startup_unknown_monotonic_ns = ?, startup_unknown_remaining_ns = ? WHERE node_run_id = ? AND startup_unknown_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, budget.trusted ? row.startup_unknown_remaining_ns : null, row.node_run_id, row.deadline_boot_id],
    )
  }
}

/** 服务启动时调用一次：没有旧锚点时是空操作 */
export function reanchorDeadlinesOnBoot(
  db: Db,
  secret: string,
  clock: ClockProvider,
  nowIso: string,
  skipNodeRunIds?: ReadonlySet<string>,
): ReanchorReport {
  const report: ReanchorReport = { reanchored: [], expired: [], uncertain: [] }
  inTx(db, (tx) => reanchorInTx(tx, secret, clock, nowIso, report, skipNodeRunIds))
  return report
}
