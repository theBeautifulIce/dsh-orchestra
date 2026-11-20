import type { NodeRunView } from '../api/types.ts'
import { operatorReason, operatorStatus } from '../../core/operator-language.ts'

export const ACTIVE_NODE_STATES = new Set(['leased', 'dispatched', 'started', 'verifying', 'stopping', 'timing_out'])
export const BLOCKED_NODE_STATES = new Set(['blocked_pre', 'blocked_post', 'indeterminate_side_effect', 'startup_unknown', 'paused_bridge_missing'])
const FAILED = new Set(['failed', 'timeout', 'orphaned'])
const UNVERIFIED = new Set(['failed_with_unverified', 'abandoned_unverified'])

const QUEUE_PHASES: Record<string, { label: string; tone: string }> = {
  waiting_capacity: { label: '等待执行位', tone: 'waiting' },
  waiting_dependencies: { label: '等待上游完成', tone: 'waiting' },
  blocked_dependencies: { label: '上游失败，步骤受阻', tone: 'blocked' },
  ready: { label: '就绪待派发', tone: 'waiting' },
  paused: { label: '已暂停', tone: 'blocked' },
  queued_unknown: { label: '排队原因未知', tone: 'waiting' },
  cancelled: { label: '已取消', tone: 'waiting' },
}

type NodeStatus = Pick<NodeRunView, 'status' | 'status_label' | 'execution_state'> & Partial<Pick<NodeRunView, 'replacement_node_run_id'>>

const STEP_STATUS = new Map([
  ['verifying', '核验中'],
  ['blocked_post', '执行结束，待人工处理'],
  ['orphaned', '执行者失联，尚未接手'],
])

function supersededLabel(node: NodeStatus): string {
  return node.replacement_node_run_id ? '已由新尝试接替' : '本次尝试已停止'
}

export function executionState(node: NodeStatus): string {
  return node.execution_state ?? node.status
}

export function nodeExecutionPhase(node: NodeStatus | null): { label: string; tone: string } {
  if (!node) return { label: '未运行', tone: 'waiting' }
  const state = executionState(node)
  if (Object.hasOwn(QUEUE_PHASES, state)) return QUEUE_PHASES[state]!
  if (state === 'done') return { label: '已完成', tone: 'done' }
  if (BLOCKED_NODE_STATES.has(state)) return { label: '待处理', tone: 'blocked' }
  if (ACTIVE_NODE_STATES.has(state)) return { label: state === 'verifying' ? '核验中' : '进行中', tone: 'active' }
  if (UNVERIFIED.has(state)) return { label: '待核实', tone: 'blocked' }
  if (FAILED.has(state)) return { label: '未成功', tone: 'failed' }
  if (state === 'queued') return { label: '等待调度', tone: 'waiting' }
  if (state === 'waiting') return { label: '等待条件', tone: 'waiting' }
  if (state === 'superseded') return { label: supersededLabel(node), tone: 'waiting' }
  return { label: operatorStatus(state), tone: 'waiting' }
}

export function nodeExecutionLabel(node: NodeStatus): string {
  const state = node.execution_state
  return (state && Object.hasOwn(QUEUE_PHASES, state) ? QUEUE_PHASES[state]!.label : undefined)
    ?? (node.status === 'superseded' ? supersededLabel(node) : STEP_STATUS.get(node.status))
    ?? (/\p{Script=Han}/u.test(node.status_label) ? operatorReason(node.status_label) : operatorStatus(node.status))
}

/** Only the persisted execution projection identifies which predecessors are still blocking a node. */
export function waitingFor(node: NodeRunView, titles: ReadonlyMap<string, string>): string | undefined {
  if (!node.waiting_on?.length) return undefined
  const names = [...new Set(node.waiting_on)].map((id) => titles.get(id) || '未命名步骤').join('、')
  if (node.execution_state === 'waiting_dependencies') return `等待：${names}`
  if (node.execution_state === 'blocked_dependencies') return `上游未成功：${names}`
  return `待核对的上游：${names}`
}
