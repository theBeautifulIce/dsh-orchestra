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
  // I6：审批绑定内容哈希与有效期；内容变或过期，审批不得放行。
  contentHash?: string | null
  expiresAt?: string | null
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
    'INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, content_hash, expires_at, created_at) ' +
      "VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)",
    [
      draft.decisionId,
      draft.runId,
      draft.nodeRunId,
      draft.kind,
      JSON.stringify(draft.payload ?? {}),
      draft.contentHash ?? null,
      draft.expiresAt ?? null,
      draft.createdAt ?? new Date().toISOString(),
    ],
  )
}

/**
 * 不可逆动作在派发前必须有前置审批（规格 5.6）：
 * - 非 irreversible 不开卡；
 * - 已有活跃 pre_execution 卡时复用，不重复开第二张；
 * - 只写 decision 行，节点迁移交给调用方。
 */
export function ensurePreExecutionDecision(
  tx: Tx,
  draft: DecisionDraft & { policy: 'pure' | 'compensable' | 'irreversible' },
): string | null {
  if (draft.policy !== 'irreversible') return null
  if (draft.kind !== 'pre_execution') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '不可逆前置审批必须是 pre_execution 卡', { kind: draft.kind })
  }
  const existing = activeDecision(tx, draft.runId, 'pre_execution', draft.nodeRunId)
  if (existing) return existing.decision_id
  openDecision(tx, draft)
  return draft.decisionId
}

export type Resolution =
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'confirm_applied'
  | 'confirm_not_applied'
  | 'confirm_started'
  | 'confirm_not_started'
  | 'continue_tracking'
  | 'continue_wait'
  | 'abandon'
  | 'uphold_report'
  | 'uphold_decision'

const FINAL_RESOLUTIONS: readonly Resolution[] = ['approved', 'rejected', 'expired']

export type ResolveDecisionRequest = {
  decisionId: string
  revision: number
  resolution: Resolution
  now: string
  payload?: Record<string, unknown>
}

/**
 * 结论落地：
 * - approved/rejected/expired 收口为 resolved，closed_reason 记 approved/rejected/expired_final；
 * - confirm/continue/abandon/uphold 类结论只推进 revision，status 保持原活跃态。
 * CAS 带 revision，旧 revision 抛 DECISION_REVISION_CONFLICT。
 */
export function resolveDecision(tx: Tx, req: ResolveDecisionRequest): void {
  const current = tx.get<{ status: string; payload_json: string }>(
    'SELECT status, payload_json FROM decisions WHERE decision_id = ?',
    [req.decisionId],
  )
  if (!current) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 不存在', { decisionId: req.decisionId })
  }
  const closing = FINAL_RESOLUTIONS.includes(req.resolution)
  const nextStatus = closing ? 'resolved' : current.status
  const closedReason = closing
    ? req.resolution === 'expired' ? 'expired_final' : req.resolution
    : null
  const payloadJson = req.payload
    ? JSON.stringify({ ...(JSON.parse(current.payload_json) as Record<string, unknown>), ...req.payload })
    : current.payload_json
  const res = tx.run(
    'UPDATE decisions SET status = ?, revision = revision + 1, closed_reason = ?, decided_at = ?, payload_json = ? ' +
      `WHERE decision_id = ? AND revision = ? AND status IN ${ACTIVE_STATUSES}`,
    [nextStatus, closedReason, closing ? req.now : null, payloadJson, req.decisionId, req.revision],
  )
  if (res.changes !== 1) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 收口 CAS 未命中', {
      decisionId: req.decisionId,
      revision: req.revision,
    })
  }
}

// 继续等 / 继续跟踪：只续一版，不改变 status
export function extendDecision(tx: Tx, req: Omit<ResolveDecisionRequest, 'resolution'> & {
  resolution: 'continue_wait' | 'continue_tracking'
}): void {
  resolveDecision(tx, req)
}

export type EscalateOptions = {
  now: string
  blockedAfterMs?: number
  expireAfterMs?: number
}

/**
 * 超时升级：活跃且非 report_contradicted 的卡，满 2 小时升 blocked_for_human，满 24 小时 expired。
 * report_contradicted 不参与升级，避免把“报告与人裁决冲突”自动关掉。
 */
export function escalateDecisions(tx: Tx, opts: EscalateOptions): { blocked: number; expired: number } {
  const nowMs = Date.parse(opts.now)
  const blockedAfterMs = opts.blockedAfterMs ?? 2 * 60 * 60 * 1000
  const expireAfterMs = opts.expireAfterMs ?? 24 * 60 * 60 * 1000
  const rows = tx.all<{ decision_id: string; status: string; revision: number; created_at: string }>(
    "SELECT decision_id, status, revision, created_at FROM decisions WHERE kind <> 'report_contradicted' " +
      `AND status IN ${ACTIVE_STATUSES}`,
  )
  let blocked = 0
  let expired = 0
  for (const row of rows) {
    const age = nowMs - Date.parse(row.created_at)
    if (age >= expireAfterMs) {
      tx.run(
        "UPDATE decisions SET status = 'resolved', closed_reason = 'expired_final', revision = revision + 1, decided_at = ? " +
          'WHERE decision_id = ? AND revision = ?',
        [opts.now, row.decision_id, row.revision],
      )
      expired += 1
    } else if (age >= blockedAfterMs && row.status !== 'blocked_for_human') {
      tx.run(
        "UPDATE decisions SET status = 'blocked_for_human', revision = revision + 1 WHERE decision_id = ? AND revision = ?",
        [row.decision_id, row.revision],
      )
      blocked += 1
    }
  }
  return { blocked, expired }
}

