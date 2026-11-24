import { assertExtraStepExecutable } from './rework-extra-steps.ts'
import { runtimeEdges } from './rework-edges.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { TERMINAL_STATUSES, type NodeStatus } from '../core/state-machine.ts'
import type { ReadTx } from './queries/read-tx.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import { appendNodeRunEvent, assertChainIntact } from '../infra/db/ledger.ts'
import { applyTransition, createNodeRun } from './commands/nodes.ts'
import { pinnedTopologyForRun } from './run-readiness.ts'
import { readReworkFiles } from './rework-manifest.ts'

export type RuntimeReworkRequest = {
  request_id: string; run_id: string; target_node_run_id: string
  approved_scope?: string | null; suggested_scope?: string; status?: string; new_node_run_id?: string | null; requester_node_run_id?: string | null; affected_node_ids?: string[]
}
type Node = { node_run_id: string; run_id: string; node_id: string; node_type: string; seq: number; attempt: number; status: string; revision: number; side_effect_policy: string; hang_reason: string | null; replacement_node_run_id: string | null; action_generation: number; parent_node_run_id: string | null }
const resolved = "('declined','closed','accepted','cancelled')"
const terminal = new Set<string>(TERMINAL_STATUSES)
function nodeOf(tx: ReadTx, id: string): Node {
  const n = tx.get<Node>('SELECT * FROM node_runs WHERE node_run_id = ?', [id])
  if (!n) throw new OrchError('NOT_FOUND', 'node run does not exist')
  return n
}
export function assertReworkRunActive(tx: Tx, runId: string): void {
  const r = tx.get<{ status: string; cancel_requested_at: string | null }>('SELECT status,cancel_requested_at FROM runs WHERE run_id = ?', [runId])
  if (!r || r.status !== 'running' || r.cancel_requested_at) throw new OrchError('STALE_GENERATION', 'run is not active')
}
export function hasUnresolvedRework(tx: Tx, runId: string): boolean {
  return !!tx.get(`SELECT 1 FROM rework_requests WHERE run_id = ? AND status NOT IN ${resolved} LIMIT 1`, [runId])
}
/** Direct holds are sufficient for a queued run without an active rework traversal. */
export function queuedReworkHolds(tx: ReadTx, runId: string): ReadonlySet<string> {
  const rows = tx.all<{ node_run_id: string }>(`SELECT n.node_run_id FROM node_runs n
    WHERE n.run_id=? AND n.status='queued' AND (
      n.replacement_node_run_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM rework_impacts i WHERE i.node_run_id=n.node_run_id AND i.released_at IS NULL)
      OR EXISTS (SELECT 1 FROM rework_requests q WHERE q.target_node_run_id=n.node_run_id AND q.status NOT IN ${resolved})
    )`, [runId])
  return new Set(rows.map(row => row.node_run_id))
}

export function reworkBlocksNode(tx: ReadTx, nodeRunId: string): boolean {
  const n = nodeOf(tx, nodeRunId)
  if (n.replacement_node_run_id) return true
  if (n.status === 'done' && tx.get(`SELECT 1 FROM rework_requests WHERE new_node_run_id=? AND status NOT IN ${resolved}`, [nodeRunId])) return true
  if (tx.get('SELECT 1 FROM rework_impacts WHERE node_run_id = ? AND released_at IS NULL', [nodeRunId])) return true
  // A revision is executable, but its output cannot release consumers until acceptance.
  if (tx.get(`SELECT 1 FROM rework_requests WHERE target_node_run_id = ? AND status NOT IN ${resolved}`, [nodeRunId])) return true
  for (const request of tx.all<RuntimeReworkRequest>(`SELECT * FROM rework_requests WHERE run_id=? AND status NOT IN ${resolved}`, [n.run_id])) {
    if (request.new_node_run_id && isCandidateReviewer(tx, nodeRunId, request.new_node_run_id)) continue
    if (descendants(tx, request, nodeOf(tx, request.target_node_run_id)).some(affected => affected.node_run_id === nodeRunId)) return true
  }
  return false
}
export function assertReworkExecutionAllowed(tx: Tx, nodeRunId: string, completing = false): void {
  const n = nodeOf(tx, nodeRunId)
  assertExtraStepExecutable(tx,nodeRunId)
  // Legacy recovery can settle a paused run; only rework execution requires an active run.
  if (tx.get('SELECT 1 FROM rework_requests WHERE run_id=? LIMIT 1', [n.run_id])) assertReworkRunActive(tx, n.run_id)
  if (completing && tx.get(`SELECT 1 FROM rework_requests r JOIN node_runs original ON original.node_run_id=r.requester_node_run_id JOIN node_runs n ON n.run_id=original.run_id AND n.node_id=original.node_id JOIN rework_impacts i ON i.request_id=r.request_id AND i.replacement_node_run_id=n.node_run_id WHERE n.node_run_id=? AND r.status NOT IN ${resolved}`, [nodeRunId])) throw new OrchError('STALE_GENERATION', 'reviewer must accept revision before completing')
  if (reworkBlocksNode(tx, nodeRunId)) throw new OrchError('STALE_GENERATION', 'node input or result is held by rework')
  for (const edge of runtimeEdges(tx, n.run_id, []).filter(edge => edge.to === n.node_id)) {
    const upstream = latestLogicalNode(tx, n.run_id, edge.from)
    if (upstream.status !== 'done' || reworkBlocksNode(tx, upstream.node_run_id)) throw new OrchError('STALE_GENERATION', 'approved local dependency is not ready')
    if (tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [nodeRunId]) && tx.get(
      'SELECT 1 FROM artifacts a JOIN artifact_contents c USING(artifact_id) WHERE c.node_run_id=? AND NOT EXISTS (SELECT 1 FROM artifact_consumptions i WHERE i.consumer_node_run_id=? AND i.upstream_node_run_id=? AND i.artifact_id=a.artifact_id AND i.artifact_hash=a.sha256) LIMIT 1',
      [upstream.node_run_id, nodeRunId, upstream.node_run_id],
    )) throw new OrchError('STALE_GENERATION', 'immutable inputs predate the approved local dependency; a fresh attempt is required')
  }
  // Also protect direct callers that bypass Dispatcher dependency checks.
  for (const c of tx.all<{ upstream_node_run_id: string }>('SELECT DISTINCT upstream_node_run_id FROM artifact_consumptions WHERE consumer_node_run_id = ?', [nodeRunId])) {
    if (reworkBlocksNode(tx, c.upstream_node_run_id) && !isCandidateReviewer(tx, nodeRunId, c.upstream_node_run_id)) throw new OrchError('STALE_GENERATION', 'consumed input is obsolete')
  }
}
export type ArtifactInput = { upstream_node_run_id: string; artifact_id: string; artifact_hash: string; file_name: string }
/** Capture exactly the immutable references injected into the executor input, once per attempt. */
export function snapshotArtifactInputs(tx: Tx, consumerNodeRunId: string, upstreamNodeRunIds: readonly string[], now: string): ArtifactInput[] {
  const consumer = nodeOf(tx, consumerNodeRunId)
  assertReworkExecutionAllowed(tx, consumerNodeRunId)
  if (tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id = ?', [consumerNodeRunId])) {
    return tx.all<ArtifactInput>('SELECT c.upstream_node_run_id,c.artifact_id,c.artifact_hash,a.file_name FROM artifact_consumptions c JOIN artifact_contents a USING(artifact_id) WHERE c.consumer_node_run_id = ? ORDER BY c.artifact_id', [consumerNodeRunId])
  }
  const inputs: ArtifactInput[] = []
  const ids = new Set(upstreamNodeRunIds)
  for (const edge of runtimeEdges(tx, consumer.run_id, []).filter(edge => edge.to === consumer.node_id)) ids.add(latestLogicalNode(tx, consumer.run_id, edge.from).node_run_id)
  for (const id of ids) {
    const up = nodeOf(tx, id)
    if (up.run_id !== consumer.run_id || up.status !== 'done' || (reworkBlocksNode(tx, id) && !isCandidateReviewer(tx, consumerNodeRunId, id))) throw new OrchError('STALE_GENERATION', 'upstream result is not accepted and current')
    const available=tx.all<ArtifactInput>('SELECT c.node_run_id AS upstream_node_run_id,a.artifact_id,a.sha256 AS artifact_hash,c.file_name FROM artifacts a JOIN artifact_contents c USING(artifact_id) WHERE c.node_run_id = ? ORDER BY a.artifact_id', [id])
    const sealed=tx.get<{result_manifest_json:string|null}>('SELECT result_manifest_json FROM rework_attempts WHERE new_node_run_id=?',[id])
    if (sealed?.result_manifest_json != null) {
      const files=readReworkFiles(sealed.result_manifest_json)
      const exact=available.filter(file=>files.some(ref=>ref.artifact_id===file.artifact_id && ref.sha256===file.artifact_hash && ref.file_name===file.file_name))
      if (exact.length!==files.length || files.length===0) throw new OrchError('CONFIRMATION_MISMATCH','已封存的返工成果未能完整绑定给下游')
      inputs.push(...exact)
    } else inputs.push(...available)
  }
  if (new Set(inputs.map(i => i.upstream_node_run_id + ':' + i.file_name)).size !== inputs.length) throw new OrchError('STALE_GENERATION', 'ambiguous upstream artifact versions')
  tx.run('INSERT INTO input_snapshots VALUES (?,?,?)', [consumerNodeRunId, consumer.attempt, now])
  for (const i of inputs) tx.run('INSERT INTO artifact_consumptions VALUES (?,?,?,?,?,?)', [consumerNodeRunId, i.upstream_node_run_id, i.artifact_id, i.artifact_hash, consumer.attempt, now])
  return inputs
}
function descendants(tx: ReadTx, req: RuntimeReworkRequest, target: Node): Node[] {
  const all = tx.all<Node>('SELECT * FROM node_runs WHERE run_id = ? AND replacement_node_run_id IS NULL ORDER BY seq,attempt', [req.run_id])
  const binding = tx.get<{ definition_json: string }>('SELECT w.definition_json FROM runs r JOIN workflow_versions w ON w.workflow_id=r.workflow_id AND w.version=r.workflow_version WHERE r.run_id=?', [req.run_id])
  if (!binding && all.some(n => n.node_run_id !== target.node_run_id && !tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [n.node_run_id]))) throw new OrchError('FORBIDDEN', 'legacy consumers require a persisted topology before rework')
  const edges = runtimeEdges(tx, req.run_id, binding ? JSON.parse(binding.definition_json).edges ?? [] : [])
  const selected = new Set([target.node_run_id]); const logical = new Set([target.node_id]); const out: Node[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const n of all) {
      if (selected.has(n.node_run_id)) continue
      const consumed = tx.all<{ upstream_node_run_id: string }>('SELECT DISTINCT upstream_node_run_id FROM artifact_consumptions WHERE consumer_node_run_id=?', [n.node_run_id])
      const known = !!tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [n.node_run_id])
      const actual = consumed.some(c => selected.has(c.upstream_node_run_id))
      const possible = edges.some(e => e.to === n.node_id && logical.has(e.from)) || req.affected_node_ids?.includes(n.node_id)
      if (actual || (!known && possible)) { selected.add(n.node_run_id); logical.add(n.node_id); out.push(n); changed = true }
    }
  }
  return out
}
function assertSafe(tx: Tx, n: Node): void {
  if (!['done', 'queued', 'leased', 'dispatched', 'started', 'verifying', 'superseded'].includes(n.status)) throw new OrchError('FORBIDDEN', 'uncertain execution must be resolved before rework')
  if (n.node_type !== 'agent' || n.side_effect_policy !== 'pure' || n.hang_reason) throw new OrchError('FORBIDDEN', 'rework requires a pure agent without unresolved side effects')
  if (tx.get("SELECT 1 FROM bridge_tool_outbox WHERE node_run_id=? AND status='pending' LIMIT 1", [n.node_run_id])) throw new OrchError('FORBIDDEN', 'rework cannot repeat external effects')
}

export function assertReworkReplacementAllowed(tx: ReadTx, node: Pick<Node, 'run_id' | 'node_id' | 'parent_node_run_id'>): void {
  if (node.parent_node_run_id !== null || pinnedTopologyForRun(tx, node.run_id)?.parallelOwner(node.node_id) !== undefined) {
    throw new OrchError('FORBIDDEN', '并行组成员的执行授权固定到编组开启时的尝试，当前返工不能替换该成员', { nodeId: node.node_id })
  }
}

function successor(tx: Tx, secret: string, n: Node, now: string, requestId: string): string {
  assertReworkReplacementAllowed(tx, n)
  assertChainIntact(tx, secret, n.node_run_id)
  const id = 'nrun_' + uuidv7()
  createNodeRun(tx, { newNodeRunId: id, runId: n.run_id, nodeId: n.node_id, seq: n.seq, nodeType: n.node_type, attempt: n.attempt + 1, originNodeRunId: n.node_run_id, previousActionGeneration: n.action_generation, reworkRequestId: requestId, now })
  tx.run("UPDATE node_runs SET side_effect_policy='pure' WHERE node_run_id=?", [id])
  appendNodeRunEvent(tx, secret, n.node_run_id, 'rework.replaced', { request_id: requestId, new_node_run_id: id })
  appendNodeRunEvent(tx, secret, id, 'rework.created', { request_id: requestId, origin_node_run_id: n.node_run_id })
  return id
}
export function authorizeReworkRuntime(tx: Tx, secret: string, req: RuntimeReworkRequest, now: string): string {
  assertReworkRunActive(tx, req.run_id)
  const n = nodeOf(tx, req.target_node_run_id)
  if (n.run_id !== req.run_id || n.status !== 'done' || n.replacement_node_run_id) throw new OrchError('STALE_GENERATION', 'rework source must be the current completed attempt')
  assertSafe(tx, n)
  assertReworkReplacementAllowed(tx, n)
  if (!tx.get('SELECT 1 FROM rework_requests WHERE request_id=? AND file_manifest_json IS NOT NULL',[req.request_id]) && (tx.get<{n:number}>('SELECT COUNT(DISTINCT file_name) AS n FROM artifact_contents WHERE node_run_id=?',[n.node_run_id])?.n ?? 0)>1) throw new OrchError('FORBIDDEN','多份原件需要逐份批准处理方式')
  const affected = descendants(tx, req, n)
  const proposedIds = new Set([n.node_run_id, ...affected.map(node => node.node_run_id)])
  for (const other of tx.all<RuntimeReworkRequest>(`SELECT * FROM rework_requests WHERE run_id=? AND request_id<>? AND status NOT IN ${resolved}`, [req.run_id, req.request_id])) {
    const reserved = [other.target_node_run_id, other.new_node_run_id, ...descendants(tx, other, nodeOf(tx, other.target_node_run_id)).map(node => node.node_run_id)]
    if (reserved.some(id => id && proposedIds.has(id))) throw new OrchError('STALE_GENERATION', 'overlapping rework scopes require explicit resolution')
  }
  for (const d of affected) {
    assertSafe(tx, d)
    if (d.status !== 'queued' || d.node_run_id === req.requester_node_run_id
        || tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [d.node_run_id])) assertReworkReplacementAllowed(tx, d)
  }
  for (const d of affected) {
    tx.run('INSERT OR IGNORE INTO rework_impacts(request_id,node_run_id,reason,created_at) VALUES(?,?,?,?)', [req.request_id, d.node_run_id, 'consumed or potentially consumed obsolete input', now])
    const boundQueued = d.status === 'queued' && !!tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [d.node_run_id])
    if (!terminal.has(d.status) && (d.status !== 'queued' || boundQueued)) {
      applyTransition(tx, secret, { nodeRunId: d.node_run_id, from: [d.status as NodeStatus], to: 'superseded', ruleId: 'M-66', attempt: d.attempt, expectedRevision: d.revision, now, context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, reworkAuthorized: true }, patch: { lease_id: null, lease_expires_at: null, executor_session_id: null, executor_agent_id: null } })
      tx.run('UPDATE leases SET expires_at=? WHERE node_run_id=?', [now, d.node_run_id])
      appendNodeRunEvent(tx, secret, d.node_run_id, 'rework.input_invalidated', { request_id: req.request_id })
    }
  }
  return successor(tx, secret, n, now, req.request_id)
}
export function acceptReworkRuntime(tx: Tx, secret: string, req: RuntimeReworkRequest, now: string): void {
  assertReworkRunActive(tx, req.run_id)
  if (!req.new_node_run_id || nodeOf(tx, req.new_node_run_id).status !== 'done') throw new OrchError('STALE_GENERATION', 'revision has not completed')
  const impacts = tx.all<{ node_run_id: string }>('SELECT node_run_id FROM rework_impacts WHERE request_id=? AND released_at IS NULL', [req.request_id])
  for (const i of impacts) {
    const n = nodeOf(tx, i.node_run_id)
    assertSafe(tx, n)
    // Queued attempts have consumed no inputs and can be released as-is.
    const existing = n.replacement_node_run_id
    const next = existing ?? (n.status === 'queued' && !tx.get('SELECT 1 FROM input_snapshots WHERE consumer_node_run_id=?', [n.node_run_id]) ? null : successor(tx, secret, n, now, req.request_id))
    tx.run('UPDATE rework_impacts SET replacement_node_run_id=?,released_at=? WHERE request_id=? AND node_run_id=? AND released_at IS NULL', [next, now, req.request_id, n.node_run_id])
  }
}

export function previewReworkImpact(tx: ReadTx, req: RuntimeReworkRequest): Array<{ node_id: string; node_run_id: string; status: string }> {
  return descendants(tx, req, nodeOf(tx, req.target_node_run_id)).map(n => ({ node_id: n.node_id, node_run_id: n.node_run_id, status: n.status }))
}

export function isCandidateReviewer(tx: ReadTx, consumerId: string, candidateId: string): boolean {
  return !!tx.get("SELECT 1 FROM rework_requests r JOIN node_runs original ON original.node_run_id=r.requester_node_run_id JOIN node_runs n ON n.run_id=original.run_id AND n.node_id=original.node_id JOIN rework_impacts i ON i.request_id=r.request_id AND i.replacement_node_run_id=n.node_run_id WHERE n.node_run_id=? AND n.replacement_node_run_id IS NULL AND r.new_node_run_id=? AND r.status='awaiting_review'", [consumerId, candidateId])
}
/** Start only the original consumer's fresh review context; all other consumers stay held. */
export function prepareReworkReviewer(tx: Tx, secret: string, req: RuntimeReworkRequest, now: string): string | null {
  assertReworkRunActive(tx, req.run_id)
  if (!req.requester_node_run_id || !req.new_node_run_id) return null
  if (nodeOf(tx, req.new_node_run_id).status !== 'done') return null
  const original = nodeOf(tx, req.requester_node_run_id)
  const n = tx.get<Node>(
    'SELECT n.* FROM rework_impacts i JOIN node_runs n ON n.node_run_id=i.node_run_id WHERE i.request_id=? AND n.run_id=? AND n.node_id=? AND n.replacement_node_run_id IS NULL AND i.released_at IS NULL ORDER BY n.attempt DESC LIMIT 1',
    [req.request_id, req.run_id, original.node_id],
  )
  if (!n) {
    const existing = tx.get<{ node_run_id: string }>(
      'SELECT n.node_run_id FROM rework_impacts i JOIN node_runs n ON n.node_run_id=i.replacement_node_run_id WHERE i.request_id=? AND n.run_id=? AND n.node_id=? AND n.replacement_node_run_id IS NULL AND i.released_at IS NULL ORDER BY n.attempt DESC LIMIT 1',
      [req.request_id, req.run_id, original.node_id],
    )
    return existing?.node_run_id ?? null
  }
  assertSafe(tx, n)
  const id = successor(tx, secret, n, now, req.request_id)
  tx.run('UPDATE rework_impacts SET replacement_node_run_id=? WHERE request_id=? AND node_run_id=?', [id, req.request_id, n.node_run_id])
  return id
}

function latestLogicalNode(tx: ReadTx, runId: string, nodeId: string): Node {
  const node = tx.get<Node>('SELECT * FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [runId, nodeId])
  if (!node) throw new OrchError('STALE_GENERATION', 'approved local dependency is missing from the run')
  return node
}
