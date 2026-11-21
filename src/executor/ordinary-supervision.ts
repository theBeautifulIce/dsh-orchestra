import { deadlineFromAnchors, deadlineFromRow, deadlineFromSample, type ClockProvider } from '../core/clock.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { releaseLease, type NodeRunRow } from '../service/commands/lease.ts'
import { applyTransition } from '../service/commands/nodes.ts'
import type { AttemptSupervision } from './agent-lifecycle.ts'
import type { BridgeClient, BridgeEvent, ResidentAttemptBinding } from './bridge.ts'

const DECISION_GRACE_MS = 120_000
const MAX_OBSERVATION_MS = 15 * 60_000
const FINAL_RECEIPT_GRACE_MS = 250

type ExecutionRow = NodeRunRow & {
  executor_agent_id: string | null
  executor_session_id: string | null
  cancel_requested_at: string | null
  run_cancel_requested_at: string | null
  run_status: string
  tool_start_at: string | null
}

export function superviseOrdinaryAttempt(deps: {
  db: Db
  secret: string
  clock: ClockProvider
  bridge: BridgeClient
  binding: ResidentAttemptBinding
  leaseId: string
  ownerEpoch: number
  nowAt: () => string
  timeoutMs: number
  unknownWatchdogMs: number
  signal?: AbortSignal
}): AttemptSupervision & { lateStatus(): { status: 'startup_unknown' | 'stopping' | 'abandoned_unverified'; rearmGeneration: number } | undefined } {
  const { db, secret, clock, bridge, binding, nowAt } = deps
  const initialDeadline = performance.now() + deps.timeoutMs
  const finalDeadline = initialDeadline + MAX_OBSERVATION_MS
  let abandonment: { rearm: number; cutoff: number } | undefined
  let unconfirmedSince: number | undefined
  const readNode = db.raw.prepare(`SELECT n.*,r.cancel_requested_at AS run_cancel_requested_at,r.status AS run_status
    FROM node_runs n JOIN runs r USING(run_id) WHERE n.node_run_id=?`)
  const readPendingAbandonment = db.raw.prepare(`SELECT 1 FROM node_run_events e JOIN decisions d
    ON d.decision_id=json_extract(e.payload,'$.abandon_ack_id') AND d.run_id=?
    WHERE e.node_run_id=? AND e.type='decision.abandoned' AND json_valid(e.payload)
    AND json_extract(e.payload,'$.attempt')=? AND json_extract(e.payload,'$.action_generation')=?
    AND json_extract(e.payload,'$.rearm_generation')=?
    AND d.kind='abandon_ack' AND d.status IN ('pending','acknowledged','blocked_for_human') LIMIT 1`)
  const readFinalReceipt = db.raw.prepare(`SELECT 1 FROM bridge_event_receipts b
    JOIN node_run_events e ON e.node_run_id=b.node_run_id AND e.seq=b.ledger_seq
    WHERE b.node_run_id=? AND b.attempt=? AND b.executor_agent_id=? AND b.bridge_seq=?
    AND b.event_type='bridge.turn' AND e.type='bridge.turn'
    AND json_extract(e.payload,'$.attempt')=b.attempt AND json_extract(e.payload,'$.executorAgentId')=b.executor_agent_id
    AND json_extract(e.payload,'$.payload.kind')='report'`)
  const readToolStart = db.raw.prepare(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='tool_started'
    AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?
    AND json_extract(payload,'$.started_at')=? LIMIT 1`)

  function current(): ExecutionRow | undefined {
    if (deps.signal?.aborted) return
    const row = readNode.get(binding.nodeRunId) as ExecutionRow | undefined
    if (!row || row.attempt !== binding.attempt || row.action_generation !== binding.actionGeneration
      || row.executor_agent_id !== binding.executorAgentId || row.executor_session_id !== binding.executorSessionId
      || row.owner_epoch !== deps.ownerEpoch || row.cancel_requested_at || row.run_cancel_requested_at
      || !['running', 'paused'].includes(row.run_status) || row.fence_state === 'armed'
      || (row.hang_reason !== null && !(row.status === 'stopping' && row.hang_reason === 'action_overrun'))) return
    return row
  }

  function leaseCurrent(row: ExecutionRow): boolean {
    return row.lease_id === deps.leaseId
      && row.lease_expires_at !== null && Date.parse(row.lease_expires_at) > Date.parse(nowAt())
  }

  function mayUse(row: ExecutionRow | undefined): boolean {
    return performance.now() < initialDeadline && row?.status === 'started' && leaseCurrent(row)
  }

  function retainedAfterAbandon(row: ExecutionRow): number {
    const card = readPendingAbandonment.get(row.run_id, binding.nodeRunId, binding.attempt, binding.actionGeneration, row.rearm_generation)
    if (!card) return 0
    if (abandonment?.rearm !== row.rearm_generation) abandonment = { rearm: row.rearm_generation, cutoff: performance.now() + DECISION_GRACE_MS }
    return abandonment.cutoff - performance.now()
  }

  function remaining(row: ExecutionRow): number {
    if (row.status === 'started') return initialDeadline + DECISION_GRACE_MS - performance.now()
    if (row.status === 'abandoned_unverified') return retainedAfterAbandon(row)
    const deadline = row.status === 'startup_unknown' ? deadlineFromAnchors({
      deadlineAt: row.startup_unknown_deadline_at, bootId: row.startup_unknown_boot_id, monotonicNs: row.startup_unknown_monotonic_ns,
    }) : row.status === 'stopping' ? deadlineFromRow(row) : null
    if (!deadline || clock.decide(deadline).kind === 'uncertain') return 0
    return (deadline.monotonicNs - clock.sample().monotonicNs) / 1e6 + DECISION_GRACE_MS
  }

  function budget(rearmGeneration: number): number {
    const row = current()
    if (!row || row.rearm_generation !== rearmGeneration) return 0
    // Observer liveness and the future budget are separate: an overdue observer
    // has a bounded period in which a human may rearm it.
    return remaining(row) > 0 ? Math.max(0, finalDeadline - performance.now()) : 0
  }

  function poll(finalReport?: BridgeEvent): boolean {
    const row = current()
    if (!row || finalDeadline <= performance.now() || remaining(row) <= 0) return false
    if (row.status !== 'started' || mayUse(row)) return true
    const host = bridge.liveAttempt({ ...binding, rearmGeneration: row.rearm_generation })
    if (!host && unconfirmedSince !== undefined && performance.now() - unconfirmedSince >= FINAL_RECEIPT_GRACE_MS) return false
    const receipt = finalReport?.type === 'turn' && finalReport.attempt === binding.attempt
      && finalReport.executorAgentId === binding.executorAgentId
      && readFinalReceipt.get(binding.nodeRunId, binding.attempt, binding.executorAgentId, finalReport.seq)
    if (!host && !receipt) {
      if (finalReport) return false
      // A native idle transition can precede bridge ingestion of its final turn.
      // Allow the waiter to drain that receipt without granting live authority.
      unconfirmedSince ??= performance.now()
      return true
    }
    const hasToolCall = host?.hasToolCall ?? Boolean(readToolStart.get(binding.nodeRunId, binding.attempt,
      binding.actionGeneration, row.tool_start_at))
    const stoppedUsingTools = row.tool_start_at !== null && hasToolCall && leaseCurrent(row)
    const deadline = deadlineFromSample(clock, stoppedUsingTools ? 0 : deps.unknownWatchdogMs)
    const at = new Date(deadline.wallClockMs).toISOString()
    withTx(db, (tx) => {
      applyTransition(tx, secret, {
        nodeRunId: binding.nodeRunId, from: ['started'], to: stoppedUsingTools ? 'stopping' : 'startup_unknown',
        ruleId: stoppedUsingTools ? 'M-27' : 'M-31', attempt: binding.attempt,
        actionGeneration: binding.actionGeneration, rearmGeneration: row.rearm_generation, bumpRearm: true,
        expectedRevision: row.revision, now: nowAt(),
        context: { hasToolCall, cancelResult: 'unknown', hangReason: null, sideEffectVerifiedNone: false },
        patch: stoppedUsingTools ? {
          deadline_at: at, deadline_boot_id: deadline.bootId, deadline_monotonic_ns: deadline.monotonicNs, action_remaining_ns: 0,
        } : {
          deadline_at: null, deadline_boot_id: null, deadline_monotonic_ns: null, action_remaining_ns: null,
          startup_unknown_deadline_at: at, startup_unknown_boot_id: deadline.bootId, startup_unknown_monotonic_ns: deadline.monotonicNs,
          startup_unknown_remaining_ns: Math.round(deps.unknownWatchdogMs * 1e6),
        },
      })
      releaseLease(tx, { nodeRunId: binding.nodeRunId, now: nowAt() })
      appendNodeRunEvent(tx, secret, binding.nodeRunId, 'executor.observation_only', {
        attempt: binding.attempt, action_generation: binding.actionGeneration, executor_agent_id: binding.executorAgentId,
        rearm_generation: row.rearm_generation + 1,
      })
    })
    return true
  }

  return {
    binding,
    mayUseTools: () => mayUse(current()),
    budget,
    poll,
    lateStatus() {
      const row = current()
      if (row && (row.status === 'startup_unknown' || row.status === 'stopping' || row.status === 'abandoned_unverified')
        && budget(row.rearm_generation) > 0) {
        return { status: row.status, rearmGeneration: row.rearm_generation }
      }
    },
  }
}
