// 恢复不确定的节点：宿主查得到、能处理的状态（评审 P2-4）
// 只读查询：不改账本，供面板/运维列出「算不出可信剩余、扫描已停止推进」的节点。
import type { Db } from '../../infra/sqlite/driver.ts'

type ChannelColumns = {
  deadline: string
  boot: string
  monotonic: string
  checkpoint: string
}

/** 每个恢复通道在 node_runs 上的锚点列；与 clock-recovery 的 CHECKPOINT_COLUMN 保持一致 */
export const RECOVERY_CHANNEL_COLUMNS: Record<string, ChannelColumns> = {
  action_deadline: { deadline: 'deadline_at', boot: 'deadline_boot_id', monotonic: 'deadline_monotonic_ns', checkpoint: 'action_remaining_ns' },
  timing_out_grace: { deadline: 'fence_grace_until', boot: 'fence_grace_boot_id', monotonic: 'fence_grace_monotonic_ns', checkpoint: 'fence_remaining_ns' },
  wait_timer: { deadline: 'wait_deadline_at', boot: 'wait_deadline_boot_id', monotonic: 'wait_deadline_monotonic_ns', checkpoint: 'wait_remaining_ns' },
  startup_unknown: { deadline: 'startup_unknown_deadline_at', boot: 'startup_unknown_boot_id', monotonic: 'startup_unknown_monotonic_ns', checkpoint: 'startup_unknown_remaining_ns' },
}

export type RecoveryUncertainItem = {
  node_run_id: string
  run_id: string
  node_id: string
  status: string
  attempt: number
  revision: number
  /** 算不出可信剩余的通道；旧数据可能为空 */
  channel: string | null
  /** 标记时间（recovery_uncertain_at） */
  since: string | null
  deadline_at: string | null
  deadline_boot_id: string | null
  deadline_monotonic_ns: number | null
  checkpoint_ns: number | null
  /** 检查点换算出的剩余毫秒；不可信，仅供展示 */
  remaining_ms_estimate: number
  /** 估算是否可信：这一列永远是 false，宿主不能拿它当到期依据 */
  remaining_trusted: false
  /** 需要宿主做的事：确认节点状态后调用 /v1/recovery/resolve */
  action_required: 'confirm_node_state'
}

type Row = Record<string, string | number | null>

export function listRecoveryUncertain(db: Db): RecoveryUncertainItem[] {
  const columns = new Set(['node_run_id', 'run_id', 'node_id', 'status', 'attempt', 'revision', 'recovery_uncertain', 'recovery_uncertain_at'])
  for (const c of Object.values(RECOVERY_CHANNEL_COLUMNS)) {
    columns.add(c.deadline); columns.add(c.boot); columns.add(c.monotonic); columns.add(c.checkpoint)
  }
  const rows = db.raw.prepare(
    'SELECT ' + [...columns].join(', ') + ' FROM node_runs WHERE recovery_uncertain IS NOT NULL ORDER BY recovery_uncertain_at ASC, node_run_id ASC',
  ).all() as Row[]
  return rows.map((row) => {
    const channel = typeof row.recovery_uncertain === 'string' ? row.recovery_uncertain : null
    const cols = channel ? RECOVERY_CHANNEL_COLUMNS[channel] : undefined
    const checkpoint = cols ? row[cols.checkpoint] : null
    const checkpointNs = typeof checkpoint === 'number' ? checkpoint : null
    return {
      node_run_id: String(row.node_run_id),
      run_id: String(row.run_id),
      node_id: String(row.node_id),
      status: String(row.status),
      attempt: Number(row.attempt),
      revision: Number(row.revision),
      channel,
      since: row.recovery_uncertain_at === null ? null : String(row.recovery_uncertain_at),
      deadline_at: cols && row[cols.deadline] !== null ? String(row[cols.deadline]) : null,
      deadline_boot_id: cols && row[cols.boot] !== null ? String(row[cols.boot]) : null,
      deadline_monotonic_ns: cols && typeof row[cols.monotonic] === 'number' ? Number(row[cols.monotonic]) : null,
      checkpoint_ns: checkpointNs,
      remaining_ms_estimate: checkpointNs === null ? 0 : Math.max(0, checkpointNs / 1e6),
      remaining_trusted: false,
      action_required: 'confirm_node_state',
    }
  })
}
