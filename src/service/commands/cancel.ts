// src/service/commands/cancel.ts —— 取消与超时围栏（规格 4.5 行 344-358）
import type { Tx } from '../../infra/sqlite/driver.ts'
import { OrchError } from '../../core/errors.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { isTerminal } from '../../core/state-machine.ts'
import { deadlineFromAnchors, deadlineFromSample, type ClockProvider } from '../../core/clock.ts'
import { loadNodeRun } from './lease.ts'
import { applyTransition } from './nodes.ts'
import { cancelWait } from './wait.ts'

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
  // 半态钟：不传仍兼容旧调用；生产路径必须传，宽限判定不再只看墙钟
  clock?: ClockProvider
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
  // 还没派发就取消：直接作废，不进围栏、不产生新 attempt（审计 N-08）。
  // 这条必须先于不可逆检查：queued/leased 的不可逆节点尚未执行，作废不会掩盖已发生的副作用。
  if (row.status === 'queued' || row.status === 'leased') {
    applyTransition(tx, {
      nodeRunId: params.nodeRunId,
      from: ['queued', 'leased'],
      to: 'superseded',
      attempt: params.attempt,
      now: params.now,
      expectedRevision: params.revision,
      allowHung: true,
      patch: {
        cancel_requested_at: params.now,
        cancel_result: params.cancelResult,
        lease_id: null,
        lease_expires_at: null,
      },
    })
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_before_dispatch', {
      cancel_result: params.cancelResult,
      from: row.status,
      to: 'superseded',
    })
    return { cancel_result: params.cancelResult, next_status: 'superseded', fence_state: null, reason: 'cancelled_before_dispatch' }
  }
  // 纯控制节点（wait/subworkflow）没有宿主执行实例：取消即收口，
  // 不能先立围栏再等一个永远不会回来的执行器。判据是 node_type，不是副作用等级：
  // 子流程父节点可能代表不可逆子图，但它本身仍然不是一个可取消的执行实例。
  if (row.status === 'waiting' && (row.node_type === 'wait' || row.node_type === 'subworkflow')) {
    cancelWait(tx, params.nodeRunId, params.now)
    applyTransition(tx, {
      nodeRunId: params.nodeRunId,
      from: ['waiting'],
      to: 'superseded',
      attempt: params.attempt,
      now: params.now,
      expectedRevision: params.revision,
      allowHung: true,
      context: {
        hasToolCall: false,
        cancelResult: params.cancelResult,
        hangReason: null,
        sideEffectVerifiedNone: true,
        controlCompletion: true,
      },
      patch: {
        cancel_requested_at: params.now,
        cancel_result: params.cancelResult,
        wait_started_at: null,
        lease_id: null,
        lease_expires_at: null,
      },
    })
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_control_node', {
      cancel_result: params.cancelResult,
      from: 'waiting',
      to: 'superseded',
    })
    return { cancel_result: params.cancelResult, next_status: 'superseded', fence_state: null, reason: 'control_node_cancelled' }
  }
  // 不可逆执行节点不许取消：已发生的副作用不能靠取消掩盖，只能走核实/补偿
  if (row.side_effect_policy === 'irreversible') {
    throw new OrchError('FORBIDDEN', '不可逆子节点不许取消', {
      nodeRunId: params.nodeRunId,
      attempt: params.attempt,
      status: row.status,
      sideEffectPolicy: row.side_effect_policy,
    })
  }
  if (params.cancelResult === 'interrupted') {
    // 围栏已经立着：第二次取消不许再立一次（G-05 要求一次取消只arm一次）
    if (row.fence_state === 'armed') {
      return { cancel_result: 'interrupted', next_status: row.status, fence_state: 'armed', reason: 'fence_already_armed' }
    }
    // 没有单调时钟就不写 deadline：墙钟算出来的宽限期在扫描端一律判不确定，
    // 写下去等于给自己留一个永远不会被处理的「已取消」节点（S3 round12 P2-3）。
    if (!params.clock) {
      throw new OrchError('SERVICE_UNAVAILABLE', '取消宽限期需要单调时钟，缺少时不登记时限', {
        nodeRunId: params.nodeRunId,
        operation: 'cancel_grace',
      })
    }
    const grace = deadlineFromSample(params.clock, params.graceMs)
    const graceUntil = new Date(grace.wallClockMs).toISOString()
    applyTransition(tx, {
      nodeRunId: params.nodeRunId,
      from: CANCELABLE,
      to: 'timing_out',
      attempt: params.attempt,
      now: params.now,
      expectedRevision: params.revision,
      allowHung: true,
      context: {
        hasToolCall: false,
        cancelResult: 'interrupted',
        hangReason: null,
        sideEffectVerifiedNone: false,
      },
      patch: {
        fence_state: 'armed',
        fence_armed_at: params.now,
        fence_grace_until: graceUntil,
        fence_grace_boot_id: grace.bootId,
        fence_grace_monotonic_ns: grace.monotonicNs,
        cancel_requested_at: params.now,
        cancel_result: 'interrupted',
      },
    })
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'fence_armed', {
      cancel_result: 'interrupted',
      grace_until: graceUntil,
      reason: 'cancel_confirmed',
    })
    return { cancel_result: 'interrupted', next_status: 'timing_out', fence_state: 'armed', reason: 'cancel_confirmed' }
  }
  if (params.cancelResult === 'not_interruptible') {
    // 动作停不下来：延长动作截止时间并进 stopping（规格 4.5 行 345）
    if (!params.clock) {
      throw new OrchError('SERVICE_UNAVAILABLE', '动作延期需要单调时钟，缺少时不登记时限', {
        nodeRunId: params.nodeRunId,
        operation: 'cancel_extend',
      })
    }
    const extended = deadlineFromSample(params.clock, params.extendDeadlineMs ?? 0)
    const deadline = new Date(extended.wallClockMs).toISOString()
    if (row.fence_state === 'armed') {
      // 围栏立着时改状态会留下“stopping 但仍 armed”的双主人：只记取消结果，等宽限到点由 sweep 撤围栏（审计 P0-4）
      runCas(
        tx,
        "UPDATE node_runs SET cancel_requested_at = ?, cancel_result = ?, deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND fence_state = 'armed'",
        [params.now, 'not_interruptible', deadline, extended.bootId, extended.monotonicNs, params.now, params.nodeRunId, params.attempt, params.revision],
        { rows: 1, what: 'cancel-not-interruptible-fenced' },
      )
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_not_interruptible', { deadline_at: deadline, fence_pending: true })
      return { cancel_result: 'not_interruptible', next_status: row.status, fence_state: 'armed', reason: 'fence_pending' }
    }
    applyTransition(tx, {
      nodeRunId: params.nodeRunId,
      from: CANCELABLE,
      to: 'stopping',
      attempt: params.attempt,
      now: params.now,
      expectedRevision: params.revision,
      allowHung: true,
      bumpRearm: true,
      rearmGeneration: row.rearm_generation,
      context: {
        hasToolCall: false,
        cancelResult: 'not_interruptible',
        hangReason: null,
        sideEffectVerifiedNone: false,
      },
      patch: {
        cancel_requested_at: params.now,
        cancel_result: 'not_interruptible',
        deadline_at: deadline,
        deadline_boot_id: extended.bootId,
        deadline_monotonic_ns: extended.monotonicNs,
      },
    })
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_not_interruptible', { deadline_at: deadline })
    return { cancel_result: 'not_interruptible', next_status: 'stopping', fence_state: null, reason: 'not_interruptible' }
  }
  if (params.cancelResult === 'already_stopped') {
    // 已经停了：按已停事实判定，状态不改，只记取消事实（规格 4.5 行 346）
    if (row.fence_state === 'armed') {
      runCas(
        tx,
        "UPDATE node_runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND fence_state = 'armed'",
        [params.now, 'already_stopped', params.now, params.nodeRunId, params.attempt, params.revision],
        { rows: 1, what: 'cancel-already-stopped-fenced' },
      )
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_already_stopped', { status: row.status, fence_pending: true })
      return { cancel_result: 'already_stopped', next_status: row.status, fence_state: 'armed', reason: 'fence_pending' }
    }
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
  if (row.fence_state === 'armed') {
    // 围栏立着时不许在这里改状态；宽限到点撤围栏时统一回 stopping（审计 P0-4）
    runCas(
      tx,
      "UPDATE node_runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ? AND fence_state = 'armed'",
      [params.now, 'unknown', params.now, params.nodeRunId, params.attempt, params.revision],
      { rows: 1, what: 'cancel-unknown-fenced' },
    )
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_unknown', { fence_pending: true })
    return { cancel_result: 'unknown', next_status: row.status, fence_state: 'armed', reason: 'fence_pending' }
  }
  applyTransition(tx, {
    nodeRunId: params.nodeRunId,
    from: CANCELABLE,
    to: 'stopping',
    attempt: params.attempt,
    now: params.now,
    expectedRevision: params.revision,
    allowHung: true,
    bumpRearm: true,
    rearmGeneration: row.rearm_generation,
    context: {
      hasToolCall: false,
      cancelResult: 'unknown',
      hangReason: null,
      sideEffectVerifiedNone: false,
    },
    patch: {
      cancel_requested_at: params.now,
      cancel_result: 'unknown',
    },
  })
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'cancel_unknown', {})
  return { cancel_result: 'unknown', next_status: 'stopping', fence_state: null, reason: 'unknown' }
}

export type FenceRow = {
  node_run_id: string
  attempt: number
  revision: number
  status: string
  rearm_generation: number
  fence_state: string | null
  fence_grace_until: string | null
  fence_grace_boot_id?: string | null
  fence_grace_monotonic_ns?: number | null
}

// 宽限到点仍没见停止：撤销围栏回 stopping（规格 4.5 行 346）
// 返回是否这次真的撤销了（调用方据此决定要不要重放队头）
export function revokeFence(tx: Tx, secret: string, params: { row: FenceRow; now: string; clock?: ClockProvider; rearmActionDeadlineMs?: number }): boolean {
  if (params.row.fence_state !== 'armed') return false
  // 宽限没到点不许撤销：任何调用方都不能提前把围栏撤了（规格 4.5 行 346）
  if (!params.row.fence_grace_until) return false
  const anchored = deadlineFromAnchors({
    deadlineAt: params.row.fence_grace_until,
    bootId: params.row.fence_grace_boot_id ?? null,
    monotonicNs: params.row.fence_grace_monotonic_ns ?? null,
  })
  if (anchored && params.clock) {
    if (params.clock.decide(anchored).kind !== 'expired') return false
  } else if (Date.parse(params.row.fence_grace_until) > Date.parse(params.now)) {
    return false
  }
  // 撤销失败只说明这行已被别人改过：返回 false 让 sweep 继续下一条，不许整批回滚（审计 P0-4）
  // 撤围栏同时重新武装 action_deadline，并在同一笔 CAS 里 Gr+1；旧定时器与旧执行器手里的 Gr 立刻失效。
  const rearm = params.clock
    ? deadlineFromSample(params.clock, params.rearmActionDeadlineMs ?? 30_000)
    : { bootId: null, monotonicNs: null, wallClockMs: Date.parse(params.now) + (params.rearmActionDeadlineMs ?? 30_000) }
  try {
    applyTransition(tx, {
      nodeRunId: params.row.node_run_id,
      from: ['timing_out'],
      to: 'stopping',
      // 宽限到点撤围栏固定走 M-26；不带 ruleId 会被 M-27 的守卫口径混进来
      ruleId: 'M-26',
      attempt: params.row.attempt,
      now: params.now,
      bumpRearm: true,
      rearmGeneration: params.row.rearm_generation,
      patch: {
        fence_state: 'revoked',
        fence_grace_until: null,
        fence_grace_boot_id: null,
        fence_grace_monotonic_ns: null,
        deadline_at: new Date(rearm.wallClockMs).toISOString(),
        deadline_boot_id: rearm.bootId,
        deadline_monotonic_ns: rearm.monotonicNs,
      },
    })
  } catch {
    return false
  }
  appendNodeRunEvent(tx, secret, params.row.node_run_id, 'fence_revoked', {
    reason: 'grace_expired',
    transition_reason: 'whenIdle_timeout',
    rearm_generation: params.row.rearm_generation + 1,
  })
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
