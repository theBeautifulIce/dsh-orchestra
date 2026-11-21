import { TERMINAL_STATUSES } from '../core/state-machine.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { approvedRuntimeEdges, runtimeEdges, type RuntimeEdge } from './rework-edges.ts'
import { isCandidateReviewer, reworkBlocksNode } from './rework-runtime.ts'
import { indexTopology, verifiedTopology, type PinnedTopology } from './pinned-topology.ts'
import { branchSkipped, intactBranchChain, selectedBranchTarget, verifiedBranchSkip } from './branch-routing.ts'

const SUCCESS_STATUS: ReadonlySet<string> = new Set(['done', 'succeeded', 'succeeded_with_unverified'])
const FAILED_STATUS: ReadonlySet<string> = new Set(TERMINAL_STATUSES.filter((status) => !SUCCESS_STATUS.has(status)))

export type DependencyReadiness =
  | { ready: true }
  | { ready: false; missingPreds: string[]; failedPreds: string[]; waitingPreds: string[] }

export function readRunBinding(tx: ReadTx, runId: string) {
  return tx.get<{
    status: string; cancel_requested_at: string | null; workflow_definition_hash: string | null;
    definition_json: string | null; content_hash: string | null
  }>(`SELECT r.status,r.cancel_requested_at,r.workflow_definition_hash,w.definition_json,w.content_hash FROM runs r
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

export function pinnedEdges(binding: NonNullable<ReturnType<typeof readRunBinding>>): readonly RuntimeEdge[] | null {
  return pinnedRunTopology(binding)?.edges ?? null
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
export function dependencyReadiness(tx: ReadTx, runId: string, consumerId: string, preds: readonly string[], consumerNodeId?: string, secret?: string): DependencyReadiness {
  const missing: string[] = []
  const failed: string[] = []
  const waiting: string[] = []
  for (const pred of preds) {
    const row = tx.get<{ node_run_id: string; status: string; node_type: string }>(
      'SELECT node_run_id,status,node_type FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [runId, pred],
    )
    if (!row) {
      missing.push(pred)
      continue
    }
    if (row.status === 'superseded' && branchSkipped(tx, row.node_run_id)) {
      if (secret && !verifiedBranchSkip(tx, secret, runId, row.node_run_id)) waiting.push(pred)
      continue
    }
    if (row.status === 'done' && row.node_type === 'branch') {
      const target = selectedBranchTarget(tx, row.node_run_id)
      if (!target || (secret && !intactBranchChain(tx, secret, row.node_run_id))) {
        waiting.push(pred)
        continue
      }
      if (consumerNodeId !== undefined && target !== consumerNodeId) continue
    }
    if (row.status === 'done' && isCandidateReviewer(tx, consumerId, row.node_run_id)) continue
    else if (reworkBlocksNode(tx, row.node_run_id)) waiting.push(pred)
    else if (SUCCESS_STATUS.has(row.status)) continue
    else if (FAILED_STATUS.has(row.status)) failed.push(pred)
    else waiting.push(pred)
  }
  return missing.length + failed.length + waiting.length === 0
    ? { ready: true }
    : { ready: false, missingPreds: missing, failedPreds: failed, waitingPreds: waiting }
}

/** A later node still depends on the route that enabled its already-completed predecessors. */
export function branchAncestryIsIntact(tx: ReadTx, secret: string, runId: string, topology: PinnedTopology, direct: readonly string[]): boolean {
  if (!topology.hasRoutes) return true
  const visited = new Set<string>()
  const pending = [...direct]
  while (pending.length) {
    const nodeId = pending.pop()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const row = tx.get<{ node_run_id: string; status: string; node_type: string }>(
      'SELECT node_run_id,status,node_type FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [runId, nodeId],
    )
    if (row?.status === 'superseded' && branchSkipped(tx, row.node_run_id)) {
      if (!verifiedBranchSkip(tx, secret, runId, row.node_run_id)) return false
      continue
    }
    if (row?.node_type === 'branch' && row.status === 'done') {
      if (!selectedBranchTarget(tx, row.node_run_id) || !intactBranchChain(tx, secret, row.node_run_id)) return false
    }
    pending.push(...nodePredecessors(tx, runId, topology, nodeId))
  }
  return true
}
