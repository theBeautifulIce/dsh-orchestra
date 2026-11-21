import { deadlineFromAnchors, deadlineFromSample, deadlineFromRow, type ClockProvider, type Deadline } from '../../core/clock.ts'
import { OrchError } from '../../core/errors.ts'
import type { LiveAttemptBinding, LiveAttemptObservation } from '../../executor/bridge.ts'
import { appendNodeRunEvent, chainIsIntact, readChain, readChainHead } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import type { Resolution, ResolveDecisionRequest } from '../commands/decisions.ts'
import { applyTransition } from '../commands/nodes.ts'
import { ordinaryAbandonTargets, ordinaryHostStop, ordinaryRecoveryTarget, type OrdinaryRecoveryCard, type OrdinaryRecoveryNode } from './ordinary-recovery.ts'

const TRACKING_MS = 120_000
const MAX_WAIT_EXTENSIONS = 3
const CLEAR_STARTUP = { startup_unknown_deadline_at: null, startup_unknown_boot_id: null,
  startup_unknown_monotonic_ns: null, startup_unknown_remaining_ns: null }
const CLEAR_ACTION = { deadline_at: null, deadline_boot_id: null, deadline_monotonic_ns: null, action_remaining_ns: null }

type Read = Pick<Tx, 'get' | 'all'>
type Card = OrdinaryRecoveryCard & { status: string }
type ToolStart = { bootId: string; wallClockMs: number; monotonicNs: number; timeoutMs: number }
type LiveNode = { node: OrdinaryRecoveryNode; proof: LiveAttemptObservation; leaseId: string; tool?: ToolStart }
type LiveResolution = 'confirm_started' | 'confirm_started_attested' | 'continue_tracking' | 'continue_wait' | 'rejected'
export type OrdinaryLiveRecovery = {
  secret: string
  ownerEpoch: number
  clock: ClockProvider
  liveAttempt: (binding: LiveAttemptBinding) => LiveAttemptObservation | undefined
}

function observe(tx: Read, node: OrdinaryRecoveryNode, recovery: OrdinaryLiveRecovery): LiveNode | undefined {
  if (!node.executor_agent_id || !node.executor_session_id || node.owner_epoch !== recovery.ownerEpoch
    || node.replacement_node_run_id || node.cancel_requested_at || node.run_cancel_requested_at || node.fence_state
    || !chainIsIntact(recovery.secret, readChain(tx, node.node_run_id), readChainHead(tx, node.node_run_id), true)) return undefined
  // The signed lease identifies the original dispatch even after control authority has been revoked.
  const lease = tx.get<{ lease_id: string }>(`SELECT l.lease_id FROM node_run_events e
    JOIN leases l ON l.lease_id=json_extract(e.payload,'$.lease_id') AND l.node_run_id=e.node_run_id
    WHERE e.node_run_id=? AND e.type='lease_acquired' AND json_extract(e.payload,'$.action_generation')=?
    AND l.owner_epoch=? ORDER BY e.seq DESC LIMIT 1`, [node.node_run_id, node.action_generation, node.owner_epoch])
  if (!lease || (node.lease_id && node.lease_id !== lease.lease_id) || ordinaryHostStop(tx, recovery.secret, node)) return undefined
  let proof: LiveAttemptObservation | undefined
  try {
    proof = recovery.liveAttempt({ nodeRunId: node.node_run_id, attempt: node.attempt, actionGeneration: node.action_generation,
      rearmGeneration: node.rearm_generation, executorAgentId: node.executor_agent_id, executorSessionId: node.executor_session_id })
  } catch {
    return undefined
  }
  if (!proof || !Number.isSafeInteger(proof.actionTimeoutMs) || proof.actionTimeoutMs <= 0
    || !Number.isFinite(proof.observationBudgetMs) || proof.observationBudgetMs <= 0
    || (!proof.hasToolCall && proof.lastToolCallId !== undefined)) return undefined
  return { node, proof, leaseId: lease.lease_id, tool: proof.lastToolCallId
    ? readToolStart(tx, node, lease.lease_id, proof.lastToolCallId, recovery.clock) : undefined }
}

function readToolStart(tx: Read, node: OrdinaryRecoveryNode, leaseId: string, callId: string, clock: ClockProvider): ToolStart | undefined {
  const event = tx.get<{ started_at: string; boot_id: string; monotonic_ns: number; timeout_ms: number }>(`SELECT
    json_extract(e.payload,'$.started_at') AS started_at, json_extract(e.payload,'$.started_boot_id') AS boot_id,
    json_extract(e.payload,'$.started_monotonic_ns') AS monotonic_ns, json_extract(e.payload,'$.timeout_ms') AS timeout_ms
    FROM node_run_events e
    WHERE e.node_run_id=? AND e.type='tool_started' AND json_extract(e.payload,'$.attempt')=?
    AND json_extract(e.payload,'$.action_generation')=? AND json_extract(e.payload,'$.call_id')=?
    AND e.seq>(SELECT MAX(seq) FROM node_run_events WHERE node_run_id=e.node_run_id AND type='lease_acquired'
      AND json_extract(payload,'$.lease_id')=?)
    ORDER BY e.seq DESC LIMIT 1`, [node.node_run_id, node.attempt, node.action_generation, callId, leaseId])
  const time = Date.parse(event?.started_at ?? '')
  const now = clock.sample()
  if (!event || !Number.isFinite(time) || event.boot_id !== now.bootId || !Number.isSafeInteger(event.monotonic_ns)
    || event.monotonic_ns > now.monotonicNs || !Number.isSafeInteger(event.timeout_ms) || event.timeout_ms <= 0) return undefined
  return { bootId: event.boot_id, wallClockMs: time, monotonicNs: event.monotonic_ns, timeoutMs: event.timeout_ms }
}

function originalWindow(live: LiveNode): number | undefined {
  if (live.tool) return Math.min(live.tool.timeoutMs, live.proof.actionTimeoutMs)
  return live.proof.hasToolCall ? undefined : live.proof.actionTimeoutMs
}

function healthyClock(clock: ClockProvider): boolean {
  return clock.decide(deadlineFromSample(clock, 10_000)).kind === 'pending'
}

function availability(tx: Read, card: Card, recovery?: OrdinaryLiveRecovery): { choices: LiveResolution[]; targets: LiveNode[] } {
  const choices: LiveResolution[] = []
  const targets: LiveNode[] = []
  if (!recovery || !healthyClock(recovery.clock)) return { choices, targets }
  if (card.kind === 'abandon_ack') {
    const nodes = ordinaryAbandonTargets(tx, card)
    for (const node of nodes) {
      // The retained observer is available after release of the execution lease.
      if (node.lease_id !== null) return { choices, targets: [] }
      const live = observe(tx, node, recovery)
      const duration = live && originalWindow(live)
      if (!live || duration === undefined || live.proof.observationBudgetMs < duration) return { choices, targets: [] }
      targets.push(live)
    }
    if (targets.length) choices.push('rejected')
    return { choices, targets }
  }
  const target = ordinaryRecoveryTarget(tx, card)
  if (!target || !['startup_unknown', 'action_overrun'].includes(card.kind)) return { choices, targets }
  const live = observe(tx, target, recovery)
  if (!live) return { choices, targets }
  targets.push(live)
  const { proof, node } = live
  const { clock } = recovery
  const duration = originalWindow(live)
  if (card.kind === 'action_overrun') {
    const anchor = deadlineFromRow(node)
    if (['pending', 'acknowledged'].includes(card.status) && node.wait_extensions < MAX_WAIT_EXTENSIONS
      && anchor && clock.decide(anchor).kind === 'expired' && duration !== undefined
      && proof.observationBudgetMs >= duration) choices.push('continue_wait')
    return { choices, targets }
  }
  const anchor = deadlineFromAnchors({ deadlineAt: node.startup_unknown_deadline_at,
    bootId: node.startup_unknown_boot_id, monotonicNs: node.startup_unknown_monotonic_ns })
  if (anchor && clock.decide(anchor).kind === 'pending') {
    const elapsed = live.tool ? (clock.sample().monotonicNs - live.tool.monotonicNs) / 1e6 : 0
    if (duration !== undefined && (proof.hasToolCall ? live.tool !== undefined : proof.observedRunning)
      && proof.observationBudgetMs >= Math.max(0, duration - elapsed)) choices.push('confirm_started')
    if (proof.observationBudgetMs >= (duration ?? proof.actionTimeoutMs)) choices.push('confirm_started_attested')
    if (proof.observationBudgetMs >= TRACKING_MS) choices.push('continue_tracking')
  }
  return { choices, targets }
}

export function ordinaryLiveChoices(tx: Read, card: Card, recovery?: OrdinaryLiveRecovery): Resolution[] {
  return availability(tx, card, recovery).choices
}

export function isOrdinaryLiveResolution(card: OrdinaryRecoveryCard, resolution: Resolution): resolution is LiveResolution {
  return resolution === 'confirm_started' || resolution === 'confirm_started_attested' || resolution === 'continue_tracking'
    || resolution === 'continue_wait' || (resolution === 'rejected' && card.kind === 'abandon_ack')
}

function actionClock(deadline: Deadline, remainingMs: number) {
  return { deadline_at: new Date(deadline.wallClockMs).toISOString(), deadline_boot_id: deadline.bootId,
    deadline_monotonic_ns: deadline.monotonicNs, action_remaining_ns: Math.round(remainingMs * 1e6) }
}

export function applyOrdinaryLiveResolution(tx: Tx, card: Card, req: ResolveDecisionRequest & { resolution: LiveResolution },
  recovery?: OrdinaryLiveRecovery): { closing: boolean; payload: Record<string, unknown> } {
  const { resolution, actor } = req
  const proof = availability(tx, card, recovery)
  if (!recovery || !proof.choices.includes(resolution) || actor?.kind !== 'human') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '宿主当前无法继续观察这次执行，或本次等待时限尚未到期')
  }
  const attested = resolution === 'confirm_started_attested'
  const attestationId = req.payload?.attestation_id
  if (attested ? Object.keys(req.payload ?? {}).length !== 1 || typeof attestationId !== 'string'
    || !/^att_[a-zA-Z0-9_-]{1,96}$/.test(attestationId)
    || !!tx.get('SELECT 1 FROM attestations WHERE attestation_id=?', [attestationId]) : Object.keys(req.payload ?? {}).length !== 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '人工签认需要唯一的签认编号，其他续跟操作无需提交材料')
  }
  const renewTracking = resolution === 'continue_tracking'
  const renewWait = resolution === 'continue_wait'
  const restoring = resolution === 'rejected'
  const closing = !renewTracking && !renewWait
  const payload: Record<string, unknown> = { resolution }
  for (const live of proof.targets) {
    const { node, leaseId } = live
    const hasToolCall = live.proof.hasToolCall
    const ruleId = renewTracking ? 'M-57' : renewWait ? 'M-34' : restoring ? 'M-37' : attested ? 'M-09' : hasToolCall ? 'M-61' : 'M-08'
    const actionStartSource = closing && !restoring ? (attested ? 'human_attested' : 'human_confirmed') : undefined
    const duration = renewTracking ? TRACKING_MS : originalWindow(live) ?? live.proof.actionTimeoutMs
    const started = ruleId === 'M-61' ? live.tool : undefined
    const deadline = started ? { bootId: started.bootId, wallClockMs: started.wallClockMs + duration,
      monotonicNs: started.monotonicNs + duration * 1e6 } : deadlineFromSample(recovery.clock, duration)
    const remaining = started ? Math.max(0, (deadline.monotonicNs - recovery.clock.sample().monotonicNs) / 1e6) : duration
    const waiting = { ...CLEAR_ACTION, startup_unknown_deadline_at: new Date(deadline.wallClockMs).toISOString(),
      startup_unknown_boot_id: deadline.bootId, startup_unknown_monotonic_ns: deadline.monotonicNs,
      startup_unknown_remaining_ns: TRACKING_MS * 1e6 }
    const original = { node_run_id: node.node_run_id, attempt: node.attempt,
      action_generation: node.action_generation, rearm_generation: node.rearm_generation + 1 }
    applyTransition(tx, recovery.secret, { nodeRunId: node.node_run_id, from: [node.status], to: renewTracking ? 'startup_unknown' : 'stopping',
      ruleId, attempt: node.attempt, actionGeneration: node.action_generation, rearmGeneration: node.rearm_generation,
      expectedRevision: node.revision, bumpRearm: true, now: req.now, allowHung: renewWait && node.hang_reason === 'action_overrun',
      context: { hasToolCall, cancelResult: null, hangReason: null, sideEffectVerifiedNone: false },
      patch: { hang_reason: null, ...(renewTracking ? waiting : { ...CLEAR_STARTUP, ...actionClock(deadline, remaining) }),
        ...(renewWait && { wait_extensions: node.wait_extensions + 1 }), ...(actionStartSource && { action_start_source: actionStartSource }) },
    })
    if (attested) {
      tx.run(`INSERT INTO attestations (attestation_id,run_id,node_run_id,attempt,claim,attested_by,attested_at,action_start_source,created_at)
        VALUES (?,?,?,?,'action_started',?,?,'human_attested',?)`, [attestationId, node.run_id, node.node_run_id, node.attempt, actor.id, req.now, req.now])
      payload.attestation_id = attestationId
    }
    if (!closing) payload.ordinary_recovery = original
    if (renewWait) payload.wait_extensions = node.wait_extensions + 1
    appendNodeRunEvent(tx, recovery.secret, node.node_run_id, closing ? 'decision.recovery_resolved' : 'decision.recovery_rearmed', {
      ...original, decision_id: card.decision_id, decision_revision: req.revision + 1, kind: card.kind, resolution, rule_id: ruleId,
      actor_id: actor.id, executor_agent_id: node.executor_agent_id, executor_session_id: node.executor_session_id, lease_id: leaseId,
      deadline_at: new Date(deadline.wallClockMs).toISOString(), ...(renewWait && { wait_extensions: node.wait_extensions + 1 }),
      ...(actionStartSource && { action_start_source: actionStartSource }), ...(attested && { attestation_id: attestationId }),
      ...(restoring && { abandon_ack_id: card.decision_id }),
    })
  }
  return { closing, payload }
}
