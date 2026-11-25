import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withReadTx } from './queries/read-tx.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'

/** Describe only the genuine, already completed gates bound to this step. */
export function executionApprovalReceipts(db: Db, secret: string, nodeRunId: string) {
  return withReadTx(db, ({ tx }) => {
    const step = tx.get<{ node_id: string; run_id: string; workflow_definition_hash: string }>(
      'SELECT n.node_id,n.run_id,r.workflow_definition_hash FROM node_runs n JOIN runs r USING(run_id) WHERE n.node_run_id=?', [nodeRunId])
    if (!step) return []
    const plan = readApprovedTaskPlanForRun(tx, step.run_id)
    const bindings = plan?.proposal.constraint_bindings?.filter(item => item.protected_node_ids.includes(step.node_id)) ?? []
    return bindings.map(binding => {
      const decision = tx.get<{ decision_id: string; revision: number; decided_at: string; content_hash: string;
        node_run_id: string; attempt: number }>(`SELECT d.decision_id,d.revision,d.decided_at,d.content_hash,n.node_run_id,n.attempt
        FROM node_runs n JOIN decisions d ON d.run_id=n.run_id AND d.node_run_id=n.node_run_id
        JOIN events e ON e.run_id=d.run_id AND e.node_run_id=n.node_run_id AND e.decision_id=d.decision_id
          AND e.type='decision.resolved' AND json_extract(e.payload_redacted,'$.actorKind')='human'
          AND json_extract(e.payload_redacted,'$.resolution')='approved' AND json_extract(e.payload_redacted,'$.revision')=d.revision
        WHERE n.run_id=? AND n.node_id=? AND n.node_type='approval' AND n.status='done' AND n.replacement_node_run_id IS NULL
          AND d.approver='human' AND d.kind='pre_execution' AND d.closed_reason='approved' AND d.status='resolved'
          AND d.decided_at IS NOT NULL AND d.resolved_by IS NOT NULL ORDER BY n.attempt DESC, n.seq DESC LIMIT 1`,
        [step.run_id, binding.approval_node_id])
      if (decision) {
        const hash = sha256Hex(canonicalJson({ run_id: step.run_id, node_run_id: decision.node_run_id,
          attempt: decision.attempt, definition_hash: step.workflow_definition_hash }))
        const chain = readChain(tx, decision.node_run_id)
        if (hash === decision.content_hash && chainIsIntact(secret, chain, readChainHead(tx, decision.node_run_id), true)
          && chain.some(event => {
            if (event.type !== 'status_changed') return false
            const p = JSON.parse(event.payload)
            return p.to === 'done' && p.reason === 'approval_approved' && p.decision_id === decision.decision_id
          })) {
          const constraint = plan?.brief.requirements_contract?.constraints.find(c => c.id === binding.constraint_id)
          return { constraint_id: binding.constraint_id, approval_node_id: binding.approval_node_id,
            ...(constraint?.kind === 'approval_before' && constraint.gate_name && { name: constraint.gate_name }),
            decision_id: decision.decision_id, revision: decision.revision, decided_at: decision.decided_at, resolution: 'approved' }
        }
      }
      throw new OrchError('CONFIRMATION_MISMATCH', '当前步骤缺少与本次运行绑定的人工批准回执')
    })
  })
}
