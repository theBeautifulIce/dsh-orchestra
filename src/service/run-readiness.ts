import { TERMINAL_STATUSES } from '../core/state-machine.ts'
import type { WorkflowDefinition } from '../core/workflow-def.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { runtimeEdges, type RuntimeEdge } from './rework-edges.ts'
import { isCandidateReviewer, reworkBlocksNode } from './rework-runtime.ts'
import { definitionHashOf } from './workflows.ts'
import { branchSkipped, selectedBranchTarget } from './branch-routing.ts'

const SUCCESS_STATUS: ReadonlySet<string> = new Set(['done', 'succeeded', 'succeeded_with_unverified'])
const FAILED_STATUS: ReadonlySet<string> = new Set(TERMINAL_STATUSES.filter((status) => !SUCCESS_STATUS.has(status)))

export type DependencyReadiness =
  | { ready: true }
  | { ready: false; missingPreds: string[]; failedPreds: string[]; waitingPreds: string[] }

export function readRunBinding(tx: ReadTx, runId: string) {
  return tx.get<{
    status: string; cancel_requested_at: string | null; workflow_definition_hash: string | null; definition_json: string | null
  }>(`SELECT r.status,r.cancel_requested_at,r.workflow_definition_hash,w.definition_json FROM runs r
    LEFT JOIN workflow_versions w ON w.workflow_id=COALESCE(r.workflow_id,'default') AND w.version=r.workflow_version
      AND (r.workflow_definition_hash IS NULL OR w.content_hash=r.workflow_definition_hash) WHERE r.run_id=?`, [runId])
}

/** A null result means the persisted topology could not be verified. */
export function pinnedEdges(binding: NonNullable<ReturnType<typeof readRunBinding>>): readonly RuntimeEdge[] | null {
  if (!binding.definition_json) return binding.workflow_definition_hash ? null : []
  try {
    const definition = JSON.parse(binding.definition_json) as WorkflowDefinition
    if (binding.workflow_definition_hash && definitionHashOf(definition) !== binding.workflow_definition_hash) return null
    const edges = definition.edges ?? []
    return Array.isArray(edges) && edges.every(edge => typeof edge?.from === 'string' && typeof edge.to === 'string') ? edges : null
  } catch {
    return null
  }
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
export function dependencyReadiness(tx: ReadTx, runId: string, consumerId: string, preds: readonly string[], consumerNodeId?: string): DependencyReadiness {
  const missing: string[] = []
  const failed: string[] = []
  const waiting: string[] = []
  for (const pred of preds) {
    const row = tx.get<{ node_run_id: string; status: string; node_type: string }>(
      'SELECT node_run_id,status,node_type FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [runId, pred],
    )
    if (!row) missing.push(pred)
    else if (row.status === 'superseded' && branchSkipped(tx, row.node_run_id)) continue
    else if (row.status === 'done' && row.node_type === 'branch' && !selectedBranchTarget(tx, row.node_run_id)) failed.push(pred)
    else if (row.status === 'done' && row.node_type === 'branch' && consumerNodeId !== undefined
      && selectedBranchTarget(tx, row.node_run_id) !== consumerNodeId) continue
    else if (row.status === 'done' && isCandidateReviewer(tx, consumerId, row.node_run_id)) continue
    else if (reworkBlocksNode(tx, row.node_run_id)) waiting.push(pred)
    else if (SUCCESS_STATUS.has(row.status)) continue
    else if (FAILED_STATUS.has(row.status)) failed.push(pred)
    else waiting.push(pred)
  }
  return missing.length + failed.length + waiting.length === 0
    ? { ready: true }
    : { ready: false, missingPreds: missing, failedPreds: failed, waitingPreds: waiting }
}
