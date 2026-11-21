import type { ReadTx } from './queries/read-tx.ts'

export type RuntimeEdge = Readonly<{ from: string; to: string }>

export function approvedRuntimeEdges(tx: ReadTx, runId: string, target?: string): RuntimeEdge[] {
  return tx.all<RuntimeEdge>(
    'SELECT e.from_node_id AS "from",e.to_node_id AS "to" FROM rework_plan_edges e '
    + 'JOIN rework_local_plans p ON p.plan_hash=e.plan_hash AND p.request_id=e.request_id '
    + 'JOIN rework_requests r ON r.request_id=e.request_id AND r.run_id=e.run_id '
    + 'WHERE e.run_id=? AND p.approved_by IS NOT NULL' + (target === undefined ? '' : ' AND e.to_node_id=?')
    + ' ORDER BY e.from_node_id,e.to_node_id',
    target === undefined ? [runId] : [runId, target],
  )
}

/** Add only persisted, approved, run-scoped dependencies to the immutable base DAG. */
export function runtimeEdges(tx: ReadTx, runId: string, base: readonly RuntimeEdge[]): RuntimeEdge[] {
  const unique = new Map<string, RuntimeEdge>()
  for (const edge of [...base, ...approvedRuntimeEdges(tx, runId)]) unique.set(JSON.stringify([edge.from, edge.to]), edge)
  return [...unique.values()]
}
