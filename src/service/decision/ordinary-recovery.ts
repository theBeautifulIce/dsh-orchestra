import { OrchError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import { isReleaseWorkflow } from '../../core/release-workflow-ids.ts'
import type { NodeStatus } from '../../core/state-machine.ts'
import { appendEvent, appendNodeRunEvent, assertChainIntact, chainIsIntact, readChain, readChainHead } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { activeDecision, cancelDecision, openDecision, type ResolveDecisionRequest } from '../commands/decisions.ts'
import { releaseLease } from '../commands/lease.ts'
import { applyTransition } from '../commands/nodes.ts'

type RecoveryKind = 'startup_unknown' | 'action_overrun' | 'verify_human'
const sourceOf = { startup_unknown: 'startup_unknown', action_overrun: 'stopping', verify_human: 'indeterminate_side_effect' } as const
const abandonRule = { startup_unknown: 'M-10', action_overrun: 'M-36', verify_human: 'M-53' } as const
const active = "('pending','acknowledged','blocked_for_human')"
const stopEvent = 'recovery.host_stopped'
const abandonEvent = 'decision.abandoned'
const clearStartupClock = {
  startup_unknown_deadline_at: null, startup_unknown_boot_id: null,
  startup_unknown_monotonic_ns: null, startup_unknown_remaining_ns: null,
}

type Node = {
  node_run_id: string; run_id: string; node_type: string; workflow_id: string | null
  status: NodeStatus; attempt: number; action_generation: number; rearm_generation: number; revision: number
  hang_reason: string | null; executor_agent_id: string | null; fence_state: string | null
}
type Card = { decision_id: string; run_id: string; node_run_id: string | null; kind: string; payload_json: string }
type Target = { node_run_id: string; attempt: number; action_generation: number; rearm_generation: number }
type RecoveryRead = Pick<Tx, 'get' | 'all'>

function ordinaryNode(tx: RecoveryRead, id: string): Node | undefined {
  const node = tx.get<Node>(`
    SELECT n.*, r.workflow_id FROM node_runs n JOIN runs r USING(run_id)
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
    payload: { ordinary_recovery: identity(node), required_evidence: kind === 'verify_human' ? ['宿主停止记录', '系统副作用核验证据'] : [] } })
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
  const event = tx.get(`SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='decision.recovery_opened'
    AND json_extract(payload,'$.decision_id')=? AND json_extract(payload,'$.kind')=?
    AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?
    AND json_extract(payload,'$.rearm_generation')=?`,
  [node.node_run_id, card.decision_id, kind, node.attempt, node.action_generation, node.rearm_generation])
  return event ? node : undefined
}

function parseCard(card: Card): { ordinary_recovery?: Target; affected?: Target[] } {
  try { return JSON.parse(card.payload_json) ?? {} } catch { return {} }
}

export function ordinaryRecoveryBound(card: Card): boolean {
  const payload = parseCard(card)
  return card.kind === 'abandon_ack' ? Array.isArray(payload.affected) : !!payload.ordinary_recovery
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

export function ordinaryHostStop(tx: Tx, secret: string, node: Pick<Node, 'node_run_id' | 'attempt' | 'action_generation' | 'executor_agent_id'>): string | undefined {
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
  return { node, verdict, evidenceId: evidenceIds[0] as string, stoppedAt }
}

export function applyOrdinaryEffectResolution(tx: Tx, secret: string, req: ResolveDecisionRequest,
  result: ReturnType<typeof ordinaryEffectResolution>,
): void {
  const { node, verdict, stoppedAt, evidenceId } = result
  const current = tx.get<{ revision: number }>('SELECT revision FROM node_runs WHERE node_run_id=?', [node.node_run_id])!
  applyTransition(tx, secret, {
    nodeRunId: node.node_run_id, from: [node.status], to: verdict === 'applied' ? 'done' : 'failed',
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
}

/** An abandonment signature releases the human gate, while shutdown remains independently required. */
export function hasUnfinishedOrdinaryAbandon(tx: Tx, secret: string, runId: string): boolean {
  const nodes = tx.all<Node>(`SELECT n.* FROM node_runs n WHERE n.run_id=? AND n.status='abandoned_unverified'
    AND EXISTS(SELECT 1 FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type=?)`, [runId, abandonEvent])
  return nodes.some(node => !ordinaryHostStop(tx, secret, node))
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
