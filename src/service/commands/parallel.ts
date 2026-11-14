// src/service/commands/parallel.ts —— 并行扇出与汇聚（规格 3.3 行 153、5.7 行 500-505）
import { OrchError } from '../../core/errors.ts'
import { isTerminal } from '../../core/state-machine.ts'
import { assertNoOpenChildRuns } from './subworkflow.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'

export type JoinMode = 'all' | 'any' | 'quorum'
export type SideEffectPolicy = 'pure' | 'compensable' | 'irreversible'

export type ParallelGroup = {
  nodeRunId: string
  mode: JoinMode
  // quorum 缺省为过半数；显式值必须落在 1..子节点数
  quorum?: number
  childNodeRunIds: readonly string[]
  // 默认 false：加载期和运行期都不许把不可逆子节点塞进组里
  allowIrreversibleChildren: boolean
}

export type ParallelChild = {
  nodeRunId: string
  status: string
  sideEffectPolicy: SideEffectPolicy
}

export type ParallelGroupState = {
  settled: boolean
  pendingIrreversible: string[]
  // 组内还有未收口的不可逆子节点时，父运行只能留在 settling
  settling: boolean
}

function ownChildren(group: ParallelGroup, children: readonly ParallelChild[]): ParallelChild[] {
  if (group.childNodeRunIds.length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'parallel 组没有子节点', { nodeRunId: group.nodeRunId })
  }
  const wanted = new Set(group.childNodeRunIds)
  const own = children.filter((child) => wanted.has(child.nodeRunId))
  if (own.length !== wanted.size) {
    const got = new Set(own.map((child) => child.nodeRunId))
    throw new OrchError('NOT_FOUND', 'parallel 子节点不全', {
      nodeRunId: group.nodeRunId,
      missing: group.childNodeRunIds.filter((id) => !got.has(id)),
    })
  }
  return own
}

function quorumOf(group: ParallelGroup, total: number): number {
  const need = group.quorum ?? Math.floor(total / 2) + 1
  if (!Number.isInteger(need) || need < 1 || need > total) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'parallel quorum 超出子节点范围', {
      nodeRunId: group.nodeRunId,
      quorum: group.quorum,
      total,
    })
  }
  return need
}

/** 汇聚条件：all 全部终态；any 任一 done；quorum 的配额只认 done。 */
export function isGroupSettled(group: ParallelGroup, children: readonly ParallelChild[]): boolean {
  const own = ownChildren(group, children)
  if (group.mode === 'any') return own.some((child) => child.status === 'done')
  if (group.mode === 'quorum') {
    return own.filter((child) => child.status === 'done').length >= quorumOf(group, own.length)
  }
  return own.every((child) => isTerminal(child.status))
}

/**
 * 派生未收口的不可逆子节点。它们不因为 any/quorum 先收敛而消失：
 * 父运行只有在集合清空后才允许进终态。
 */
export function pendingIrreversibleChildren(
  group: ParallelGroup,
  children: readonly ParallelChild[],
): string[] {
  return ownChildren(group, children)
    .filter((child) => child.sideEffectPolicy === 'irreversible' && !isTerminal(child.status))
    .map((child) => child.nodeRunId)
    .sort()
}

export function deriveGroupState(group: ParallelGroup, children: readonly ParallelChild[]): ParallelGroupState {
  const pendingIrreversible = pendingIrreversibleChildren(group, children)
  return {
    settled: isGroupSettled(group, children),
    pendingIrreversible,
    settling: pendingIrreversible.length > 0,
  }
}

/** 组里出现不可逆子节点时，只有显式 allow 才放行；不会靠默认值蒙混。 */
export function assertIrreversibleChildrenAllowed(
  group: ParallelGroup,
  children: readonly ParallelChild[],
): void {
  const blocked = ownChildren(group, children)
    .filter((child) => child.sideEffectPolicy === 'irreversible')
    .map((child) => child.nodeRunId)
  if (blocked.length > 0 && !group.allowIrreversibleChildren) {
    throw new OrchError('FORBIDDEN', 'parallel 组含不可逆子节点，默认不许', {
      nodeRunId: group.nodeRunId,
      children: blocked,
    })
  }
}

/** 取消分级：不可逆子节点一律不碰；pure/compensable 才发 cancel。 */
export function cancelDisposition(child: Pick<ParallelChild, 'sideEffectPolicy' | 'status'>):
  { cancel: boolean; reason: 'irreversible' | 'terminal' | 'cancellable' } {
  if (child.sideEffectPolicy === 'irreversible') return { cancel: false, reason: 'irreversible' }
  if (isTerminal(child.status)) return { cancel: false, reason: 'terminal' }
  return { cancel: true, reason: 'cancellable' }
}

/**
 * 从账本重算并落父运行的 settling / pending_irreversible_children。
 * 只有派生值变化时才写 runs 与 run 事件，重复调用幂等。
 */
export function refreshRunSettling(
  tx: Tx,
  runId: string,
  now: string,
): { settling: boolean; pending: string[] } {
  const run = tx.get<{ settling: number; pending_irreversible_children_json: string }>(
    'SELECT settling, pending_irreversible_children_json FROM runs WHERE run_id = ?', [runId],
  )
  if (!run) throw new OrchError('NOT_FOUND', 'run 不存在', { runId })
  const rows = tx.all<{ node_run_id: string; status: string; side_effect_policy: SideEffectPolicy }>(
    "SELECT node_run_id, status, side_effect_policy FROM node_runs WHERE run_id = ? AND parent_node_run_id IS NOT NULL AND status NOT IN ('done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded') ORDER BY node_run_id",
    [runId],
  )
  const pending = rows
    .filter((row) => row.side_effect_policy === 'irreversible')
    .map((row) => row.node_run_id)
  const settling = pending.length > 0 ? 1 : 0
  const before = JSON.parse(run.pending_irreversible_children_json) as string[]
  const changed = run.settling !== settling || JSON.stringify(before) !== JSON.stringify(pending)
  if (changed) {
    tx.run(
      'UPDATE runs SET settling = ?, pending_irreversible_children_json = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?',
      [settling, JSON.stringify(pending), now, runId],
    )
    appendEvent(tx, {
      type: 'run.settling_changed',
      runId,
      payload: { settling: settling === 1, pending_irreversible_children: pending },
    })
  }
  return { settling: settling === 1, pending }
}

/** 运行进终态前的派生闸：settling 或 pending 非空就拒。 */
export function assertRunCanTerminal(tx: Tx, runId: string): void {
  const run = tx.get<{ settling: number; pending_irreversible_children_json: string }>(
    'SELECT settling, pending_irreversible_children_json FROM runs WHERE run_id = ?', [runId],
  )
  if (!run) throw new OrchError('NOT_FOUND', 'run 不存在', { runId })
  const pending = JSON.parse(run.pending_irreversible_children_json) as string[]
  if (run.settling === 1 || pending.length > 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '还有未收口的不可逆子节点，运行不能进终态', {
      runId,
      pending_irreversible_children: pending,
    })
  }
  assertNoOpenChildRuns(tx, runId)
}
