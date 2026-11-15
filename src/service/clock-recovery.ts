// 跨服务实例的截止锚点恢复（规格 4.4 行 328-342）
//
// 生产时钟每次 createOrchestra 都拿新的 bootId，持久化的 deadline 在新实例里
// 一律被 decide() 判成 uncertain；如果没人处理，fence、wait timer 与 action deadline
// 会永久停住（sweep 只会 continue）。这里在启动与每轮扫描开始时把旧锚点换算成
// 新时钟的锚点：预算按规格里的通道策略重算，换算过程留事件，算不出就显式报不确定。
import { deadlineFromSample, type ClockProvider } from '../core/clock.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'

export type ReanchorChannel = 'action_deadline' | 'timing_out_grace' | 'wait_timer'

export type ReanchorReport = {
  reanchored: string[]
  expired: string[]
  uncertain: string[]
}

type ActionRow = { node_run_id: string; deadline_at: string; deadline_boot_id: string }
type FenceRow = { node_run_id: string; fence_grace_until: string; fence_grace_boot_id: string; fence_armed_at: string | null }
type WaitRow = { node_run_id: string; wait_deadline_at: string; wait_deadline_boot_id: string }

// 通道策略：动作截止与 wait 计时按「继续走」算，停机时间计入预算；
// 取消宽限按「停机不累计」算，重启后重新给满额（规格 4.4 行 342）。
export function remainingAfterRestart(
  channel: ReanchorChannel,
  row: { deadlineAt: string; armedAt?: string | null },
  nowIso: string,
): number {
  if (channel === 'timing_out_grace' && row.armedAt) {
    return Math.max(0, Date.parse(row.deadlineAt) - Date.parse(row.armedAt))
  }
  return Math.max(0, Date.parse(row.deadlineAt) - Date.parse(nowIso))
}

const TERMINAL = "'done','failed','failed_with_unverified','succeeded','succeeded_with_unverified','superseded','cancelled','orphaned'"

/**
 * 事务内换算：把上一个 boot 写下的锚点改写成当前 boot 的锚点。
 * 必须在读取这些行之前调用；重复调用幂等（换完 boot_id 就等于当前时钟）。
 */
export function reanchorInTx(
  tx: Tx,
  secret: string,
  clock: ClockProvider,
  nowIso: string,
  report: ReanchorReport,
): void {
  const rebase = (channel: ReanchorChannel, nodeRunId: string, remainingMs: number) => {
    const deadline = deadlineFromSample(clock, remainingMs)
    report.reanchored.push(nodeRunId)
    if (remainingMs <= 0) report.expired.push(nodeRunId)
    appendNodeRunEvent(tx, secret, nodeRunId, 'deadline.reanchored', {
      channel,
      remaining_ms: remainingMs,
      expired: remainingMs <= 0,
    })
    return deadline
  }

  const actions = tx.all<ActionRow>(
    'SELECT node_run_id, deadline_at, deadline_boot_id FROM node_runs WHERE deadline_boot_id IS NOT NULL AND deadline_boot_id != ? AND deadline_at IS NOT NULL AND status NOT IN (' + TERMINAL + ')',
    [clock.bootId],
  )
  for (const row of actions) {
    if (Number.isNaN(Date.parse(row.deadline_at))) {
      report.uncertain.push(row.node_run_id)
      continue
    }
    const remaining = remainingAfterRestart('action_deadline', { deadlineAt: row.deadline_at }, nowIso)
    const next = rebase('action_deadline', row.node_run_id, remaining)
    tx.run(
      'UPDATE node_runs SET deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ? WHERE node_run_id = ? AND deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.node_run_id, row.deadline_boot_id],
    )
  }

  const fences = tx.all<FenceRow>(
    "SELECT node_run_id, fence_grace_until, fence_grace_boot_id, fence_armed_at FROM node_runs WHERE fence_state = 'armed' AND fence_grace_boot_id IS NOT NULL AND fence_grace_boot_id != ? AND fence_grace_until IS NOT NULL",
    [clock.bootId],
  )
  for (const row of fences) {
    const remaining = remainingAfterRestart(
      'timing_out_grace',
      { deadlineAt: row.fence_grace_until, armedAt: row.fence_armed_at },
      nowIso,
    )
    const next = rebase('timing_out_grace', row.node_run_id, remaining)
    tx.run(
      'UPDATE node_runs SET fence_grace_until = ?, fence_grace_boot_id = ?, fence_grace_monotonic_ns = ? WHERE node_run_id = ? AND fence_grace_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.node_run_id, row.fence_grace_boot_id],
    )
  }

  const waits = tx.all<WaitRow>(
    "SELECT node_run_id, wait_deadline_at, wait_deadline_boot_id FROM node_runs WHERE wait_deadline_boot_id IS NOT NULL AND wait_deadline_boot_id != ? AND wait_deadline_at IS NOT NULL AND status = 'waiting'",
    [clock.bootId],
  )
  for (const row of waits) {
    const remaining = remainingAfterRestart('wait_timer', { deadlineAt: row.wait_deadline_at }, nowIso)
    const next = rebase('wait_timer', row.node_run_id, remaining)
    tx.run(
      'UPDATE node_runs SET wait_deadline_at = ?, wait_deadline_boot_id = ?, wait_deadline_monotonic_ns = ? WHERE node_run_id = ? AND wait_deadline_boot_id = ?',
      [new Date(next.wallClockMs).toISOString(), next.bootId, next.monotonicNs, row.node_run_id, row.wait_deadline_boot_id],
    )
  }
}

/** 服务启动时调用一次：没有旧锚点时是空操作 */
export function reanchorDeadlinesOnBoot(
  db: Db,
  secret: string,
  clock: ClockProvider,
  nowIso: string,
): ReanchorReport {
  const report: ReanchorReport = { reanchored: [], expired: [], uncertain: [] }
  inTx(db, (tx) => reanchorInTx(tx, secret, clock, nowIso, report))
  return report
}
