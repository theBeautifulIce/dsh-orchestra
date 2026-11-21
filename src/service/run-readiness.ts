import { isTerminal, TERMINAL_STATUSES } from '../core/state-machine.ts'
import { appendNodeRunEvent, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { approvedRuntimeEdges, runtimeEdges, type RuntimeEdge } from './rework-edges.ts'
import { isCandidateReviewer, reworkBlocksNode } from './rework-runtime.ts'
import { indexTopology, verifiedTopology, type PinnedTopology } from './pinned-topology.ts'
import { branchSkipped, intactBranchChain, selectedBranchTarget, verifiedBranchSkipSource } from './branch-routing.ts'
import { applyTransition } from './commands/nodes.ts'
import { parallelMemberMayStart, parallelMemberPath, parallelMembershipIsConsistent, unopenedParallelMember, type ParallelPathNode } from './workflow-parallel.ts'

const SUCCESS_STATUS: ReadonlySet<string> = new Set(['done', 'succeeded', 'succeeded_with_unverified'])
const FAILED_STATUS: ReadonlySet<string> = new Set(TERMINAL_STATUSES.filter((status) => !SUCCESS_STATUS.has(status)))
type PathLookup = (nodeId: string) => readonly string[]

function runPathNode(tx: ReadTx, runId: string, nodeId: string): ParallelPathNode | undefined {
  return tx.get('SELECT node_run_id,node_id,attempt,status,node_type,parent_node_run_id FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1',
    [runId,nodeId])
}

function branchSkipPath(tx: ReadTx, secret: string, runId: string, nodeRunId: string, topology: PinnedTopology | null): ReturnType<typeof parallelMemberPath> {
  const source = verifiedBranchSkipSource(tx, secret, runId, nodeRunId)
  return source ? parallelMemberPath(tx, secret, runId, source, topology) : 'waiting'
}

export type DependencyReadiness =
  | { ready: true }
  | { ready: false; missingPreds: string[]; failedPreds: string[]; waitingPreds: string[] }

export function readRunBinding(tx: ReadTx, runId: string) {
  return tx.get<{
    workflow_id: string; workflow_version: string;
    status: string; cancel_requested_at: string | null; workflow_definition_hash: string | null;
    definition_json: string | null; content_hash: string | null
  }>(`SELECT COALESCE(r.workflow_id,'default') AS workflow_id,r.workflow_version,
    r.status,r.cancel_requested_at,r.workflow_definition_hash,w.definition_json,w.content_hash FROM runs r
    LEFT JOIN workflow_versions w ON w.workflow_id=COALESCE(r.workflow_id,'default') AND w.version=r.workflow_version
    WHERE r.run_id=?`, [runId])
}

const EMPTY_TOPOLOGY = indexTopology([])

/** A null result means the persisted topology could not be verified. */
export function pinnedRunTopology(binding: NonNullable<ReturnType<typeof readRunBinding>>): PinnedTopology | null {
  if (binding.definition_json === null) return binding.workflow_definition_hash ? null : EMPTY_TOPOLOGY
  if (binding.workflow_definition_hash && binding.content_hash !== binding.workflow_definition_hash) return null
  return verifiedTopology(binding.definition_json, binding.workflow_definition_hash)
}

export function pinnedTopologyForRun(tx: ReadTx, runId: string): PinnedTopology | null {
  const binding = readRunBinding(tx, runId)
  return binding ? pinnedRunTopology(binding) : null
}

export function nodePredecessors(tx: ReadTx, runId: string, topology: PinnedTopology, nodeId: string): readonly string[] {
  const base = topology.predecessors(nodeId)
  const additions = approvedRuntimeEdges(tx, runId, nodeId)
  return additions.length ? [...new Set([...base, ...additions.map(edge => edge.from)])] : base
}

export function runPredecessors(tx: ReadTx, runId: string, edges: readonly RuntimeEdge[]): Map<string, string[]> {
  const preds = new Map<string, string[]>()
  for (const edge of runtimeEdges(tx, runId, edges)) {
    const list = preds.get(edge.to) ?? []
    list.push(edge.from)
    preds.set(edge.to, list)
  }
  return preds
}

/** Superseded attempts never release a downstream node. A revision awaiting acceptance only releases its reviewer. */
export function dependencyReadiness(tx: ReadTx, runId: string, consumerId: string, preds: readonly string[], consumerNodeId?: string,
  secret?: string, pinned?: PinnedTopology | null): DependencyReadiness {
  if (!preds.length) return { ready: true }
  const topology = pinned === undefined ? pinnedTopologyForRun(tx, runId) : pinned
  const missing: string[] = []
  const failed: string[] = []
  const waiting: string[] = []
  let inactive = 0
  let parallel = false
  for (const pred of preds) {
    const row = runPathNode(tx, runId, pred)
    if (!row) {
      missing.push(pred)
      continue
    }
    if (consumerNodeId && topology?.parallelOwner(consumerNodeId) === pred) {
      if (row.status === 'waiting' && parallelMemberMayStart(tx, secret, row.node_run_id, consumerId, topology)) continue
      if (row.status === 'done') {
        // A completed owner cannot authorize the lease of an unbound replacement.
        waiting.push(pred)
        continue
      }
    }
    const path = parallelMemberPath(tx, secret, runId, row, topology)
    if (path === 'inactive' && !reworkBlocksNode(tx, row.node_run_id)) {
      inactive++
      parallel = true
      continue
    }
    const mayUseSkip = row.status === 'superseded' && (path === 'active'
      || (path === 'waiting' && !!topology && unopenedParallelMember(tx, secret, runId, topology, row)))
    if (mayUseSkip && parallelSkipReceipt(tx, row.node_run_id)) {
      if (secret && !verifiedParallelSkip(tx, secret, runId, pred, row.node_run_id, topology)) waiting.push(pred)
      else {
        inactive++
        parallel = true
      }
      continue
    }
    if (mayUseSkip && branchSkipped(tx, row.node_run_id)) {
      const branchPath = secret ? branchSkipPath(tx, secret, runId, row.node_run_id, topology) : 'active'
      if (branchPath === 'failed') failed.push(pred)
      else if (branchPath === 'waiting') waiting.push(pred)
      else {
        inactive++
        parallel ||= branchPath === 'inactive'
      }
      continue
    }
    if (path !== 'active') {
      (path === 'failed' ? failed : waiting).push(pred)
      continue
    }
    if (row.status === 'done' && row.node_type === 'branch') {
      const target = selectedBranchTarget(tx, row.node_run_id)
      if (!target || (secret && !intactBranchChain(tx, secret, row.node_run_id))) {
        waiting.push(pred)
        continue
      }
      if (consumerNodeId !== undefined && target !== consumerNodeId) {
        inactive++
        continue
      }
    }
    if (row.status === 'done' && isCandidateReviewer(tx, consumerId, row.node_run_id)) continue
    else if (reworkBlocksNode(tx, row.node_run_id)) waiting.push(pred)
    else if (SUCCESS_STATUS.has(row.status)) continue
    else if (FAILED_STATUS.has(row.status)) failed.push(pred)
    else waiting.push(pred)
  }
  // A wholly inactive path is settled without taking a lease. In particular, an explicit
  // acquire request must not race the pruning sweep and start a dead member's successor.
  if (consumerNodeId && parallel && inactive === preds.length) waiting.push(...preds)
  return missing.length + failed.length + waiting.length === 0
    ? { ready: true }
    : { ready: false, missingPreds: missing, failedPreds: failed, waitingPreds: waiting }
}

function parallelSkipReceipt(tx: ReadTx, nodeRunId: string): { payload: string } | undefined {
  return tx.get("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='parallel.path_skipped' ORDER BY seq DESC LIMIT 1", [nodeRunId])
}

function proofTopology(tx: ReadTx, runId: string): PinnedTopology | null {
  const binding = readRunBinding(tx, runId)
  return binding?.workflow_definition_hash ? pinnedRunTopology(binding) : null
}

/** A shared join has at least one live input. Skip only when every edge is proven inactive,
 * and at least one was disabled by a successful parallel result. */
function parallelInactiveInputs(tx: ReadTx, secret: string, runId: string, nodeId: string, preds: readonly string[],
  topology: PinnedTopology, lookup: PathLookup, active = new Set<string>()): string[] {
  if (active.has(nodeId)) return []
  const inputs: string[] = []
  let parallel = false
  active.add(nodeId)
  try {
    for (const id of preds) {
      const row = runPathNode(tx, runId, id)
      if (!row || reworkBlocksNode(tx, row.node_run_id)) return []
      const path = parallelMemberPath(tx, secret, runId, row, topology)
      const mayUseSkip = row.status === 'superseded' && (path === 'active'
        || (path === 'waiting' && unopenedParallelMember(tx, secret, runId, topology, row)))
      if (path === 'inactive' || (mayUseSkip && verifiedParallelSkip(tx, secret, runId, id, row.node_run_id, topology, lookup, active))) {
        parallel = true
      } else if (mayUseSkip && branchSkipped(tx, row.node_run_id)) {
        const branchPath = branchSkipPath(tx, secret, runId, row.node_run_id, topology)
        if (branchPath === 'failed' || branchPath === 'waiting') return []
        parallel ||= branchPath === 'inactive'
      } else if (path === 'active' && row.node_type === 'branch' && row.status === 'done' && intactBranchChain(tx, secret, row.node_run_id)) {
        const target = selectedBranchTarget(tx, row.node_run_id)
        if (!target || target === nodeId) return []
      } else {
        return []
      }
      inputs.push(row.node_run_id)
    }
    return parallel ? inputs.sort() : []
  } finally {
    active.delete(nodeId)
  }
}

export function verifiedParallelSkip(tx: ReadTx, secret: string, runId: string, nodeId: string, nodeRunId: string,
  topology = proofTopology(tx, runId), lookup?: PathLookup, active?: Set<string>): boolean {
  const receipt = parallelSkipReceipt(tx, nodeRunId)
  if (!receipt || !chainIsIntact(secret, readChain(tx, nodeRunId), readChainHead(tx, nodeRunId), true)) return false
  if (!topology) return false
  lookup ??= id => nodePredecessors(tx, runId, topology, id)
  const inputs = parallelInactiveInputs(tx, secret, runId, nodeId, lookup(nodeId), topology, lookup, active)
  return inputs.length > 0 && JSON.stringify(inputs) === JSON.stringify(JSON.parse(receipt.payload).inactive_predecessors)
}

/** Record a signed, attempt-bound explanation before a dead path can become neutral at a later join. */
export function pruneInactiveParallelPaths(tx: Tx, secret: string, runId: string, now: string): void {
  if (!tx.get(`SELECT 1 FROM node_run_events e JOIN node_runs n USING(node_run_id)
    WHERE n.run_id=? AND e.type='parallel.result'
      AND CASE WHEN json_valid(e.payload) THEN json_array_length(e.payload,'$.tolerated_member_ids') END > 0 LIMIT 1`, [runId])) return
  const binding = readRunBinding(tx, runId)
  const topology = binding?.workflow_definition_hash && !binding.cancel_requested_at && binding.status !== 'paused'
    ? pinnedRunTopology(binding) : null
  if (!topology) return
  const preds = runPredecessors(tx, runId, topology.edges)
  const lookup = (id: string) => preds.get(id) ?? []
  const queued = tx.all<{ node_id: string; node_run_id: string; attempt: number; side_effect_policy: string }>(
    "SELECT node_id,node_run_id,attempt,side_effect_policy FROM node_runs WHERE run_id=? AND status='queued' AND parent_node_run_id IS NULL",
    [runId],
  )
  const remaining = new Set(queued)
  for (let changed = true; changed;) {
    changed = false
    for (const row of remaining) {
      const inputs = parallelInactiveInputs(tx, secret, runId, row.node_id, lookup(row.node_id), topology, lookup)
      const current = inputs.length ? runPathNode(tx, runId, row.node_id) : undefined
      if (!inputs.length || reworkBlocksNode(tx, row.node_run_id)
          || !chainIsIntact(secret, readChain(tx, row.node_run_id), readChainHead(tx, row.node_run_id))
          || current?.node_run_id !== row.node_run_id || (topology.parallelOwner(row.node_id) !== undefined
            && !unopenedParallelMember(tx, secret, runId, topology, current))) continue
      applyTransition(tx, secret, { nodeRunId: row.node_run_id, from: ['queued'], to: 'superseded', ruleId: 'M-62', attempt: row.attempt, now,
        patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 } })
      appendNodeRunEvent(tx, secret, row.node_run_id, 'parallel.path_skipped',
        { inactive_predecessors: inputs, previous_side_effect_policy: row.side_effect_policy })
      remaining.delete(row)
      changed = true
    }
  }
}

/** A later node still depends on the route that enabled its already-completed predecessors. */
export function branchAncestryIsIntact(tx: ReadTx, secret: string, runId: string, topology: PinnedTopology, direct: readonly string[]): boolean {
  if (!topology.hasRoutes && !topology.hasParallel) return true
  const visited = new Set<string>()
  const pending = [...direct]
  while (pending.length) {
    const nodeId = pending.pop()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const row = runPathNode(tx, runId, nodeId)
    if (row) {
      const consistent = isTerminal(row.status)
        ? parallelMemberPath(tx, secret, runId, row, topology) !== 'waiting'
        : parallelMembershipIsConsistent(tx, secret, runId, topology, row)
      if (!consistent && !(row.status === 'superseded' && unopenedParallelMember(tx, secret, runId, topology, row))) return false
    }
    if (row?.status === 'superseded' && parallelSkipReceipt(tx, row.node_run_id)) {
      if (!verifiedParallelSkip(tx, secret, runId, nodeId, row.node_run_id, topology, id => nodePredecessors(tx, runId, topology, id))) return false
      continue
    }
    if (row?.status === 'superseded' && branchSkipped(tx, row.node_run_id)) {
      const path = branchSkipPath(tx, secret, runId, row.node_run_id, topology)
      if (path === 'waiting' || path === 'failed') return false
      continue
    }
    if (row?.node_type === 'branch' && row.status === 'done') {
      if (!selectedBranchTarget(tx, row.node_run_id) || !intactBranchChain(tx, secret, row.node_run_id)) return false
    }
    pending.push(...nodePredecessors(tx, runId, topology, nodeId))
  }
  return true
}
