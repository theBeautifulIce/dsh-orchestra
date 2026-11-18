import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'
import { decisionId, nodeRunId } from '../../core/ids.ts'
import { isTerminal } from '../../core/state-machine.ts'
import { appendEvent, appendNodeRunEvent, assertChainIntact, readChain } from '../../infra/db/ledger.ts'
import { inTx, runCas } from '../../infra/db/tx.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
import type { Actor } from '../decision/approver.ts'
import { openDecision, resolveMemoryRecoveryDecision } from './decisions.ts'
import { assertOperationId, requestHashOf, runIdempotentCommand } from './idempotency.ts'
import { loadNodeRun, releaseLease, type NodeRunRow } from './lease.ts'
import type { InspectMemoryWrite, MemoryWriteInspection } from './memory-ports.ts'
import { applyTransition, createNodeRun } from './nodes.ts'
import { closeRun } from './run-close.ts'

const INSPECTED = 'memory.apply.inspected'
const RECOVERED = 'memory.apply.recovered'

type Batch = { batch_id: string; memory_run_id: string; apply_node_run_id: string | null; status: string; updated_at: string }
type Recovery = {
  node_run_id: string; batch_id: string; evidence_id: string; stopped_at: string
  decision_id: string; abandon_ack_id: string | null; status: string
}
type Item = { client_key: string; approved_content_hash: string | null; content_hash: string; status: string }
type InspectedItem = {
  client_key: string
  content_hash: string
  status: 'applied' | 'missing' | 'skipped'
  applied_item_id: string | null
}
export type MemoryWriteEvidence = {
  batch_id: string
  node_run_id: string
  attempt: number
  stopped_at: string
  evidence_id: string
  written_count: number
  missing_count: number
  partial: boolean
  items: InspectedItem[]
}
type Resolution = 'confirm_applied' | 'confirm_not_applied' | 'abandon' | 'acknowledge_abandon'
export type MemoryRecoveryRequest = {
  batch_id: string
  decision_id: string
  revision: number
  resolution: Resolution
  stopped_at: string
  evidence_id: string
  operation_id: string
}
type Deps = { db: Db; secret: string; inspectWrite: InspectMemoryWrite; now?: () => string }

function batchOf(tx: Tx, id: string): Batch {
  const batch = tx.get<Batch>(
    'SELECT batch_id, memory_run_id, apply_node_run_id, status, updated_at FROM memory_batches WHERE batch_id = ?', [id],
  )
  if (!batch) throw new OrchError('MEMORY_BATCH_NOT_FOUND', '记忆批次不存在')
  return batch
}

function recoveryOf(tx: Tx, node: string): Recovery | undefined {
  return tx.get<Recovery>('SELECT * FROM memory_write_recoveries WHERE node_run_id = ?', [node])
}

function currentApply(tx: Tx, batch: Batch): NodeRunRow {
  if (!batch.apply_node_run_id) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '批次没有待对账的写入')
  const node = loadNodeRun(tx, batch.apply_node_run_id)
  if (node.run_id !== batch.memory_run_id || node.node_id !== 'mem_apply') {
    throw new OrchError('MEMORY_APPLY_BINDING_INVALID', '对账节点与批次不匹配')
  }
  return node
}

function proofOf(tx: Tx, secret: string, recovery: Recovery): MemoryWriteEvidence {
  assertChainIntact(tx, secret, recovery.node_run_id)
  const event = readChain(tx, recovery.node_run_id).find((entry) => entry.type === INSPECTED)
  const proof = event ? JSON.parse(event.payload) as MemoryWriteEvidence : null
  if (!proof || proof.evidence_id !== recovery.evidence_id || proof.stopped_at !== recovery.stopped_at
    || proof.batch_id !== recovery.batch_id || proof.node_run_id !== recovery.node_run_id) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '对账证据与账本不符')
  }
  return proof
}

function classify(tx: Tx, batch: Batch, node: NodeRunRow, observed: MemoryWriteInspection, now: string): MemoryWriteEvidence {
  if (observed?.batch_id !== batch.batch_id || observed.node_run_id !== node.node_run_id
    || !Number.isFinite(Date.parse(observed.stopped_at)) || Date.parse(observed.stopped_at) > Date.parse(now)
    || Date.parse(observed.stopped_at) < Date.parse(batch.updated_at)
    || !Array.isArray(observed.entries)) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '写入端没有确认此 attempt 已停止')
  }
  const rows = tx.all<Item>(
    'SELECT client_key, approved_content_hash, content_hash, status FROM memory_items WHERE batch_id = ? ORDER BY client_key',
    [batch.batch_id],
  )
  const entries = new Map(observed.entries.map((row) => [row.client_key, row] as const))
  if (entries.size !== observed.entries.length || rows.every((row) => row.status !== 'approved')) {
    throw new OrchError('VERIFICATION_TOO_WEAK', '写入端返回重复条目或批次没有获批条目')
  }
  const ids = new Set<string>()
  const items: InspectedItem[] = rows.map((row) => {
    const written = entries.get(row.client_key)
    entries.delete(row.client_key)
    if (row.approved_content_hash !== row.content_hash || !['approved', 'skipped'].includes(row.status)
      || (written && (row.status !== 'approved' || written.content_hash !== row.approved_content_hash
        || typeof written.applied_item_id !== 'string' || !written.applied_item_id || ids.has(written.applied_item_id)))) {
      throw new OrchError('MEMORY_APPLY_CONFLICT', '写入端记录与批准条目不符', { client_key: row.client_key })
    }
    if (written) ids.add(written.applied_item_id)
    return {
      client_key: row.client_key, content_hash: row.content_hash,
      status: written ? 'applied' : row.status === 'skipped' ? 'skipped' : 'missing',
      applied_item_id: written?.applied_item_id ?? null,
    }
  })
  if (entries.size) throw new OrchError('MEMORY_APPLY_CONFLICT', '写入端返回了批次之外的条目')
  const written_count = ids.size
  const missing_count = items.filter((row) => row.status === 'missing').length
  const facts = {
    batch_id: batch.batch_id, node_run_id: node.node_run_id, attempt: node.attempt,
    stopped_at: observed.stopped_at, written_count, missing_count, partial: written_count > 0 && missing_count > 0, items,
  }
  return { ...facts, evidence_id: 'mev_' + sha256Hex(canonicalJson(facts)) }
}

function landWritten(tx: Tx, proof: MemoryWriteEvidence): void {
  for (const item of proof.items) {
    if (item.status !== 'applied') continue
    runCas(tx, "UPDATE memory_items SET status = 'applied', applied_item_id = ? WHERE batch_id = ? AND client_key = ? AND status = 'approved' AND approved_content_hash = ?",
      [item.applied_item_id, proof.batch_id, item.client_key, item.content_hash], { rows: 1, what: 'memory recovery item' })
  }
}

function choice(proof: MemoryWriteEvidence): Resolution {
  return proof.partial ? 'abandon' : proof.written_count ? 'confirm_applied' : 'confirm_not_applied'
}

function event(tx: Tx, secret: string, batch: Batch, node: NodeRunRow, type: string, payload: unknown): void {
  appendNodeRunEvent(tx, secret, node.node_run_id, type, payload)
  appendEvent(tx, { runId: batch.memory_run_id, nodeRunId: node.node_run_id, type, payload })
}

export function pauseMemoryWrite(tx: Tx, secret: string, node: NodeRunRow, batchId: string, now: string): void {
  applyTransition(tx, secret, {
    nodeRunId: node.node_run_id, attempt: node.attempt, from: ['started'], to: 'indeterminate_side_effect',
    ruleId: 'M-50', expectedRevision: node.revision, actionGeneration: node.action_generation, now,
  })
  releaseLease(tx, { nodeRunId: node.node_run_id, now })
  runCas(tx, "UPDATE runs SET status = 'paused', revision = revision + 1, updated_at = ? WHERE run_id = ? AND status IN ('running','settling','paused')",
    [now, node.run_id], { rows: 1, what: 'pause memory recovery' })
  appendEvent(tx, { type: 'memory.apply.outcome_unknown', runId: node.run_id, nodeRunId: node.node_run_id, payload: { batch_id: batchId } })
}

function inspectionView(tx: Tx, secret: string, record: Recovery) {
  const decision = record.abandon_ack_id ?? record.decision_id
  const row = tx.get<{ revision: number; status: string }>('SELECT revision, status FROM decisions WHERE decision_id = ?', [decision])!
  const proof = proofOf(tx, secret, record)
  return {
    ...proof, decision_id: decision, revision: row.revision,
    allowed_resolutions: row.status === 'resolved' ? [] : [record.abandon_ack_id ? 'acknowledge_abandon' : choice(proof)] as Resolution[],
  }
}

/** Bind authoritative writer facts to a decision. Partial writes are projected immediately. */
export async function inspectMemoryRecovery(deps: Deps, batchId: string) {
  const initial = inTx(deps.db, (tx) => {
    const batch = batchOf(tx, batchId)
    const node = currentApply(tx, batch)
    const record = recoveryOf(tx, node.node_run_id)
    if (record) return { existing: inspectionView(tx, deps.secret, record) }
    assertChainIntact(tx, deps.secret, node.node_run_id)
    if (batch.status !== 'applying' || !['started', 'indeterminate_side_effect'].includes(node.status)) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '写入状态已变，不能对账')
    }
    return { batch, node }
  })
  if (initial.existing) return initial.existing
  const observed = await deps.inspectWrite({
    batch_id: batchId, run_id: initial.batch.memory_run_id, node_run_id: initial.node.node_run_id,
  })
  const now = deps.now?.() ?? new Date().toISOString()
  return inTx(deps.db, (tx) => {
    const batch = batchOf(tx, batchId)
    const node = currentApply(tx, batch)
    if (node.node_run_id !== initial.node.node_run_id) throw new OrchError('STALE_GENERATION', '写入 attempt 已更换')
    const record = recoveryOf(tx, node.node_run_id)
    if (record) return inspectionView(tx, deps.secret, record)
    if (batch.status !== 'applying' || !['started', 'indeterminate_side_effect'].includes(node.status)) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '写入状态已变，不能对账')
    }
    const proof = classify(tx, batch, node, observed, now)
    if (node.status === 'started') {
      pauseMemoryWrite(tx, deps.secret, node, batchId, now)
    }
    if (!tx.get("SELECT 1 FROM runs WHERE run_id = ? AND status = 'paused'", [batch.memory_run_id])) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆运行未处于待恢复状态')
    }
    event(tx, deps.secret, batch, node, INSPECTED, proof)
    if (proof.partial) {
      landWritten(tx, proof)
      runCas(tx, "UPDATE memory_batches SET status = 'indeterminate', outcome = 'indeterminate', applied_count = ?, updated_at = ? WHERE batch_id = ? AND status = 'applying'",
        [proof.written_count, now, batchId], { rows: 1, what: 'partial memory write' })
    }
    const id = decisionId()
    openDecision(tx, {
      decisionId: id, nodeRunId: node.node_run_id, runId: batch.memory_run_id, kind: 'verify_human',
      approver: 'human', confirmRequired: false, createdAt: now,
      payload: { batch_id: batchId, evidence_id: proof.evidence_id, stopped_at: proof.stopped_at, allowed_resolutions: [choice(proof)] },
    })
    tx.run("INSERT INTO memory_write_recoveries (node_run_id, batch_id, evidence_id, stopped_at, decision_id, status) VALUES (?, ?, ?, ?, ?, 'inspected')",
      [node.node_run_id, batchId, proof.evidence_id, proof.stopped_at, id])
    return inspectionView(tx, deps.secret, recoveryOf(tx, node.node_run_id)!)
  })
}

function resume(tx: Tx, batch: Batch, now: string): void {
  runCas(tx, "UPDATE runs SET status = 'running', revision = revision + 1, updated_at = ? WHERE run_id = ? AND status = 'paused'",
    [now, batch.memory_run_id], { rows: 1, what: 'resume memory recovery' })
}

/** Complete one human recovery decision and its state transitions in the same transaction. */
export function resolveMemoryRecovery(deps: Pick<Deps, 'db' | 'secret' | 'now'>, actor: Actor, req: MemoryRecoveryRequest) {
  if (actor.kind !== 'human') throw new OrchError('FORBIDDEN', '记忆写入恢复必须由人确认')
  if (!req.evidence_id || !req.stopped_at) throw new OrchError('VERIFICATION_TOO_WEAK', '缺少写入停止时刻或对账证据')
  const kind = 'memory.recovery.resolve'
  const now = deps.now?.() ?? new Date().toISOString()
  return inTx(deps.db, (tx) => runIdempotentCommand(tx, {
    kind, operationId: assertOperationId(req.operation_id), now, requestHash: requestHashOf(kind, { ...req, actor: actor.id }),
  }, () => {
    const batch = batchOf(tx, req.batch_id)
    const node = currentApply(tx, batch)
    const record = recoveryOf(tx, node.node_run_id)
    if (!record || req.evidence_id !== record.evidence_id || req.stopped_at !== record.stopped_at) {
      throw new OrchError('VERIFICATION_TOO_WEAK', '停止时刻或对账证据不属于当前 attempt')
    }
    const proof = proofOf(tx, deps.secret, record)
    const ack = req.resolution === 'acknowledge_abandon'
    if (ack ? record.status !== 'abandoned' || node.status !== 'abandoned_unverified' || req.decision_id !== record.abandon_ack_id
      : record.status !== 'inspected' || node.status !== 'indeterminate_side_effect' || req.decision_id !== record.decision_id || req.resolution !== choice(proof)) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '此对账结果不允许该恢复动作')
    }
    resolveMemoryRecoveryDecision(tx, deps.secret, {
      decisionId: req.decision_id, revision: req.revision, resolution: 'approved', now, actor,
      payload: { resolution: req.resolution, evidence_id: proof.evidence_id, stopped_at: proof.stopped_at },
    })
    const transition = {
      nodeRunId: node.node_run_id, attempt: node.attempt, from: ['indeterminate_side_effect'] as const,
      expectedRevision: node.revision, rearmGeneration: node.rearm_generation, now,
    }
    let status: string
    let newNode: string | null = null
    let ackId: string | null = null
    if (req.resolution === 'confirm_applied') {
      landWritten(tx, proof)
      runCas(tx, "UPDATE memory_batches SET status = 'applied', outcome = 'written', applied_count = ?, skipped_count = ?, applied_at = ?, updated_at = ? WHERE batch_id = ? AND status = 'applying'",
        [proof.written_count, proof.items.length - proof.written_count, proof.stopped_at, now, batch.batch_id], { rows: 1, what: 'confirm memory written' })
      applyTransition(tx, deps.secret, { ...transition, from: [...transition.from], to: 'done', ruleId: 'M-51' })
      status = 'confirmed_applied'
      resume(tx, batch, now)
    } else if (req.resolution === 'confirm_not_applied') {
      if (!tx.get("SELECT 1 FROM runs WHERE run_id = ? AND status = 'paused' AND cancel_requested_at IS NULL", [node.run_id])) {
        throw new OrchError('RESOLUTION_NOT_AVAILABLE', '运行已请求取消，不能重新写入')
      }
      applyTransition(tx, deps.secret, { ...transition, from: [...transition.from], to: 'superseded', ruleId: 'M-52' })
      newNode = nodeRunId()
      createNodeRun(tx, { newNodeRunId: newNode, runId: node.run_id, nodeId: node.node_id, seq: node.seq,
        nodeType: node.node_type, attempt: node.attempt + 1, originNodeRunId: node.node_run_id,
        previousActionGeneration: node.action_generation, now })
      runCas(tx, "UPDATE memory_batches SET apply_node_run_id = NULL, updated_at = ? WHERE batch_id = ? AND status = 'applying' AND apply_node_run_id = ?",
        [now, batch.batch_id, node.node_run_id], { rows: 1, what: 'rearm memory write' })
      status = 'confirmed_not_applied'
      resume(tx, batch, now)
    } else if (req.resolution === 'abandon') {
      applyTransition(tx, deps.secret, { ...transition, from: [...transition.from], to: 'abandoned_unverified', ruleId: 'M-53' })
      ackId = decisionId()
      openDecision(tx, { decisionId: ackId, runId: node.run_id, nodeRunId: null, kind: 'abandon_ack', approver: 'human',
        confirmRequired: false, createdAt: now, payload: { batch_id: batch.batch_id, node_run_id: node.node_run_id,
          evidence_id: proof.evidence_id, stopped_at: proof.stopped_at, allowed_resolutions: ['acknowledge_abandon'] } })
      status = 'abandoned'
    } else {
      const nodes = tx.all<NodeRunRow>('SELECT * FROM node_runs WHERE run_id = ?', [node.run_id])
      for (const rest of nodes) {
        if (isTerminal(rest.status)) continue
        applyTransition(tx, deps.secret, { nodeRunId: rest.node_run_id, attempt: rest.attempt,
          from: ['queued'], to: 'superseded', ruleId: 'M-62', expectedRevision: rest.revision, now })
      }
      status = 'acknowledged'
      resume(tx, batch, now)
    }
    runCas(tx, 'UPDATE memory_write_recoveries SET status = ?, abandon_ack_id = COALESCE(?, abandon_ack_id) WHERE node_run_id = ? AND status = ?',
      [status, ackId, node.node_run_id, record.status], { rows: 1, what: 'memory recovery resolution' })
    event(tx, deps.secret, batch, node, RECOVERED, { resolution: req.resolution, evidence_id: proof.evidence_id,
      decision_id: req.decision_id, replacement_node_run_id: newNode, abandon_ack_id: ackId })
    const terminal = ack ? closeRun(tx, deps.secret, node.run_id, now) : null
    if (ack && !terminal) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆运行还有未收口事项')
    return { batch_id: batch.batch_id, status, replacement_node_run_id: newNode, abandon_ack_id: ackId, terminal }
  }).result)
}
