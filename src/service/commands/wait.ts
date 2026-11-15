// src/service/commands/wait.ts —— 等待节点与事件唤醒（规格 5.8 行 507-513）
import { OrchError } from '../../core/errors.ts'
import { appendNodeRunEvent, appendEvent } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { applyTransition } from './nodes.ts'
import { closeRun } from './run-close.ts'
import { deadlineFromAnchors, deadlineFromSample, type ClockProvider } from '../../core/clock.ts'

export type WaitKind = 'event' | 'timer'
export type WaitState = 'active' | 'woken' | 'timed_out' | 'cancelled'

export type WaitMatch = {
  type: string
  path?: string
  equals?: unknown
}

export type WaitRegistration = {
  registrationId: number
  nodeRunId: string
  runId: string
  waitKind: WaitKind
  match: WaitMatch
  fromSeq: number
  cursorSeq: number
  idempotencyKey: string
  state: WaitState
  matchedEventSeq: number | null
  matchedPayload: unknown
  wokeAt: string | null
  queuedAt: string | null
  wakeDispatchStarvationCount: number
  createdAt: string
}

type WaitRow = {
  registration_id: number
  node_run_id: string
  run_id: string
  wait_kind: WaitKind
  match_json: string
  from_seq: number
  cursor_seq: number
  idempotency_key: string
  state: WaitState
  matched_event_seq: number | null
  matched_payload_json: string | null
  woke_at: string | null
  queued_at: string | null
  wake_dispatch_starvation_count: number
  created_at: string
}

function toRegistration(row: WaitRow): WaitRegistration {
  return {
    registrationId: row.registration_id,
    nodeRunId: row.node_run_id,
    runId: row.run_id,
    waitKind: row.wait_kind,
    match: JSON.parse(row.match_json) as WaitMatch,
    fromSeq: row.from_seq,
    cursorSeq: row.cursor_seq,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    matchedEventSeq: row.matched_event_seq,
    matchedPayload: row.matched_payload_json === null ? null : JSON.parse(row.matched_payload_json),
    wokeAt: row.woke_at,
    queuedAt: row.queued_at,
    wakeDispatchStarvationCount: row.wake_dispatch_starvation_count,
    createdAt: row.created_at,
  }
}

function readPath(input: unknown, path: string): unknown {
  let cursor: unknown = input
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function matches(match: WaitMatch, eventType: string, payload: unknown): boolean {
  if (match.type !== eventType) return false
  if (match.path === undefined) return true
  return JSON.stringify(readPath(payload, match.path)) === JSON.stringify(match.equals)
}

export function getWaitRegistration(tx: Tx, nodeRunId: string): WaitRegistration | null {
  const row = tx.get<WaitRow>('SELECT * FROM wait_registrations WHERE node_run_id = ?', [nodeRunId])
  return row ? toRegistration(row) : null
}

/**
 * 事件先落 inbox。同 idempotency_key 重复投递只保留第一条；
 * 节点还没注册时事件也不会丢，后续从 cursor 回放补齐。
 */
export function recordWaitEvent(tx: Tx, input: {
  runId: string
  eventType: string
  payload?: unknown
  idempotencyKey?: string | null
  now: string
}): number {
  if (!input.eventType) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '等待事件缺少 type', { runId: input.runId })
  if (input.idempotencyKey) {
    // 幂等键按 run 作用域唯一：不同 run 用同一个键时，事件必须各自进各自的 inbox
    tx.run(
      'INSERT INTO wait_event_inbox (run_id, event_type, payload_json, idempotency_key, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, idempotency_key) DO NOTHING',
      [input.runId, input.eventType, JSON.stringify(input.payload ?? {}), input.idempotencyKey, input.now],
    )
    const row = tx.get<{ inbox_seq: number }>(
      'SELECT inbox_seq FROM wait_event_inbox WHERE run_id = ? AND idempotency_key = ?',
      [input.runId, input.idempotencyKey],
    )
    return row!.inbox_seq
  }
  const res = tx.run(
    'INSERT INTO wait_event_inbox (run_id, event_type, payload_json, idempotency_key, received_at) VALUES (?, ?, ?, NULL, ?)',
    [input.runId, input.eventType, JSON.stringify(input.payload ?? {}), input.now],
  )
  return Number(res.lastInsertRowid)
}

function scanRegistration(tx: Tx, secret: string, registration: WaitRegistration, now: string): boolean {
  const rows = tx.all<{ inbox_seq: number; event_type: string; payload_json: string }>(
    'SELECT inbox_seq, event_type, payload_json FROM wait_event_inbox WHERE run_id = ? AND inbox_seq > ? ORDER BY inbox_seq ASC',
    [registration.runId, registration.cursorSeq],
  )
  if (rows.length === 0) return false
  const cursor = rows[rows.length - 1]!.inbox_seq
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as unknown
    if (!matches(registration.match, row.event_type, payload)) continue
    const res = tx.run(
      "UPDATE wait_registrations SET state = 'woken', cursor_seq = ?, matched_event_seq = ?, matched_payload_json = ?, woke_at = ?, queued_at = ?, updated_at = ? WHERE node_run_id = ? AND state = 'active'",
      [row.inbox_seq, row.inbox_seq, row.payload_json, now, now, now, registration.nodeRunId],
    )
    if (res.changes !== 1) return false
    applyTransition(tx, {
      nodeRunId: registration.nodeRunId,
      from: ['waiting'],
      to: 'done',
      attempt: currentAttempt(tx, registration.nodeRunId),
      now,
      // 控制节点没有可恢复的宿主实例：等待条件满足即完成（M-63）
      context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, controlCompletion: true },
      patch: {
        lease_id: null,
        lease_expires_at: null,
        executor_session_id: null,
        executor_agent_id: null,
        wait_deadline_at: null,
      },
    })
    appendNodeRunEvent(tx, secret, registration.nodeRunId, 'wait.woken', {
      event_seq: row.inbox_seq,
      event_type: row.event_type,
      idempotency_key: registration.idempotencyKey,
      queued_at: now,
    })
    appendEvent(tx, {
      type: 'wait.woken', runId: registration.runId, nodeRunId: registration.nodeRunId,
      payload: { event_seq: row.inbox_seq, event_type: row.event_type },
    })
    return true
  }
  tx.run('UPDATE wait_registrations SET cursor_seq = ?, updated_at = ? WHERE node_run_id = ?', [
    cursor, now, registration.nodeRunId,
  ])
  return false
}

function currentAttempt(tx: Tx, nodeRunId: string): number {
  const row = tx.get<{ attempt: number }>('SELECT attempt FROM node_runs WHERE node_run_id = ?', [nodeRunId])
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId })
  return row.attempt
}

function scanRun(tx: Tx, secret: string, runId: string, now: string): number {
  const rows = tx.all<WaitRow>(
    "SELECT * FROM wait_registrations WHERE run_id = ? AND state = 'active' ORDER BY registration_id ASC", [runId],
  )
  let woken = 0
  for (const row of rows) {
    if (scanRegistration(tx, secret, toRegistration(row), now)) woken++
  }
  return woken
}

export type EnterWaitingResult = {
  registration: WaitRegistration
  woken: boolean
}

/**
 * 进入 waiting：状态迁移、租约释放、wait_registrations 写入在同一事务。
 * 注册后立即从 from_seq 回扫，事件早到也能当场唤醒。
 */
export function enterWaiting(tx: Tx, secret: string, req: {
  nodeRunId: string
  attempt: number
  runId: string
  waitKind: WaitKind
  match: WaitMatch
  idempotencyKey: string
  fromSeq?: number
  maxWaitMs: number
  now: string
  clock?: ClockProvider
}): EnterWaitingResult {
  if (!req.match.type) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '等待谓词缺少事件类型', { nodeRunId: req.nodeRunId })
  if (!Number.isInteger(req.maxWaitMs) || req.maxWaitMs <= 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'max_wait 必须是正毫秒数', { maxWaitMs: req.maxWaitMs })
  }
  const existing = getWaitRegistration(tx, req.nodeRunId)
  if (existing) {
    if (existing.idempotencyKey !== req.idempotencyKey) {
      throw new OrchError('OPERATION_ID_CONFLICT', '同一节点已经在等另一个幂等键', {
        nodeRunId: req.nodeRunId,
        existing: existing.idempotencyKey,
        incoming: req.idempotencyKey,
      })
    }
    if (existing.state === 'active') {
      return { registration: getWaitRegistration(tx, req.nodeRunId)!, woken: scanRegistration(tx, secret, existing, req.now) }
    }
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这个等待登记已经收口，不能复用', {
      nodeRunId: req.nodeRunId,
      state: existing.state,
    })
  }
  const keyTaken = tx.get<{ node_run_id: string }>('SELECT node_run_id FROM wait_registrations WHERE idempotency_key = ?', [req.idempotencyKey])
  if (keyTaken) {
    throw new OrchError('OPERATION_ID_CONFLICT', '等待幂等键已被其他节点占用', {
      idempotencyKey: req.idempotencyKey,
      nodeRunId: keyTaken.node_run_id,
    })
  }
  const waitDeadline = req.clock
    ? deadlineFromSample(req.clock, req.maxWaitMs)
    : { bootId: null, monotonicNs: null, wallClockMs: Date.parse(req.now) + req.maxWaitMs }
  const deadline = new Date(waitDeadline.wallClockMs).toISOString()
  // 等待节点是纯控制节点：等待本身不产生副作用，不能按默认补偿语义收成 unverified
  tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE node_run_id = ?", [req.nodeRunId])
  applyTransition(tx, {
    nodeRunId: req.nodeRunId,
    from: ['started'],
    to: 'waiting',
    attempt: req.attempt,
    now: req.now,
    bumpRearm: true,
    patch: {
      lease_id: null,
      lease_expires_at: null,
      executor_session_id: null,
      executor_agent_id: null,
      wait_started_at: req.now,
      wait_deadline_at: deadline,
      wait_deadline_boot_id: waitDeadline.bootId,
      wait_deadline_monotonic_ns: waitDeadline.monotonicNs,
    },
  })
  tx.run(
    'INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    [req.nodeRunId, req.runId, req.waitKind, JSON.stringify(req.match), req.fromSeq ?? 0,
      req.fromSeq ?? 0, req.idempotencyKey, req.now, req.now],
  )
  appendNodeRunEvent(tx, secret, req.nodeRunId, 'wait.entered', {
    wait_kind: req.waitKind,
    from_seq: req.fromSeq ?? 0,
    max_wait_ms: req.maxWaitMs,
    deadline_at: deadline,
  })
  appendEvent(tx, {
    type: 'wait.entered', runId: req.runId, nodeRunId: req.nodeRunId,
    payload: { wait_kind: req.waitKind, deadline_at: deadline },
  })
  const registration = getWaitRegistration(tx, req.nodeRunId)!
  const woken = scanRegistration(tx, secret, registration, req.now)
  if (woken) closeRun(tx, req.runId, req.now)
  return { registration: getWaitRegistration(tx, req.nodeRunId)!, woken }
}

/** 事件到账：先落 inbox，再回放所有活跃等待；返回被唤醒的节点数。 */
export function wakeOnEvent(tx: Tx, secret: string, input: {
  runId: string
  eventType: string
  payload?: unknown
  idempotencyKey?: string | null
  now: string
}): { eventSeq: number; woken: number } {
  const eventSeq = recordWaitEvent(tx, input)
  const woken = scanRun(tx, secret, input.runId, input.now)
  // 控制节点等待条件满足即完成：若本 run 已无未终态节点，同一事务内收口
  closeRun(tx, input.runId, input.now)
  return { eventSeq, woken }
}

/** 事件命中但调度器抢不到 slot：节点继续等，单独记 starvation，不算 event_timeout。 */
export function markWakeStarvation(tx: Tx, secret: string, nodeRunId: string, now: string): void {
  const row = tx.get<WaitRow>("SELECT * FROM wait_registrations WHERE node_run_id = ? AND state = 'active'", [nodeRunId])
  if (!row) return
  tx.run(
    'UPDATE wait_registrations SET wake_dispatch_starvation_count = wake_dispatch_starvation_count + 1, updated_at = ? WHERE node_run_id = ?',
    [now, nodeRunId],
  )
  appendNodeRunEvent(tx, secret, nodeRunId, 'wait.wake_dispatch_starvation', {
    idempotency_key: row.idempotency_key,
    count: row.wake_dispatch_starvation_count + 1,
  })
  appendEvent(tx, { type: 'wait.wake_dispatch_starvation', runId: row.run_id, nodeRunId })
}

/** max_wait/event_timeout 到点：waiting→timeout，等待钟清空，登记转 timed_out。 */
export function timeoutWaiting(tx: Tx, secret: string, nodeRunId: string, now: string, clock?: ClockProvider): boolean {
  const row = tx.get<WaitRow>("SELECT * FROM wait_registrations WHERE node_run_id = ? AND state = 'active'", [nodeRunId])
  if (!row) return false
  const node = tx.get<{ status: string; attempt: number; run_id: string; wait_deadline_at: string | null; wait_deadline_boot_id: string | null; wait_deadline_monotonic_ns: number | null }>(
    'SELECT status, attempt, run_id, wait_deadline_at, wait_deadline_boot_id, wait_deadline_monotonic_ns FROM node_runs WHERE node_run_id = ?', [nodeRunId],
  )
  if (!node || node.status !== 'waiting') return false
  if (node.wait_deadline_at === null) return false
  const anchored = deadlineFromAnchors({
    deadlineAt: node.wait_deadline_at,
    bootId: node.wait_deadline_boot_id,
    monotonicNs: node.wait_deadline_monotonic_ns,
  })
  if (anchored && clock) {
    const decision = clock.decide(anchored)
    if (decision.kind !== 'expired') return false
  } else if (Date.parse(node.wait_deadline_at) > Date.parse(now)) {
    return false
  }
  tx.run("UPDATE wait_registrations SET state = 'timed_out', updated_at = ? WHERE node_run_id = ? AND state = 'active'", [now, nodeRunId])
  applyTransition(tx, {
    nodeRunId, from: ['waiting'], to: 'timeout', attempt: node.attempt, now, bumpRearm: true,
    patch: { wait_deadline_at: null, wait_deadline_boot_id: null, wait_deadline_monotonic_ns: null },
  })
  appendNodeRunEvent(tx, secret, nodeRunId, 'wait.event_timeout', {
    idempotency_key: row.idempotency_key,
    deadline_at: node.wait_deadline_at,
  })
  appendEvent(tx, { type: 'wait.event_timeout', runId: row.run_id, nodeRunId })
  closeRun(tx, node.run_id, now)
  return true
}

export function sweepWaitTimeouts(tx: Tx, secret: string, now: string, clock?: ClockProvider, skipNodeRunIds?: ReadonlySet<string>): number {
  const rows = tx.all<{ node_run_id: string }>(
    "SELECT w.node_run_id FROM wait_registrations w JOIN node_runs n ON n.node_run_id = w.node_run_id " +
      "WHERE w.state = 'active' AND n.status = 'waiting' AND n.wait_deadline_at IS NOT NULL ORDER BY w.registration_id",
  )
  let timedOut = 0
  for (const row of rows) {
    if (skipNodeRunIds?.has(row.node_run_id)) continue
    if (timeoutWaiting(tx, secret, row.node_run_id, now, clock)) timedOut++
  }
  return timedOut
}

/** 组结束/取消时撤等待登记；节点状态由调用方的状态迁移负责。 */
export function cancelWait(tx: Tx, nodeRunId: string, now: string): boolean {
  const res = tx.run(
    "UPDATE wait_registrations SET state = 'cancelled', updated_at = ? WHERE node_run_id = ? AND state = 'active'",
    [now, nodeRunId],
  )
  return res.changes === 1
}
