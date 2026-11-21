import { OrchError } from '../../core/errors.ts'
import { nodeRunId } from '../../core/ids.ts'
import type { WorkflowDefinition } from '../../core/workflow-def.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { createNodeRun } from '../commands/nodes.ts'
import { LIMITS } from '../schemas.ts'
import { reworkBlocksNode } from '../rework-runtime.ts'
import { definitionHashOf } from '../workflows.ts'

type RetryOrigin = {
  node_run_id: string; run_id: string; node_id: string; node_type: string; seq: number
  attempt: number; action_generation: number; rearm_generation: number
}
type RetryTarget = Pick<RetryOrigin, 'node_run_id' | 'node_id' | 'attempt'>
type RetryRead = Pick<Tx, 'get' | 'all'>
const missingDefinition = '恢复重试需要运行绑定的已发布工作流定义'

/** Returns the published definition hash only for an eligible, explicitly authorized new attempt. */
export function ordinaryRetryAuthority(tx: RetryRead, node: RetryTarget): string | undefined {
  const row = tx.get<{
    workflow_id: string; version: string; workflow_definition_hash: string | null
    content_hash: string; definition_json: string; side_effect_policy: string
    cancelled: number; invalid_origin: number; protected_execution: number
  }>(`
    SELECT v.workflow_id,v.version,r.workflow_definition_hash,v.content_hash,v.definition_json,n.side_effect_policy,
      (r.cancel_requested_at IS NOT NULL OR n.cancel_requested_at IS NOT NULL) AS cancelled,
      (n.replacement_node_run_id IS NOT NULL OR n.parent_node_run_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM node_runs latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id
          AND latest.attempt>n.attempt)) AS invalid_origin,
      (EXISTS (SELECT 1 FROM rework_attempts a WHERE a.old_node_run_id=n.node_run_id OR a.new_node_run_id=n.node_run_id)
        OR EXISTS (SELECT 1 FROM rework_impacts i WHERE i.replacement_node_run_id=n.node_run_id
          OR (i.node_run_id=n.node_run_id AND i.released_at IS NULL))
        OR EXISTS (SELECT 1 FROM rework_requests q WHERE q.run_id=n.run_id
          AND n.node_run_id IN (q.target_node_run_id,q.new_node_run_id,q.requester_node_run_id)
          AND q.status NOT IN ('closed','declined','cancelled'))
        OR EXISTS (SELECT 1 FROM bridge_tool_outbox o WHERE o.node_run_id=n.node_run_id
          AND o.attempt=n.attempt AND o.status='pending')
        OR EXISTS (SELECT 1 FROM tool_executions t WHERE t.node_run_id=n.node_run_id
          AND t.attempt=n.attempt AND t.finished_at IS NULL)) AS protected_execution
    FROM node_runs n JOIN runs r USING(run_id)
    JOIN workflow_versions v ON v.workflow_id=COALESCE(r.workflow_id,'default') AND v.version=CAST(r.workflow_version AS TEXT)
    WHERE n.node_run_id=? AND v.doc_json IS NOT NULL AND v.published_by IS NOT NULL
  `, [node.node_run_id])
  if (!row) return undefined
  let def: WorkflowDefinition
  try {
    def = JSON.parse(row.definition_json) as WorkflowDefinition
    if (!def || !Array.isArray(def.nodes)) throw new Error('missing workflow nodes')
  } catch {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', missingDefinition)
  }
  if (!row.workflow_definition_hash || row.workflow_definition_hash !== row.content_hash
    || (def.workflow_id ?? 'default') !== row.workflow_id || String(def.workflow_version) !== row.version
    || definitionHashOf(def) !== row.content_hash) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', missingDefinition)
  }
  const role = def.nodes.find(n => n.node_id === node.node_id)
  if (role?.type !== 'agent' || role.recovery_retry_idempotent !== true || role.side_effect_policy === 'irreversible'
    || row.side_effect_policy === 'irreversible') return undefined
  const parallelOwners = new Set(def.nodes.filter(n => n.type === 'parallel').map(n => n.node_id))
  if (node.attempt >= LIMITS.attemptMax || row.cancelled || row.invalid_origin || row.protected_execution || reworkBlocksNode(tx, node.node_run_id)
    || def.edges?.some(edge => edge.to === node.node_id && parallelOwners.has(edge.from))) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '当前执行尝试不能重新派发')
  }
  return row.content_hash
}

export function ordinaryRetryDisposition(tx: RetryRead, node: RetryTarget): 'retry' | 'failed' | 'unavailable' {
  try {
    return ordinaryRetryAuthority(tx, node) ? 'retry' : 'failed'
  } catch (error) {
    if (error instanceof OrchError && error.code === 'RESOLUTION_NOT_AVAILABLE') return 'unavailable'
    throw error
  }
}

/** The caller has just moved the verified origin to superseded in the same transaction. */
export function createOrdinaryRetry(tx: Tx, secret: string, node: RetryOrigin, input: {
  decisionId: string; revision: number; definitionHash: string; now: string
}): void {
  const id = nodeRunId()
  const attempt = node.attempt + 1
  createNodeRun(tx, { newNodeRunId: id, runId: node.run_id, nodeId: node.node_id, nodeType: node.node_type,
    seq: node.seq, attempt, originNodeRunId: node.node_run_id, previousActionGeneration: node.action_generation,
    preserveOriginSideEffectPolicy: true, now: input.now })
  const authority = { decision_id: input.decisionId, decision_revision: input.revision, definition_hash: input.definitionHash }
  appendNodeRunEvent(tx, secret, node.node_run_id, 'decision.retry_scheduled', {
    ...authority, attempt: node.attempt, action_generation: node.action_generation, rearm_generation: node.rearm_generation,
    replacement_node_run_id: id, replacement_attempt: attempt,
  })
  appendNodeRunEvent(tx, secret, id, 'node.retry_queued', {
    ...authority, origin_node_run_id: node.node_run_id, attempt, action_generation: node.action_generation,
  })
}
