// src/service/commands/cancel.ts —— 取消与超时围栏（规格 4.5 行 344-358）
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { isTerminal } from '../../core/state-machine.ts'
import { loadNodeRun } from './lease.ts'

export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

export type CancelParams = {
  nodeRunId: string
  attempt: number
  revision: number
  cancelResult: CancelResult
  now: string
  // 宽限秒数：围栏立起后等 whenIdle 的时间（规格 4.5 行 345）
  graceMs: number
  // 只在 interrupted 时用：动作截止时间往后延多久
  extendDeadlineMs?: number
}

export type CancelOutcome = {
  cancel_result: CancelResult
  next_status: string
  fence_state: 'armed' | 'revoked' | null
  reason: string
}

// 只有 interrupted 才立围栏进 timing_out，其余各按规格 4.5 落位（规格 4.5 行 349-353）
// 取消的 CAS 必须带 status 前置条件：终态没有出边，不许被取消改回 timing_out（规格 3.5 行 179）
const CANCELABLE = ['dispatched', 'started', 'waiting', 'verifying', 'stopping', 'timing_out'] as const

export function applyCancel(tx: Tx, secret: string, params: CancelParams): CancelOutcome {
  const row = loadNodeRun(tx, params.nodeRunId)
  // 已经到终态：按已停事实判定，不写状态、不立围栏
  if (isTerminal(row.status)) {
    return { cancel_result: 'already_stopped', next_status: row.status, fence_state: null, reason: 'terminal_no_out_edge' }
  }
  if (params.cancelResult === 'interrupted') {
    // 围栏已经立着：第二次取消不许再立一次（G-05 要求一次取消只arm一次）
    if (row.fence_state === 'armed') {
      return { cancel_result: 'interrupted', next_status: row.status, fence_state: 'armed', reason: 'fence_already_armed' }
    }
    const graceUntil = new Date(Date.parse(params.now) + params.graceMs).toISOString()
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, fence_state = ?, fence_armed_at = ?, fence_grace_until = ?, cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND status IN (' + CANCELABLE.map(() => '?').join(', ') + ')',
      ['timing_out', 'armed', params.now, graceUntil, params.now, 'interrupted', params.now, params.nodeRunId, params.attempt, params.revision, ...CANCELABLE],
      { rows: 1, what: 'cancel-interrupted' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'fence_armed', {
      cancel_result: 'interrupted',
      grace_until: graceUntil,
      reason: 'cancel_confirmed',
    })
    return { cancel_result: 'interrupted', next_status: 'timing_out', fence_state: 'armed', reason: 'cancel_confirmed' }
  }
  if (params.cancelResult === 'not_interruptible') {
    // 动作停不下来：延长动作截止时间并进 stopping（规格 4.5 行 345）
    const deadline = new Date(Date.parse(params.now) + (params.extendDeadlineMs ?? 0)).toISOString()
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, cancel_requested_at = ?, cancel_result = ?, deadline_at = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND status IN (' + CANCELABLE.map(() => '?').join(', ') + ')',
      ['stopping', params.now, 'not_interruptible', deadline, params.now, params.nodeRunId, params.attempt, params.revision, ...CANCELABLE],
      { rows: 1, what: 'cancel-not-interruptible' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_not_interruptible', { deadline_at: deadline })
    return { cancel_result: 'not_interruptible', next_status: 'stopping', fence_state: null, reason: 'not_interruptible' }
  }
  if (params.cancelResult === 'already_stopped') {
    // 已经停了：按已停事实判定，状态不改，只记取消事实（规格 4.5 行 346）
    runCas(
      tx,
      'UPDATE node_runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND status IN (' + CANCELABLE.map(() => '?').join(', ') + ')',
      [params.now, 'already_stopped', params.now, params.nodeRunId, params.attempt, params.revision, ...CANCELABLE],
      { rows: 1, what: 'cancel-already-stopped' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_already_stopped', { status: row.status })
    return { cancel_result: 'already_stopped', next_status: row.status, fence_state: null, reason: 'already_stopped' }
  }
  // unknown：进 stopping 再查执行器状态（规格 4.5 行 347）
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND status IN (' + CANCELABLE.map(() => '?').join(', ') + ')',
    ['stopping', params.now, 'unknown', params.now, params.nodeRunId, params.attempt, params.revision, ...CANCELABLE],
    { rows: 1, what: 'cancel-unknown' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_unknown', {})
  return { cancel_result: 'unknown', next_status: 'stopping', fence_state: null, reason: 'unknown' }
}

export type FenceRow = {
  node_run_id: string
  attempt: number
  revision: number
  status: string
  fence_state: string | null
  fence_grace_until: string | null
}

// 宽限到点仍没见停止：撤销围栏回 stopping（规格 4.5 行 346）
// 返回是否这次真的撤销了（调用方据此决定要不要重放队头）
export function revokeFence(tx: Tx, secret: string, params: { row: FenceRow; now: string }): boolean {
  if (params.row.fence_state !== 'armed') return false
  // 宽限没到点不许撤销：任何调用方都不能提前把围栏撤了（规格 4.5 行 346）
  if (!params.row.fence_grace_until) return false
  if (Date.parse(params.row.fence_grace_until) > Date.parse(params.now)) return false
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, fence_state = ?, fence_grace_until = NULL, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['stopping', 'revoked', params.now, params.row.node_run_id, 'timing_out', params.row.attempt, params.row.revision],
    { rows: 1, what: 'revokeFence' },
  )
  appendNodeRunEvent(tx, secret, params.row.node_run_id, 'fence_revoked', { reason: 'grace_expired' })
  return true
}

// 围栏已立时收到的上报进 registry(rejected) 排队；围栏撤销后只重放当前 attempt 的队头
export function pickReplayHead(tx: Tx, nodeRunId: string, attempt: number): { report_id: string; report_seq: number } | undefined {
  const row = tx.get<{ report_id: string; report_seq: number }>(
    'SELECT report_id, report_seq FROM report_registry WHERE node_run_id = ? AND attempt = ? AND state = ? ORDER BY report_seq ASC LIMIT 1',
    [nodeRunId, attempt, 'rejected'],
  )
  return row
}

// 旧 attempt 的排队上报标 stale，不再重放（规格 4.5 行 351）
export function markOlderAttemptsStale(tx: Tx, params: { nodeRunId: string; currentAttempt: number; now: string }): number {
  const res = tx.run(
    'UPDATE report_registry SET state = ?, updated_at = ? WHERE node_run_id = ? AND attempt < ? AND state = ?',
    ['stale', params.now, params.nodeRunId, params.currentAttempt, 'rejected'],
  )
  return res.changes
}
