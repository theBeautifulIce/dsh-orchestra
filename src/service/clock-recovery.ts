// 跨服务实例的截止锚点恢复（规格 4.4 行 328-342；评审 P1-2 路径 B）
//
// 生产时钟每次 createOrchestra 都拿新的 bootId，持久化的 deadline 在新实例里
// 一律被 decide() 判成 uncertain；没人处理的话 fence、wait timer、动作截止与
// startup_unknown 会永久停住。
//
// 这里的口径：**跨 boot 的剩余量不靠墙钟差值估算**，靠「恢复检查点」——
// 剩余预算在服务存活时按单调钟递减并落库（action/wait/fence/startup_unknown 各一列），
// 重启后按检查点续算：停机不累计，墙钟前跳/回拨都不参与判定。
// 检查点缺失（旧数据或非本模块写入）就是「算不出可信剩余」：显式落 timer_uncertain
// 并置 recovery_uncertain，不自动推进，等宿主或人工处理。
import { deadlineFromSample, type ClockProvider } from '../core/clock.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'

export type ReanchorChannel = 'action_deadline' | 'timing_out_grace' | 'wait_timer' | 'startup_unknown'

export type ReanchorReport = {
  reanchored: string[]
  expired: string[]
  /** 算不出可信剩余的节点：保留原锚点、落 timer_uncertain、等宿主处理 */
  uncertain: string[]
}

/** 各通道的恢复检查点列（纳秒） */
export const CHECKPOINT_COLUMN: Record<ReanchorChannel, string> = {
  action_deadline: 'action_remaining_ns',
  timing_out_grace: 'fence_remaining_ns',
  wait_timer: 'wait_remaining_ns',
  startup_unknown: 'startup_unknown_remaining_ns',
}

/**
 * 跨 boot 剩余量：只认恢复检查点。
 * 检查点缺失 → trusted=false（调用方转人工/宿主，不自动推进）。
 */
export function remainingAfterRestart(
  channel: ReanchorChannel,
  checkpointNs: number | null | undefined,
): { remainingMs: number; trusted: boolean } {
  if (checkpointNs == null || !Number.isFinite(checkpointNs)) return { remainingMs: 0, trusted: false }
  return { remainingMs: Math.max(0, checkpointNs / 1e6), trusted: true }
}

type ChannelRow = {
  node_run_id: string
  deadline_at: string | null
  deadline_boot_id: string | null
  checkpoint_ns: number | null
}

/**
 * 事务内换算：把上一个 boot 写下的锚点改写成当前 boot 的锚点。
 * 必须在读取这些行之前调用；重复调用幂等（换完 boot_id 就等于当前时钟）。
 * skipNodeRunIds 里的节点（如哈希链已断、或已标不确定）一律不动。
 */
export function reanchorInTx(
  tx: Tx,
  secret: string,
  clock: ClockProvider,
  nowIso: string,
  report: ReanchorReport,
  skipNodeRunIds?: ReadonlySet<string>,
): void {
  const skip = (id: string) => skipNodeRunIds?.has(id) === true

  const rebase = (channel: ReanchorChannel, nodeRunId: string, checkpointNs: number | null) => {
    const budget = remainingAfterRestart(channel, checkpointNs)
    if (!budget.trusted) {
      // 算不出可信剩余：不猜、不自动推进，落不确定状态等宿主处理
      report.uncertain.push(nodeRunId)
      appendNodeRunEvent(tx, secret, nodeRunId, 'timer_uncertain', {
        channel,
        reason: 'checkpoint_missing',
        action_required: 'confirm_node_state',
      })
      tx.run(
        'UPDATE node_runs SET recovery_uncertain = ?, recovery_uncertain_at = ? WHERE node_run_id = ?',
        [channel, nowIso, nodeRunId],
      )
      return null
    }
    const deadline = deadlineFromSample(clock, budget.remainingMs)
    report.reanchored.push(nodeRunId)
    appendNodeRunEvent(tx, secret, nodeRunId, 'deadline.reanchored', {
      channel,
      remaining_ms: budget.remainingMs,
      trusted: true,
    })
    return deadline
  }

  // 动作截止
  const actions = tx.all<ChannelRow>(
    "SELECT node_run_id, deadline_at, deadline_boot_id, action_remaining_ns AS checkpoint_ns FROM node_runs WHERE deadline_boot_id IS NOT NULL AND deadline_boot_id != ? AND deadline_at IS NOT NULL AND status NOT IN ('done','failed','failed_with_unverified','succeeded','succeeded_with_unverified','superseded','cancelled','orphaned')",
    [clock.bootId],
  )
  for (const row of actions) {
    if (skip(row.node_run_id)) continue
    const next = rebase('action_deadline', row.node_run_id, row.checkpoint_ns)
    if (!next) continue
    tx.run(
      'UPDATE node_runs SET deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ?, action_remaining_ns = ? WHERE node_run_id = ? AND deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.checkpoint_ns, row.node_run_id, row.deadline_boot_id],
    )
  }

  // 取消宽限
  const fences = tx.all<ChannelRow>(
    "SELECT node_run_id, fence_grace_until AS deadline_at, fence_grace_boot_id AS deadline_boot_id, fence_remaining_ns AS checkpoint_ns FROM node_runs WHERE fence_state = 'armed' AND fence_grace_boot_id IS NOT NULL AND fence_grace_boot_id != ? AND fence_grace_until IS NOT NULL",
    [clock.bootId],
  )
  for (const row of fences) {
    if (skip(row.node_run_id)) continue
    const next = rebase('timing_out_grace', row.node_run_id, row.checkpoint_ns)
    if (!next) continue
    tx.run(
      'UPDATE node_runs SET fence_grace_until = ?, fence_grace_boot_id = ?, fence_grace_monotonic_ns = ?, fence_remaining_ns = ? WHERE node_run_id = ? AND fence_grace_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.checkpoint_ns, row.node_run_id, row.deadline_boot_id],
    )
  }

  // 等待计时
  const waits = tx.all<ChannelRow>(
    "SELECT node_run_id, wait_deadline_at AS deadline_at, wait_deadline_boot_id AS deadline_boot_id, wait_remaining_ns AS checkpoint_ns FROM node_runs WHERE wait_deadline_boot_id IS NOT NULL AND wait_deadline_boot_id != ? AND wait_deadline_at IS NOT NULL AND status = 'waiting'",
    [clock.bootId],
  )
  for (const row of waits) {
    if (skip(row.node_run_id)) continue
    const next = rebase('wait_timer', row.node_run_id, row.checkpoint_ns)
    if (!next) continue
    tx.run(
      'UPDATE node_runs SET wait_deadline_at = ?, wait_deadline_boot_id = ?, wait_deadline_monotonic_ns = ?, wait_remaining_ns = ? WHERE node_run_id = ? AND wait_deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.checkpoint_ns, row.node_run_id, row.deadline_boot_id],
    )
  }

  // startup_unknown 的 watchdog
  const unknowns = tx.all<ChannelRow>(
    "SELECT node_run_id, startup_unknown_deadline_at AS deadline_at, startup_unknown_boot_id AS deadline_boot_id, startup_unknown_remaining_ns AS checkpoint_ns FROM node_runs WHERE status = 'startup_unknown' AND startup_unknown_boot_id IS NOT NULL AND startup_unknown_boot_id != ? AND startup_unknown_deadline_at IS NOT NULL",
    [clock.bootId],
  )
  for (const row of unknowns) {
    if (skip(row.node_run_id)) continue
    const next = rebase('startup_unknown', row.node_run_id, row.checkpoint_ns)
    if (!next) continue
    tx.run(
      'UPDATE node_runs SET startup_unknown_deadline_at = ?, startup_unknown_boot_id = ?, startup_unknown_monotonic_ns = ?, startup_unknown_remaining_ns = ? WHERE node_run_id = ? AND startup_unknown_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.checkpoint_ns, row.node_run_id, row.deadline_boot_id],
    )
  }
}

/**
 * 服务存活时刷新恢复检查点：按当前 boot 的单调钟把剩余预算递减并落库。
 * 只处理本 boot 的行——停机期间没有单调钟可依据，那段时间由检查点天然排除。
 */
export function refreshCheckpointsInTx(tx: Tx, clock: ClockProvider): void {
  const mono = clock.sample().monotonicNs
  const set = (column: string, anchorColumn: string, deadlineColumn: string, extraWhere: string) => {
    const rows = tx.all<{ node_run_id: string; anchor: number | null }>(
      `SELECT node_run_id, ${anchorColumn} AS anchor FROM node_runs WHERE ${anchorColumn} IS NOT NULL AND ${deadlineColumn} IS NOT NULL ${extraWhere}`,
    )
    for (const row of rows) {
      if (row.anchor == null) continue
      const remainingNs = Math.max(0, row.anchor - mono)
      tx.run(`UPDATE node_runs SET ${column} = ? WHERE node_run_id = ? AND ${column} IS NOT NULL`, [remainingNs, row.node_run_id])
    }
  }
  set('action_remaining_ns', 'deadline_monotonic_ns', 'deadline_at', "AND deadline_boot_id = '" + clock.bootId + "'")
  set('wait_remaining_ns', 'wait_deadline_monotonic_ns', 'wait_deadline_at', "AND wait_deadline_boot_id = '" + clock.bootId + "'")
  set('fence_remaining_ns', 'fence_grace_monotonic_ns', 'fence_grace_until', "AND fence_grace_boot_id = '" + clock.bootId + "'")
  set('startup_unknown_remaining_ns', 'startup_unknown_monotonic_ns', 'startup_unknown_deadline_at', "AND startup_unknown_boot_id = '" + clock.bootId + "'")
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
