// src/service/commands/nodes.ts —— 单条 CAS 迁移执行器（S3 Task 2，规格 4.3/4.4）
import { OrchError } from '../../core/errors.ts'
import type { NodeStatus } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'

export type TransitionPatch = Readonly<Record<string, string | number | null>>

// 只允许迁移规则显式声明的列；patch 的键不能来自外部请求的自由文本。
const PATCH_COLUMNS = new Set([
  'action_generation',
  'rearm_generation',
  'hang_reason',
  'contradiction_decision_id',
  'startup_unknown_remaining_ns',
  'verify_remaining_ns',
])

export type TransitionRequest = {
  nodeRunId: string
  from: readonly NodeStatus[]
  to: NodeStatus
  attempt: number
  now: string
  actionGeneration?: number
  patch?: TransitionPatch
  // 只有写 hang_reason 的规则可以越过 hang_reason IS NULL 的普通出口闸门
  allowHung?: boolean
}

/**
 * 把一条迁移落成单条 UPDATE：
 * - 条件含 node_run_id、from 集合、attempt，普通出口再带 hang_reason IS NULL；
 * - 受影响行数必须恰为 1，否则抛 STALE_GENERATION，由调用方事务整体回滚。
 */
export function applyTransition(tx: Tx, req: TransitionRequest): void {
  if (req.from.length === 0) {
    throw new OrchError('STALE_GENERATION', '迁移缺少来源状态', { nodeRunId: req.nodeRunId })
  }
  const patch = req.patch ?? {}
  const columns = Object.keys(patch)
  for (const column of columns) {
    if (!PATCH_COLUMNS.has(column)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移 patch 含未登记的列', { column })
    }
  }
  const setSql = ['status = ?', 'revision = revision + 1', 'updated_at = ?']
    .concat(columns.map((column) => column + ' = ?'))
    .join(', ')
  const whereSql = [
    'node_run_id = ?',
    'status IN (' + req.from.map(() => '?').join(', ') + ')',
    'attempt = ?',
  ]
  const whereBinds: unknown[] = [req.nodeRunId, ...req.from, req.attempt]
  if (!req.allowHung) whereSql.push('hang_reason IS NULL')
  if (req.actionGeneration !== undefined) {
    whereSql.push('action_generation = ?')
    whereBinds.push(req.actionGeneration)
  }
  const values: unknown[] = [req.to, req.now, ...columns.map((column) => patch[column])]
  const res = tx.run(
    'UPDATE node_runs SET ' + setSql + ' WHERE ' + whereSql.join(' AND '),
    [...values, ...whereBinds],
  )
  if (res.changes !== 1) {
    throw new OrchError('STALE_GENERATION', 'node_run 迁移 CAS 未命中', {
      nodeRunId: req.nodeRunId,
      from: req.from,
      to: req.to,
      attempt: req.attempt,
    })
  }
}

export type CreateNodeRunRequest = {
  newNodeRunId: string
  runId: string
  nodeId: string
  seq: number
  nodeType: string
  attempt: number
  originNodeRunId: string
  now: string
}

/**
 * 新建一个 attempt：新行 queued、revision=1，旧行写 replacement_node_run_id。
 * 旧行不能已有 replacement；唯一索引 node_runs_origin_uq 保证一个旧行只被接班一次。
 */
export function createNodeRun(tx: Tx, req: CreateNodeRunRequest): void {
  if (req.attempt < 1) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'attempt 必须从 1 开始', { attempt: req.attempt })
  }
  tx.run(
    'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, origin_node_run_id, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)",
    [req.newNodeRunId, req.runId, req.nodeId, req.seq, req.nodeType, req.attempt, req.originNodeRunId, req.now, req.now],
  )
  const res = tx.run(
    'UPDATE node_runs SET replacement_node_run_id = ?, updated_at = ? WHERE node_run_id = ? AND replacement_node_run_id IS NULL',
    [req.newNodeRunId, req.now, req.originNodeRunId],
  )
  if (res.changes !== 1) {
    throw new OrchError('STALE_GENERATION', '旧 attempt 不能被再次接班', {
      originNodeRunId: req.originNodeRunId,
      newNodeRunId: req.newNodeRunId,
    })
  }
}
