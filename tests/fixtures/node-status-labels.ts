import { NON_TERMINAL_STATUSES, TERMINAL_STATUSES, type NodeStatus } from '../../src/core/state-machine.ts'

const labels = {
  queued: '排队中还没派给执行者',
  leased: '已分到执行位，等执行者接手',
  dispatched: '已派出，等执行者启动',
  started: '已开跑，等回写',
  waiting: '等外部条件',
  verifying: '等验证',
  timing_out: '已请求停止，正在确认停没停',
  stopping: '已请求停止，动作可能还在跑',
  startup_unknown: '启动情况不明——可能没开跑，也可能已开跑',
  paused_bridge_missing: '桥断了，先暂停跟踪',
  blocked_pre: '执行前被挡住，等人处理',
  blocked_post: '执行完了，结果等人定',
  indeterminate_side_effect: '操作已停止，外部影响待核验',
  done: '已完成',
  failed: '没做成',
  timeout: '超时收口',
  abandoned_unverified: '已停止跟踪，外部影响待核验',
  failed_with_unverified: '执行失败，外部影响待核验',
  orphaned: '没有新 attempt 接手',
  superseded: '本次尝试已停止',
} satisfies Record<NodeStatus, string>

export const NODE_STATUS_LABELS = [...NON_TERMINAL_STATUSES, ...TERMINAL_STATUSES].map((status) =>
  ({ status, status_label: labels[status] }),
)
