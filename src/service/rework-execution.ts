import { OrchError } from '../core/errors.ts'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { snapshotArtifactInputs } from './rework-runtime.ts'
import type { WorkflowCatalog } from './workflows.ts'
import { runtimeEdges } from './rework-edges.ts'
import { extraStepInstruction } from './rework-extra-steps.ts'
import { intactBranchChain, selectedBranchTarget, verifiedBranchSkip } from './branch-routing.ts'
import { parallelMemberMayStart, parallelToleratesMember } from './workflow-parallel.ts'

function localInstruction(tx: Tx, nodeRunId: string, nodeId: string) {
  // First bind the approved plan to an actual successor or a released, previously queued consumer.
  const row = tx.get<{ proposal_json: string; plan_hash: string }>(`SELECT p.proposal_json,p.plan_hash FROM rework_local_plans p
    JOIN rework_requests q USING(request_id)
    WHERE p.approved_by IS NOT NULL AND q.approved_scope='replan_subgraph' AND
      (EXISTS(SELECT 1 FROM rework_attempts a WHERE a.request_id=p.request_id AND a.new_node_run_id=?)
       OR EXISTS(SELECT 1 FROM rework_impacts i WHERE i.request_id=p.request_id
          AND (i.replacement_node_run_id=? OR (i.node_run_id=? AND i.replacement_node_run_id IS NULL AND i.released_at IS NOT NULL))))
    ORDER BY p.created_at DESC LIMIT 1`, [nodeRunId, nodeRunId, nodeRunId])
  if (!row) return null
  const changes = (JSON.parse(row.proposal_json) as { changes: {node_id: string; instruction: string}[] }).changes
  const change = changes.find(c => c.node_id === nodeId)
  return change ? { plan_hash: row.plan_hash, instruction: change.instruction } : null
}

function executionBrief(tx: Tx, nodeRunId: string, nodeId: string, runId: string, input: unknown, now: string) {
  const reference = tx.get<{goal: string; doc_json: string | null}>(`SELECT t.title AS goal,w.doc_json FROM runs r JOIN tasks t USING(task_id)
    LEFT JOIN workflow_versions w ON w.workflow_id=r.workflow_id AND w.version=r.workflow_version WHERE r.run_id=?`, [runId])
  const doc = reference?.doc_json ? JSON.parse(reference.doc_json) as { nodes?: {node_id:string;title?:string;contract?:{description?:string}}[] } : undefined
  const declared = doc?.nodes?.find(n => n.node_id === nodeId)
  const json = canonicalJson(input ?? null)
  tx.run('INSERT OR IGNORE INTO execution_briefs(node_run_id,goal,role,input_json,input_hash,created_at) VALUES(?,?,?,?,?,?)',
    [nodeRunId, reference?.goal ?? runId, declared?.contract?.description ?? declared?.title ?? nodeId,
      Buffer.byteLength(json) <= 32_768 ? json : null, sha256Hex(json), now])
  const original = tx.get<{goal: string;role: string;input_json: string|null;input_hash: string;node_run_id:string}>(`WITH RECURSIVE lineage(id,depth) AS (
      SELECT ?,0 UNION ALL SELECT n.origin_node_run_id,l.depth+1 FROM node_runs n JOIN lineage l ON n.node_run_id=l.id
      WHERE n.origin_node_run_id IS NOT NULL AND l.depth<64)
    SELECT b.* FROM lineage l JOIN execution_briefs b ON b.node_run_id=l.id ORDER BY l.depth DESC LIMIT 1`, [nodeRunId])!
  return { goal: original.goal, role: original.role, node_run_id: original.node_run_id,
    input: original.input_json === null ? undefined : JSON.parse(original.input_json) as unknown, input_hash: original.input_hash }
}

export function executionFeedbackContext(db: Db, catalog: WorkflowCatalog, nodeRunId: string, now: string, assignedInput?: unknown, secret?: string) {
  return withTx(db, tx => {
    const node = tx.get<{ node_id: string; run_id: string; attempt: number; workflow_id: string | null; workflow_version: string; parent_node_run_id: string | null }>(
      'SELECT n.node_id,n.run_id,n.attempt,n.parent_node_run_id,r.workflow_id,r.workflow_version FROM node_runs n JOIN runs r USING(run_id) WHERE n.node_run_id=?',
      [nodeRunId])
    if (!node) throw new OrchError('NOT_FOUND', '未找到当前执行步骤')
    const def = catalog.get(node.workflow_id ?? 'default', node.workflow_version)
    const upstream = runtimeEdges(tx, node.run_id, def.edges ?? []).filter(edge => edge.to === node.node_id).flatMap(edge => {
      const source = tx.get<{ node_run_id: string; node_type: string; status: string; parent_node_run_id: string | null; revision: number }>(`SELECT node_run_id,node_type,status,parent_node_run_id,revision FROM node_runs
        WHERE run_id=? AND node_id=? AND replacement_node_run_id IS NULL ORDER BY attempt DESC LIMIT 1`, [node.run_id, edge.from])
      if (!source) throw new OrchError('STALE_GENERATION', '上游执行记录缺失')
      if (secret) {
        if (source.node_type === 'parallel' && source.status === 'waiting' && node.parent_node_run_id === source.node_run_id
          && parallelMemberMayStart(tx, secret, source.node_run_id, nodeRunId)) return []
        if (source.status === 'superseded' && verifiedBranchSkip(tx, secret, node.run_id, source.node_run_id)) return []
        if (source.node_type === 'branch' && source.status === 'done' && intactBranchChain(tx, secret, source.node_run_id)
          && selectedBranchTarget(tx, source.node_run_id) !== node.node_id) return []
        if (source.parent_node_run_id && parallelToleratesMember(tx, secret, source.parent_node_run_id, source.node_run_id)) return []
      }
      return [source]
    })
    const revisions = new Map(upstream.map(n => [n.node_run_id, n.revision]))
    const inputs = snapshotArtifactInputs(tx, nodeRunId, upstream.map(n => n.node_run_id), now)
      .map(input => ({ ...input, expected_revision: revisions.get(input.upstream_node_run_id) }))
    const revision = tx.get(`SELECT q.request_id,q.approved_scope,q.reason,q.expected_result,q.preserve_requirements_json,
      q.source_artifact_id,q.source_artifact_hash,c.file_name,q.round_no,q.max_rounds,q.budget_remaining
      FROM rework_requests q JOIN artifact_contents c ON c.artifact_id=q.source_artifact_id
      WHERE q.new_node_run_id=? AND q.status='scheduled'`, [nodeRunId])
    const review = tx.get(`SELECT q.request_id,q.revision,q.reason,q.expected_result,a.result_artifact_id,a.result_artifact_hash
      FROM rework_requests q JOIN rework_impacts i USING(request_id)
      JOIN rework_attempts a ON a.request_id=q.request_id AND a.round_no=q.round_no
      WHERE i.replacement_node_run_id=? AND q.status='awaiting_review' AND i.released_at IS NULL`, [nodeRunId])
    const original = executionBrief(tx, nodeRunId, node.node_id, node.run_id, assignedInput, now)
    return { run_id: node.run_id, node_id: node.node_id, attempt: node.attempt, inputs, revision, review,
      original: revision || review ? original : undefined,
      plan_instruction: extraStepInstruction(tx, nodeRunId) ?? localInstruction(tx, nodeRunId, node.node_id) }
  })
}
