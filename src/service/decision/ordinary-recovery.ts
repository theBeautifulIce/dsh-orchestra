import { OrchError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import { isReleaseWorkflow } from '../../core/release-workflow-ids.ts'
import type { NodeStatus } from '../../core/state-machine.ts'
import { appendEvent, appendNodeRunEvent, assertChainIntact, chainIsIntact, readChain, readChainHead } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import type { UnsentAttemptBinding } from '../../executor/bridge.ts'
import { activeDecision, cancelDecision, openDecision, type ResolveDecisionRequest } from '../commands/decisions.ts'
import { releaseLease } from '../commands/lease.ts'
import { applyTransition } from '../commands/nodes.ts'
import { ORDINARY_RETIRED_UNSENT_EVENT as unsentEvent, settleRetiredUnsentAttempt } from '../commands/effects.ts'
import { createOrdinaryRetry, ordinaryRetryAuthority } from './ordinary-retry.ts'

type RecoveryKind = 'startup_unknown' | 'action_overrun' | 'verify_human'
const sourceOf = { startup_unknown: 'startup_unknown', action_overrun: 'stopping', verify_human: 'indeterminate_side_effect' } as const
const abandonRule = { startup_unknown: 'M-10', action_overrun: 'M-36', verify_human: 'M-53' } as const
const targetSummary = { startup_unknown: '这次执行的启动状态有待确认。', action_overrun: '这次执行已达到等待时限。',
  verify_human: '需要核实这次执行是否产生了外部操作。' } as const
const active = "('pending','acknowledged','blocked_for_human')"
const stopEvent = 'recovery.host_stopped'
const abandonEvent = 'decision.abandoned'
const abandonAckWindowMs = 24 * 60 * 60 * 1000
const clearStartupClock = {
  startup_unknown_deadline_at: null, startup_unknown_boot_id: null,
  startup_unknown_monotonic_ns: null, startup_unknown_remaining_ns: null,
}

export type OrdinaryRecoveryNode = {
  node_run_id: string; run_id: string; node_id: string; node_type: string; workflow_id: string | null
  seq: number
  status: NodeStatus; attempt: number; action_generation: number; rearm_generation: number; revision: number
  hang_reason: string | null; executor_agent_id: string | null; fence_state: string | null
  cancel_requested_at: string | null; run_cancel_requested_at: string | null
  executor_session_id: string | null; lease_id: string | null; lease_expires_at: string | null; owner_epoch: number | null
  replacement_node_run_id: string | null; side_effect_policy: string; wait_extensions: number
  startup_unknown_deadline_at: string | null; startup_unknown_boot_id: string | null; startup_unknown_monotonic_ns: number | null
  deadline_at: string | null; deadline_boot_id: string | null; deadline_monotonic_ns: number | null
}
type Node = OrdinaryRecoveryNode
export type OrdinaryRecoveryCard = { decision_id: string; run_id: string; node_run_id: string | null; kind: string; payload_json: string }
type Card = OrdinaryRecoveryCard
type Target = { node_run_id: string; attempt: number; action_generation: number; rearm_generation: number }
type RecoveryRead = Pick<Tx, 'get' | 'all'>

function ordinaryNode(tx: RecoveryRead, id: string): Node | undefined {
  const node = tx.get<Node>(`
    SELECT n.*, r.workflow_id, r.cancel_requested_at AS run_cancel_requested_at FROM node_runs n JOIN runs r USING(run_id)
    WHERE n.node_run_id=? AND n.node_type='agent' AND r.status IN ('running','paused')
      AND NOT EXISTS (SELECT 1 FROM memory_batches b WHERE b.memory_run_id=n.run_id)
  `, [id])
  return node && node.workflow_id !== 'sys.memory_write' && !isReleaseWorkflow(node.workflow_id ?? undefined) ? node : undefined
}

function identity(node: Target, rearm = node.rearm_generation): Target {
  return { node_run_id: node.node_run_id, attempt: node.attempt, action_generation: node.action_generation, rearm_generation: rearm }
}

export function openOrdinaryRecoveryDecision(tx: Tx, secret: string, nodeId: string, kind: RecoveryKind, now: string, id = 'dec_' + uuidv7()): boolean {
  const node = ordinaryNode(tx, nodeId)
  if (!node || node.status !== sourceOf[kind] || node.hang_reason !== null || activeDecision(tx, node.run_id, kind, nodeId)) return false
  openDecision(tx, { decisionId: id, runId: node.run_id, nodeRunId: nodeId, kind, approver: 'human', createdAt: now,
    payload: { ordinary_recovery: identity(node), target_summary: targetSummary[kind],
      required_evidence: kind === 'verify_human' ? ['宿主停止记录', '系统副作用核验证据'] : [] } })
  appendNodeRunEvent(tx, secret, nodeId, 'decision.recovery_opened', { decision_id: id, kind, ...identity(node) })
  return true
}

export function ordinaryRecoveryTarget(tx: RecoveryRead, card: Card): Node | undefined {
  if (!card.node_run_id || !Object.hasOwn(sourceOf, card.kind)) return undefined
  const kind = card.kind as RecoveryKind
  const node = ordinaryNode(tx, card.node_run_id)
  if (!node || node.run_id !== card.run_id || node.status !== sourceOf[kind] || node.fence_state === 'armed'
    || (node.hang_reason !== null && !(kind === 'action_overrun' && node.hang_reason === 'action_overrun'))) return undefined
  const expected = parseCard(card).ordinary_recovery
  if (!expected || expected.node_run_id !== node.node_run_id || expected.attempt !== node.attempt
    || expected.action_generation !== node.action_generation || expected.rearm_generation !== node.rearm_generation) return undefined
  return hasRecoveryOpening(tx, card, expected) ? node : undefined
}

function hasRecoveryOpening(tx: RecoveryRead, card: Card, target: Target): boolean {
  return Boolean(tx.get(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type IN ('decision.recovery_opened','decision.recovery_rearmed')
    AND json_extract(payload,'$.decision_id')=? AND json_extract(payload,'$.kind')=?
    AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?
    AND json_extract(payload,'$.rearm_generation')=?`,
  [target.node_run_id, card.decision_id, card.kind, target.attempt, target.action_generation, target.rearm_generation]))
}

function parseCard(card: Card): { ordinary_recovery?: Target; affected?: Target[] } {
  try { return JSON.parse(card.payload_json) ?? {} } catch { return {} }
}

export function ordinaryRecoveryBound(card: Card): boolean {
  const payload = parseCard(card)
  return card.kind === 'abandon_ack' ? Array.isArray(payload.affected) : !!payload.ordinary_recovery
}

export function retireOrdinaryStartupDecision(tx: Tx, secret: string, nodeId: string, now: string, reason: 'cancelled' | 'expired_final'): void {
  const card = tx.get<Card>("SELECT d.decision_id,d.run_id,d.node_run_id,d.kind,d.payload_json FROM decisions d"
    + " JOIN node_runs n ON n.node_run_id=d.node_run_id AND n.run_id=d.run_id"
    + " WHERE n.node_run_id=? AND n.status<>'startup_unknown' AND d.kind='startup_unknown' AND d.status IN " + active, [nodeId])
  const target = card && parseCard(card).ordinary_recovery
  if (card && target?.node_run_id === nodeId
    && chainIsIntact(secret, readChain(tx, nodeId), readChainHead(tx, nodeId), true)
    && hasRecoveryOpening(tx, card, target)) {
    cancelDecision(tx, secret, { decisionId: card.decision_id, reason, now })
  }
}

export function retireOrdinaryActionDecision(tx: Tx, secret: string, node: Target & { run_id: string }, now: string): void {
  const card = tx.get<Card>(`SELECT decision_id,run_id,node_run_id,kind,payload_json FROM decisions
    WHERE node_run_id=? AND run_id=? AND kind='action_overrun' AND status IN ${active}`, [node.node_run_id, node.run_id])
  const target = card && parseCard(card).ordinary_recovery
  if (card && target?.node_run_id === node.node_run_id && target.attempt === node.attempt
    && target.action_generation === node.action_generation && target.rearm_generation === node.rearm_generation
    && chainIsIntact(secret, readChain(tx, node.node_run_id), readChainHead(tx, node.node_run_id), true)
    && hasRecoveryOpening(tx, card, target)) {
    cancelDecision(tx, secret, { decisionId: card.decision_id, reason: 'cancelled', now })
  }
}

function canRecordUnsentAttempt(tx: RecoveryRead, node: Node): boolean {
  if (node.status !== 'startup_unknown' || node.executor_agent_id !== null || node.fence_state === 'armed'
    || node.hang_reason !== null || node.cancel_requested_at !== null || node.run_cancel_requested_at !== null) return false
  return !tx.get(`SELECT 1 FROM bridge_event_receipts WHERE node_run_id=?1 AND attempt=?2
    UNION ALL SELECT 1 FROM bridge_tool_outbox WHERE node_run_id=?1 AND attempt=?2
    UNION ALL SELECT 1 FROM tool_executions WHERE node_run_id=?1 AND attempt=?2
    UNION ALL SELECT 1 FROM report_registry WHERE node_run_id=?1 AND attempt=?2 LIMIT 1`, [node.node_run_id, node.attempt])
}

export function recordOrdinaryUnsentAttempt(tx: Tx, secret: string, binding: UnsentAttemptBinding, rearm: number, at: string): void {
  const node = ordinaryNode(tx, binding.nodeRunId)
  if (!node || node.attempt !== binding.attempt || node.action_generation !== binding.actionGeneration
    || node.rearm_generation !== rearm || !canRecordUnsentAttempt(tx, node)) return
  assertChainIntact(tx, secret, binding.nodeRunId)
  appendNodeRunEvent(tx, secret, binding.nodeRunId, unsentEvent, {
    ...identity(node), executor_agent_id: binding.executorAgentId, stopped_at: at,
  })
}

export function ordinaryUnsentAttempt(tx: RecoveryRead, node: Node): { seq: number; executor_agent_id: string; stopped_at: string } | undefined {
  if (!canRecordUnsentAttempt(tx, node)) return undefined
  return tx.get(`SELECT seq, json_extract(payload,'$.executor_agent_id') AS executor_agent_id,
    json_extract(payload,'$.stopped_at') AS stopped_at FROM node_run_events
    WHERE node_run_id=? AND type=? AND json_valid(payload) AND json_extract(payload,'$.attempt')=?
      AND json_extract(payload,'$.action_generation')=? AND json_extract(payload,'$.rearm_generation')=?
      AND json_type(payload,'$.executor_agent_id')='text' AND json_type(payload,'$.stopped_at')='text'
    ORDER BY seq DESC LIMIT 1`, [node.node_run_id, unsentEvent, node.attempt, node.action_generation, node.rearm_generation])
}

export function confirmOrdinaryUnsentAttempt(tx: Tx, secret: string, card: Card, req: ResolveDecisionRequest): void {
  const node = ordinaryRecoveryTarget(tx, card)
  const receipt = node && ordinaryUnsentAttempt(tx, node)
  if (card.kind !== 'startup_unknown' || !node || !receipt || !(Date.parse(receipt.stopped_at) <= Date.parse(req.now))
    || req.actor?.kind !== 'human' || Object.keys(req.payload ?? {}).length !== 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '确认未启动需要当前执行尝试的宿主停止凭据')
  }
  assertChainIntact(tx, secret, node.node_run_id)
  const retry = ordinaryRetryAuthority(tx, node)
  applyTransition(tx, secret, { nodeRunId: node.node_run_id, from: ['startup_unknown'],
    to: retry ? 'superseded' : 'failed', ruleId: retry ? 'M-06' : 'M-07',
    attempt: node.attempt, expectedRevision: node.revision, actionGeneration: node.action_generation,
    rearmGeneration: node.rearm_generation, now: req.now,
    context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: false },
    patch: { ...clearStartupClock, deadline_at: null, deadline_boot_id: null, deadline_monotonic_ns: null, action_remaining_ns: null } })
  releaseLease(tx, { nodeRunId: node.node_run_id, now: req.now })
  settleRetiredUnsentAttempt(tx, secret, { nodeRunId: node.node_run_id, attempt: node.attempt, actionGeneration: node.action_generation,
    rearmGeneration: node.rearm_generation, receiptSeq: receipt.seq, decisionId: card.decision_id, now: req.now })
  appendNodeRunEvent(tx, secret, node.node_run_id, 'decision.startup_confirmed_unsent', {
    ...identity(node), executor_agent_id: receipt.executor_agent_id, stopped_at: receipt.stopped_at,
    stop_receipt_seq: receipt.seq, decision_id: card.decision_id, decision_revision: req.revision + 1,
    actor_id: req.actor.id, occurred_at: req.now,
  })
  if (retry) createOrdinaryRetry(tx, secret, node, {
    decisionId: card.decision_id, revision: req.revision + 1, definitionHash: retry, now: req.now,
  })
}

export function ordinaryAbandonTargets(tx: RecoveryRead, card: Card): Node[] {
  if (card.kind !== 'abandon_ack' || card.node_run_id !== null) return []
  const targets = parseCard(card).affected
  if (!Array.isArray(targets) || targets.length === 0) return []
  const membership = tx.get<{ n: number }>(`SELECT COUNT(DISTINCT n.node_run_id) AS n
    FROM node_runs n JOIN node_run_events e USING(node_run_id)
    WHERE n.run_id=? AND e.type=? AND json_valid(e.payload) AND json_extract(e.payload,'$.abandon_ack_id')=?`,
  [card.run_id, abandonEvent, card.decision_id])
  if (membership?.n !== targets.length) return []
  const nodes: Node[] = []
  for (const target of targets) {
    if (!target || typeof target.node_run_id !== 'string' || nodes.some(node => node.node_run_id === target.node_run_id)) return []
    const node = ordinaryNode(tx, target.node_run_id)
    if (!node || node.run_id !== card.run_id || node.status !== 'abandoned_unverified' || node.hang_reason !== null
      || node.attempt !== target.attempt || node.action_generation !== target.action_generation || node.rearm_generation !== target.rearm_generation
      || !tx.get(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type=?
        AND json_extract(payload,'$.abandon_ack_id')=? AND json_extract(payload,'$.attempt')=?
        AND json_extract(payload,'$.action_generation')=? AND json_extract(payload,'$.rearm_generation')=?`,
      [node.node_run_id, abandonEvent, card.decision_id, node.attempt, node.action_generation, node.rearm_generation])) return []
    nodes.push(node)
  }
  return nodes
}

export function abandonOrdinaryRecovery(tx: Tx, secret: string, card: Card, req: ResolveDecisionRequest): void {
  const node = ordinaryRecoveryTarget(tx, card)
  if (!node || req.actor?.kind !== 'human' || Object.keys(req.payload ?? {}).length !== 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '停止跟踪需要对应当前执行尝试的人工裁决')
  }
  const currentAck = tx.get<{ decision_id: string; revision: number; payload_json: string }>(
    "SELECT decision_id,revision,payload_json FROM decisions WHERE run_id=? AND node_run_id IS NULL AND kind='abandon_ack' AND status IN " + active,
    [node.run_id],
  )
  const ackId = currentAck?.decision_id ?? 'dec_' + uuidv7()
  const affected = identity(node, node.rearm_generation + 1)
  if (currentAck) {
    const existing = ordinaryAbandonTargets(tx, { ...currentAck, run_id: node.run_id, kind: 'abandon_ack', node_run_id: null })
    if (existing.length === 0) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '运行已有待处理且无法合并的签字卡')
    const changed = tx.run("UPDATE decisions SET revision=revision+1,payload_json=json_insert(payload_json,'$.affected[#]',json(?)) "
      + 'WHERE decision_id=? AND revision=? AND status IN ' + active, [JSON.stringify(affected), ackId, currentAck.revision])
    if (changed.changes !== 1) throw new OrchError('DECISION_REVISION_CONFLICT', '放弃跟踪签字卡已变更')
  } else {
    openDecision(tx, { decisionId: ackId, runId: node.run_id, nodeRunId: null, kind: 'abandon_ack', approver: 'human', createdAt: req.now,
      expiresAt: new Date(Date.parse(req.now) + abandonAckWindowMs).toISOString(),
      payload: { affected: [affected], target_summary: '签字接受所列步骤的副作用仍未核实。' } })
  }
  applyTransition(tx, secret, { nodeRunId: node.node_run_id, from: [node.status], to: 'abandoned_unverified',
    ruleId: abandonRule[card.kind as RecoveryKind], attempt: node.attempt, expectedRevision: node.revision,
    actionGeneration: node.action_generation, rearmGeneration: node.rearm_generation, bumpRearm: true, now: req.now,
    allowHung: node.hang_reason === 'action_overrun', patch: { ...clearStartupClock, hang_reason: null,
      deadline_at: null, deadline_boot_id: null, deadline_monotonic_ns: null, action_remaining_ns: null },
  })
  releaseLease(tx, { nodeRunId: node.node_run_id, now: req.now })
  appendNodeRunEvent(tx, secret, node.node_run_id, abandonEvent, {
    ...affected, decision_id: card.decision_id, decision_revision: req.revision + 1, abandon_ack_id: ackId,
    actor_id: req.actor.id, occurred_at: req.now,
  })
  appendEvent(tx, { type: 'decision.abandon_ack_requested', runId: node.run_id, nodeRunId: node.node_run_id, decisionId: ackId,
    payload: { ...affected, revision: (currentAck?.revision ?? 0) + 1 } })
}

export function signOrdinaryAbandon(tx: Tx, secret: string, card: Card, req: ResolveDecisionRequest): void {
  const nodes = ordinaryAbandonTargets(tx, card)
  if (nodes.length === 0 || req.actor?.kind !== 'human' || Object.keys(req.payload ?? {}).length !== 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '签字需要当前未核实步骤和人工审批人')
  }
  for (const node of nodes) {
    if (!chainIsIntact(secret, readChain(tx, node.node_run_id), readChainHead(tx, node.node_run_id), true)) {
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '相关步骤的事件链不完整')
    }
    appendNodeRunEvent(tx, secret, node.node_run_id, 'decision.abandon_signed', {
      ...identity(node), decision_id: card.decision_id, decision_revision: req.revision + 1, actor_id: req.actor.id, occurred_at: req.now,
    })
  }
}

/** Called only after the ordinary executor's host lifecycle confirmed stop and disposal. */
export function recordOrdinaryHostStop(tx: Tx, secret: string, p: {
  nodeRunId: string; attempt: number; generation: number; agentId: string; stoppedAt: string
}): void {
  const node = ordinaryNode(tx, p.nodeRunId)
  if (!node || node.attempt !== p.attempt || node.action_generation !== p.generation || node.executor_agent_id !== p.agentId) return
  if (tx.get("SELECT 1 FROM bridge_tool_outbox WHERE node_run_id=? AND attempt=? AND status='pending'", [node.node_run_id, node.attempt])) return
  assertChainIntact(tx, secret, p.nodeRunId)
  appendNodeRunEvent(tx, secret, p.nodeRunId, stopEvent, {
    attempt: p.attempt, action_generation: p.generation, executor_agent_id: p.agentId, stopped_at: p.stoppedAt,
  })
}

export function ordinaryHostStop(tx: RecoveryRead, secret: string, node: Pick<Node, 'node_run_id' | 'attempt' | 'action_generation' | 'executor_agent_id'>): string | undefined {
  const stopped = tx.get<{ stopped_at: string }>(`SELECT json_extract(payload,'$.stopped_at') AS stopped_at
    FROM node_run_events WHERE node_run_id=? AND type=? AND json_extract(payload,'$.attempt')=?
      AND json_extract(payload,'$.action_generation')=? AND json_extract(payload,'$.executor_agent_id')=? ORDER BY seq DESC LIMIT 1`,
  [node.node_run_id, stopEvent, node.attempt, node.action_generation, node.executor_agent_id])
  if (!stopped || !Number.isFinite(Date.parse(stopped.stopped_at))
    || !chainIsIntact(secret, readChain(tx, node.node_run_id), readChainHead(tx, node.node_run_id), true)) return undefined
  return stopped.stopped_at
}

export type OrdinaryEffectEvidence = { applied?: string; not_applied?: string }

export function ordinaryEffectEvidence(tx: RecoveryRead, node: Node): OrdinaryEffectEvidence {
  if (!['stopping', 'indeterminate_side_effect'].includes(node.status)) return {}
  if (!tx.get(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type=? AND json_valid(payload)
    AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?
    AND json_extract(payload,'$.executor_agent_id')=?`, [node.node_run_id, stopEvent, node.attempt, node.action_generation, node.executor_agent_id])) return {}
  const evidence: OrdinaryEffectEvidence = {}
  const receipts = tx.all<{ verdict: keyof OrdinaryEffectEvidence; execution_id: string }>(`
    SELECT json_extract(e.payload,'$.effect_proof.verdict') AS verdict, t.execution_id
    FROM node_run_events e JOIN tool_executions t ON t.execution_id=json_extract(e.payload,'$.execution_id')
    WHERE e.node_run_id=? AND e.type='tool_finished' AND t.node_run_id=e.node_run_id AND t.attempt=?
      AND t.exit_code=0 AND t.finished_at IS NOT NULL AND json_extract(e.payload,'$.attempt')=?
      AND json_extract(e.payload,'$.action_generation')=?
      AND json_extract(e.payload,'$.effect_proof.verdict') IN ('applied','not_applied')
    ORDER BY e.seq DESC`, [node.node_run_id, node.attempt, node.attempt, node.action_generation])
  for (const receipt of receipts) evidence[receipt.verdict] ??= receipt.execution_id
  if (evidence.applied && evidence.not_applied) return {}
  if (node.status === 'stopping') delete evidence.not_applied
  return evidence
}

export function ordinaryEffectResolution(tx: Tx, secret: string, card: Card, req: ResolveDecisionRequest) {
  const node = ordinaryRecoveryTarget(tx, card)
  const verdict = req.resolution === 'confirm_applied' ? 'applied' : 'not_applied'
  const evidenceIds = req.payload?.evidence_ids
  const stoppedAt = node && ordinaryHostStop(tx, secret, node)
  if (!node || !stoppedAt || Date.parse(stoppedAt) > Date.parse(req.now) || req.actor?.kind !== 'human'
    || !Array.isArray(evidenceIds) || evidenceIds.length !== 1 || Object.keys(req.payload ?? {}).length !== 1
    || ordinaryEffectEvidence(tx, node)[verdict] !== evidenceIds[0]) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '需要当前尝试的宿主停止记录和对应业务核验证据')
  }
  const retry = verdict === 'not_applied' ? ordinaryRetryAuthority(tx, node) : undefined
  return { node, verdict, evidenceId: evidenceIds[0] as string, stoppedAt, retry }
}

export function applyOrdinaryEffectResolution(tx: Tx, secret: string, req: ResolveDecisionRequest,
  result: ReturnType<typeof ordinaryEffectResolution>,
): void {
  const { node, verdict, stoppedAt, evidenceId, retry } = result
  const current = tx.get<{ revision: number }>('SELECT revision FROM node_runs WHERE node_run_id=?', [node.node_run_id])!
  applyTransition(tx, secret, {
    nodeRunId: node.node_run_id, from: [node.status], to: verdict === 'applied' ? 'done' : retry ? 'superseded' : 'failed',
    ruleId: verdict === 'not_applied' ? 'M-52' : node.status === 'stopping' ? 'M-33' : 'M-51',
    attempt: node.attempt, actionGeneration: node.action_generation, rearmGeneration: node.rearm_generation,
    expectedRevision: current.revision, now: req.now, allowHung: node.hang_reason === 'action_overrun',
    patch: { hang_reason: null, deadline_at: null, deadline_boot_id: null, deadline_monotonic_ns: null, action_remaining_ns: null },
  })
  releaseLease(tx, { nodeRunId: node.node_run_id, now: req.now })
  appendNodeRunEvent(tx, secret, node.node_run_id, 'decision.effect_reconciled', {
    ...identity(node), decision_id: req.decisionId, revision: req.revision + 1,
    verdict, evidence_id: evidenceId, stopped_at: stoppedAt, actor_id: req.actor!.id,
  })
  if (retry) createOrdinaryRetry(tx, secret, node, {
    decisionId: req.decisionId, revision: req.revision + 1, definitionHash: retry, now: req.now,
  })
}

/** An abandonment signature releases the human gate, while shutdown remains independently required. */
export function hasUnfinishedOrdinaryAbandon(tx: Tx, secret: string, runId: string): boolean {
  const nodes = tx.all<Node & { abandon_ack_id: string }>(`SELECT n.*, json_extract(e.payload,'$.abandon_ack_id') AS abandon_ack_id
    FROM node_runs n JOIN node_run_events e ON e.node_run_id=n.node_run_id AND e.seq=(
      SELECT MAX(seq) FROM node_run_events WHERE node_run_id=n.node_run_id AND type=?
    ) WHERE n.run_id=? AND n.status='abandoned_unverified'`, [abandonEvent, runId])
  return nodes.some(node => !tx.get(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='decision.abandon_signed'
    AND json_extract(payload,'$.decision_id')=? AND json_extract(payload,'$.attempt')=?
    AND json_extract(payload,'$.action_generation')=? AND json_extract(payload,'$.rearm_generation')=?`,
  [node.node_run_id, node.abandon_ack_id, node.attempt, node.action_generation, node.rearm_generation]) || !ordinaryHostStop(tx, secret, node))
}

export function expireOrdinaryAbandon(tx: Tx, secret: string, card: Card, now: string): boolean {
  const nodes = ordinaryAbandonTargets(tx, card)
  if (nodes.length === 0 || nodes.some(node => !chainIsIntact(secret, readChain(tx, node.node_run_id), readChainHead(tx, node.node_run_id), true))) return false
  if (!cancelDecision(tx, secret, { decisionId: card.decision_id, reason: 'expired_final', now }).changed) return false
  tx.run("UPDATE runs SET status='paused', revision=revision+1, updated_at=? WHERE run_id=? AND status='running'", [now, card.run_id])
  appendEvent(tx, { type: 'decision.abandon_ack_expired', decisionId: card.decision_id, runId: card.run_id,
    payload: { affected: nodes.map(node => node.node_run_id), occurred_at: now, reason: 'unverified_effect_ack_missing' } })
  return true
}

export function closeTerminalOrdinaryRecoveryCards(tx: Tx, secret: string, runId: string, now: string): void {
  const cards = tx.all<{ decision_id: string; node_run_id: string }>(`SELECT d.decision_id, n.node_run_id
    FROM decisions d JOIN node_runs n ON n.node_run_id=d.node_run_id AND n.run_id=d.run_id
    WHERE d.run_id=? AND d.kind IN ('startup_unknown','action_overrun','verify_human') AND d.status IN ${active}
      AND n.status IN ('done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded')
      AND json_type(CASE WHEN json_valid(d.payload_json) THEN d.payload_json END,'$.ordinary_recovery')='object'`, [runId])
  for (const card of cards) {
    if (chainIsIntact(secret, readChain(tx, card.node_run_id), readChainHead(tx, card.node_run_id), true)) {
      cancelDecision(tx, secret, { decisionId: card.decision_id, reason: 'cancelled', now })
    }
  }
}
