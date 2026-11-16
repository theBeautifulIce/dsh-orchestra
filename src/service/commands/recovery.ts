// 恢复不确定的节点：宿主确认后收口（评审 P2-4）
// 扫描对 recovery_uncertain 的节点一律不推进；这里给出唯一的合法出口，
// 避免运维只能手工改库。确认语义只有一种：副作用是否发生无法判断 → indeterminate_side_effect，
// 之后照既有裁决链（M-51/M-52/M-53）继续收口。
import { OrchError } from '../../core/errors.ts'
import type { NodeStatus } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { applyTransition } from './nodes.ts'
import { cancelWait } from './wait.ts'
import { RECOVERY_CHANNEL_COLUMNS } from '../queries/recovery.ts'

export type RecoveryResolution = 'mark_indeterminate_side_effect'

export type RecoveryResolveRequest = {
  nodeRunId: string
  revision: number
  resolution: RecoveryResolution
  now: string
}

export type RecoveryResolveResult = {
  node_run_id: string
  from: string
  to: 'indeterminate_side_effect'
  channel: string | null
}

type Row = {
  status: string
  attempt: number
  revision: number
  recovery_uncertain: string | null
}

export function resolveRecoveryUncertain(tx: Tx, secret: string, req: RecoveryResolveRequest): RecoveryResolveResult {
  const row = tx.get<Row>(
    'SELECT status, attempt, revision, recovery_uncertain FROM node_runs WHERE node_run_id = ?',
    [req.nodeRunId],
  )
  if (!row) throw new OrchError('NOT_FOUND', '节点不存在', { nodeRunId: req.nodeRunId })
  if (row.recovery_uncertain === null) {
    throw new OrchError('STALE_GENERATION', '这个节点没有待处理的恢复不确定状态', { nodeRunId: req.nodeRunId })
  }
  if (row.revision !== req.revision) {
    throw new OrchError('STALE_GENERATION', 'revision 已过期，先重新读取节点', {
      nodeRunId: req.nodeRunId, expected: req.revision, actual: row.revision,
    })
  }
  // 等待登记必须一起收掉：残留 active 登记会让这个 run 之后每次 wakeOnEvent 整笔回滚（S3 r19 P2-3）
  cancelWait(tx, req.nodeRunId, req.now)
  const cols = RECOVERY_CHANNEL_COLUMNS[row.recovery_uncertain]
  // 通道锚点一起清掉：留着的话下一次重启扫描还会按同一通道把它标回不确定
  const patch: Record<string, string | number | null> = {
    recovery_uncertain: null,
    recovery_uncertain_at: null,
  }
  if (cols) {
    patch[cols.deadline] = null
    patch[cols.boot] = null
    patch[cols.monotonic] = null
    patch[cols.checkpoint] = null
  }
  applyTransition(tx, secret, {
    nodeRunId: req.nodeRunId,
    from: [row.status as NodeStatus],
    to: 'indeterminate_side_effect',
    attempt: row.attempt,
    now: req.now,
    // M-50：非终态 → indeterminate_side_effect，语义就是「停没停、做没做不知道」
    ruleId: 'M-50',
    expectedRevision: req.revision,
    bumpRearm: true,
    patch,
  })
  appendNodeRunEvent(tx, secret, req.nodeRunId, 'recovery.confirmed', {
    from: row.status,
    to: 'indeterminate_side_effect',
    channel: row.recovery_uncertain,
    resolution: req.resolution,
  })
  return { node_run_id: req.nodeRunId, from: row.status, to: 'indeterminate_side_effect', channel: row.recovery_uncertain }
}
