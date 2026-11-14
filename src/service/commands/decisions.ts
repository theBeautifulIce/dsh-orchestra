// src/service/commands/decisions.ts —— 八种 decision 的生成、查重与收口（S3 Task 3，规格 3.6）
import { OrchError } from '../../core/errors.ts'
import type { DecisionKind } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'

export const DECISION_KINDS: readonly DecisionKind[] = [
  'pre_execution',
  'action_overrun',
  'abandon_ack',
  'verify_human',
  'audit_result',
  'rule_ambiguous',
  'startup_unknown',
  'report_contradicted',
]

const ACTIVE_STATUSES = "('pending', 'acknowledged', 'blocked_for_human')"

export type DecisionDraft = {
  decisionId: string
  runId: string
  nodeRunId: string | null
  kind: DecisionKind
  payload?: Record<string, unknown>
  createdAt?: string
}

export function activeDecision(tx: Tx, runId: string, kind: DecisionKind, nodeRunId: string | null): { decision_id: string } | undefined {
  return tx.get<{ decision_id: string }>(
    'SELECT decision_id FROM decisions WHERE run_id = ? AND kind = ? ' +
      'AND ((node_run_id IS NULL AND ? IS NULL) OR node_run_id = ?) ' +
      `AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
    [runId, kind, nodeRunId, nodeRunId],
  )
}

export function openDecision(tx: Tx, draft: DecisionDraft): void {
  if (!DECISION_KINDS.includes(draft.kind)) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '未知的 decision kind', { kind: draft.kind })
  }
  const dup = activeDecision(tx, draft.runId, draft.kind, draft.nodeRunId)
  if (dup) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '同一 kind 已有活跃 decision', {
      decisionId: dup.decision_id,
      kind: draft.kind,
      nodeRunId: draft.nodeRunId,
    })
  }
  tx.run(
    'INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) ' +
      "VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)",
    [
      draft.decisionId,
      draft.runId,
      draft.nodeRunId,
      draft.kind,
      JSON.stringify(draft.payload ?? {}),
      draft.createdAt ?? new Date().toISOString(),
    ],
  )
}

export type ResolveDecisionRequest = {
  decisionId: string
  revision: number
  status: 'resolved' | 'superseded'
  closedReason: string
  now: string
}

export function resolveDecision(tx: Tx, req: ResolveDecisionRequest): void {
  const res = tx.run(
    'UPDATE decisions SET status = ?, revision = revision + 1, closed_reason = ?, decided_at = ? ' +
      `WHERE decision_id = ? AND revision = ? AND status IN ${ACTIVE_STATUSES}`,
    [req.status, req.closedReason, req.now, req.decisionId, req.revision],
  )
  if (res.changes !== 1) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 收口 CAS 未命中', {
      decisionId: req.decisionId,
      revision: req.revision,
    })
  }
}
