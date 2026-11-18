// src/service/commands/decisions.ts —— 八种 decision 的生成、查重与收口（S3 Task 3，规格 3.6）
import { OrchError } from '../../core/errors.ts'
import type { DecisionKind } from '../../core/state-machine.ts'
import { assertApprover, defaultApprover, type Actor, type Approver } from '../decision/approver.ts'
import { appendEvent, appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { closeRun } from './run-close.ts'
import { settleDecisionOutcome } from './effects.ts'
import { applyTransition } from './nodes.ts'
import { decisionConfirmRequired } from './start-run.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from './idempotency.ts'

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

export function acknowledgeDecision(tx: Tx, req: { decisionId: string; revision: number; operationId: string; actor: Actor; now: string }) {
  const kind = 'decision.acknowledge'
  const decision = tx.get<{ run_id: string; node_run_id: string | null; approver: string }>(
    'SELECT run_id, node_run_id, approver FROM decisions WHERE decision_id = ?', [req.decisionId],
  )
  if (!decision) throw new OrchError('NOT_FOUND', '找不到这条决定')
  assertApprover({ approver: decision.approver as Approver, actor: req.actor })
  return runIdempotentCommand(tx, {
    kind, operationId: req.operationId, now: req.now,
    requestHash: requestHashOf(kind, { decision_id: req.decisionId, revision: req.revision, actor: req.actor.id }),
  }, () => {
    const result = tx.run("UPDATE decisions SET status = 'acknowledged', revision = revision + 1 WHERE decision_id = ? AND revision = ? AND status = 'pending'",
      [req.decisionId, req.revision])
    if (result.changes !== 1) throw new OrchError('DECISION_REVISION_CONFLICT', '决定状态或版本已变')
    appendEvent(tx, {
      type: 'decision.acknowledged', runId: decision.run_id, nodeRunId: decision.node_run_id, decisionId: req.decisionId,
      payload: { actor: req.actor.id, revision: req.revision + 1 },
    })
    return { decisionId: req.decisionId, revision: req.revision + 1 }
  }).result
}

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
  // 批准人档位；旧调用不传时用 either，保持既有行为
  approver?: string
  // 升级规则命中时置 1，批准动作必须带 confirm
  confirmRequired?: boolean
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
  const payload = draft.payload ?? {}
  const actionCategory = typeof payload.action_category === 'string' ? payload.action_category : undefined
  const approver = draft.approver ?? defaultApprover(draft.kind, actionCategory)
  // 任务级 escalations 在开卡时就要翻成 confirm_required，不能只写字段没人读。
  const nodeType = typeof payload.node_type === 'string' ? payload.node_type : undefined
  const confirmRequired = draft.confirmRequired ?? decisionConfirmRequired(tx, draft.runId, {
    nodeType,
    actionCategory,
    workflowId: typeof payload.workflow_id === 'string' ? payload.workflow_id : undefined,
    workflowVersion: typeof payload.workflow_version === 'string' ? payload.workflow_version : undefined,
  })
  tx.run(
    'INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, content_hash, expires_at, approver, confirm_required, created_at) ' +
      "VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)",
    [
      draft.decisionId,
      draft.runId,
      draft.nodeRunId,
      draft.kind,
      JSON.stringify(payload),
      draft.contentHash ?? null,
      draft.expiresAt ?? null,
      approver,
      confirmRequired ? 1 : 0,
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

const FINAL_RESOLUTIONS: readonly Resolution[] = ['approved', 'rejected', 'expired', 'uphold_report', 'uphold_decision']

export type ResolveDecisionRequest = {
  decisionId: string
  revision: number
  resolution: Resolution
  now: string
  payload?: Record<string, unknown>
  // 批准人校验：actor 必须由命令入口给出，不能从卡类型反推
  actor?: Actor
  evidenceProducers?: readonly string[]
  // escalations 命中 confirm_required=1 时，必须显式带 confirm=true
  confirm?: boolean
  // 审批绑定的内容哈希；卡上有哈希时由调用方带入审批往返，不匹配不放行。
  contentHash?: string | null
}

export type DecisionResolution = {
  decisionId: string
  status: string
  closedReason: string | null
  runId: string
  // 这张卡如果还压着一个 blocked_pre 节点，生产入口要在同一事务里恢复它
  blockedNode: { nodeRunId: string; attempt: number } | null
}

/**
 * 结论落地：
 * - approved/rejected/expired 收口为 resolved，closed_reason 记 approved/rejected/expired_final；
 * - confirm/continue/abandon/uphold 类结论只推进 revision，status 保持原活跃态。
 * CAS 带 revision，旧 revision 抛 DECISION_REVISION_CONFLICT。
 */
const MEMORY_RECOVERY = Symbol('memory-recovery')
const MEMORY_APPROVAL = Symbol('memory-approval')

export function resolveMemoryRecoveryDecision(tx: Tx, secret: string, req: ResolveDecisionRequest): DecisionResolution {
  return resolveDecision(tx, secret, req, MEMORY_RECOVERY)
}

export function resolveMemoryApprovalDecision(tx: Tx, secret: string, req: ResolveDecisionRequest): DecisionResolution {
  return resolveDecision(tx, secret, req, MEMORY_APPROVAL)
}

export function resolveDecision(tx: Tx, secret: string, req: ResolveDecisionRequest, scope?: symbol): DecisionResolution {
  if (scope !== MEMORY_RECOVERY && tx.get(
    'SELECT 1 FROM memory_write_recoveries WHERE decision_id = ? OR abandon_ack_id = ?',
    [req.decisionId, req.decisionId],
  )) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆恢复决定必须走带对账证据的恢复命令')
  if (scope !== MEMORY_APPROVAL && tx.get('SELECT 1 FROM memory_batches WHERE decision_id = ?', [req.decisionId])) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '记忆审批必须同时记录批次批准快照')
  }
  const current = tx.get<{ status: string; payload_json: string; approver: string; confirm_required: number; run_id: string }>(
    'SELECT status, payload_json, approver, confirm_required, run_id FROM decisions WHERE decision_id = ?',
    [req.decisionId],
  )
  if (!current) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 不存在', { decisionId: req.decisionId })
  }
  if (current.confirm_required === 1 && req.confirm !== true) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 命中升级规则，必须显式确认', {
      decisionId: req.decisionId,
    })
  }
  const actor = req.actor
  if (!actor) {
    throw new OrchError('FORBIDDEN', '必须说明批准人', { approver: current.approver })
  }
  assertApprover({
    approver: current.approver as Approver,
    actor,
    evidenceProducers: req.evidenceProducers,
  })
  const closing = FINAL_RESOLUTIONS.includes(req.resolution)
  const nextStatus = closing ? 'resolved' : current.status
  const closedReason = closing
    ? req.resolution === 'expired'
      ? 'expired_final'
      : req.resolution === 'uphold_report'
        ? 'approved'
        : req.resolution
    : null
  const payloadJson = req.payload
    ? JSON.stringify({ ...(JSON.parse(current.payload_json) as Record<string, unknown>), ...req.payload })
    : current.payload_json
  const res = tx.run(
    'UPDATE decisions SET status = ?, revision = revision + 1, closed_reason = ?, decided_at = ?, payload_json = ?, resolved_by = COALESCE(?, resolved_by) ' +
      `WHERE decision_id = ? AND revision = ? AND status IN ${ACTIVE_STATUSES}`,
    [nextStatus, closedReason, closing ? req.now : null, payloadJson, actor.id, req.decisionId, req.revision],
  )
  if (res.changes !== 1) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 收口 CAS 未命中', {
      decisionId: req.decisionId,
      revision: req.revision,
    })
  }
  appendEvent(tx, {
    type: 'decision.resolved',
    payload: {
      decisionId: req.decisionId,
      revision: req.revision + 1,
      resolution: req.resolution,
      status: nextStatus,
      resolvedBy: actor.id,
    },
  })
  // 裁决卡收口后，先找回被它压住的节点；生产入口在同一事务里恢复：
  // approved 回 queued，rejected/expired 落 failed。这里只返回事实，状态变更仍走迁移表。
  const blocked = closing
    ? tx.get<{ node_run_id: string; attempt: number }>(
      "SELECT node_run_id, attempt FROM node_runs WHERE blocked_decision_id = ? AND status = 'blocked_pre'",
      [req.decisionId],
    )
    : undefined
  // 副作用结算：人工裁决收口的同一笔事务里落结算行（附录 §4）。
  // 裁决说「已发生」→ decision 分支；说「没发生」→ verified_none 分支（事件带 decision_id）。
  if (closing) settleDecisionOutcome(tx, secret, { decisionId: req.decisionId, now: req.now })
  // 裁决卡收口后，若所有节点都已到终态，run 也要在同一笔事务里收口。
  if (closing) closeRun(tx, secret, current.run_id, req.now)
  return {
    decisionId: req.decisionId,
    status: nextStatus,
    closedReason,
    runId: current.run_id,
    blockedNode: blocked
      ? { nodeRunId: blocked.node_run_id, attempt: Number(blocked.attempt) }
      : null,
  }
}

// 继续等 / 继续跟踪：只续一版，不改变 status
export function extendDecision(tx: Tx, secret: string, req: Omit<ResolveDecisionRequest, 'resolution'> & {
  resolution: 'continue_wait' | 'continue_tracking'
}): void {
  resolveDecision(tx, secret, req)
}

export type EscalateOptions = {
  now: string
  blockedAfterMs?: number
  expireAfterMs?: number
}

export type DecisionTimeoutDisposition = 'default_action' | 'hold_for_human'

// supervised 是唯一不允许超时自动收口的档位；其余档位按默认动作过期。
export function timeoutDisposition(autonomy: string): DecisionTimeoutDisposition {
  return autonomy === 'supervised' ? 'hold_for_human' : 'default_action'
}

const ACTIVE_STATUS_LIST = ['pending', 'acknowledged', 'blocked_for_human'] as const

// run 终态：这些 run 上的卡不再被维护扫描改写
const RUN_TERMINAL_STATUSES = [
  'succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled', 'done',
] as const

export type CancelDecisionParams = {
  decisionId: string
  now: string
  // cancelled：因为 run/节点被取消而关闭；expired_final：真正超时
  reason: 'cancelled' | 'expired_final'
  resolvedBy?: string | null
}

/**
 * 关闭一张活跃裁决卡：revision CAS、resolved_by、decision.resolved 事件三件套齐活。
 * 以前取消路径直接 UPDATE，既没 CAS 也没事件，还把“取消”记成 expired_final（G3 r11 P2）。
 */
export function cancelDecision(tx: Tx, secret: string, p: CancelDecisionParams): { changed: boolean; revision: number | null } {
  const current = tx.get<{ status: string; revision: number; run_id: string }>(
    'SELECT status, revision, run_id FROM decisions WHERE decision_id = ?',
    [p.decisionId],
  )
  if (!current) return { changed: false, revision: null }
  if (!(ACTIVE_STATUS_LIST as readonly string[]).includes(current.status)) {
    return { changed: false, revision: current.revision }
  }
  const res = tx.run(
    'UPDATE decisions SET status = ?, revision = revision + 1, closed_reason = ?, decided_at = ?, resolved_by = COALESCE(?, resolved_by) '
    + `WHERE decision_id = ? AND revision = ? AND status IN ${ACTIVE_STATUSES}`,
    ['resolved', p.reason, p.now, p.resolvedBy ?? 'system:cancel', p.decisionId, current.revision],
  )
  if (res.changes !== 1) return { changed: false, revision: null }
  appendEvent(tx, {
    type: 'decision.resolved',
    payload: {
      decisionId: p.decisionId,
      revision: current.revision + 1,
      resolution: p.reason === 'cancelled' ? 'cancelled' : 'expired',
      status: 'resolved',
      resolvedBy: p.resolvedBy ?? 'system:cancel',
    },
  })
  return { changed: true, revision: current.revision + 1 }
}
export type SweepDecisionsOptions = EscalateOptions & {
  // 自动过期后要尝试收口对应 run
  closeRunAfter?: boolean
  /** 哈希链已断或已标不确定的节点：不做自动升级、不放行节点（评审 P1-1） */
  skipNodeRunIds?: ReadonlySet<string>
  /** 含断链节点的 run：不做自动收口 */
  skipRunIds?: ReadonlySet<string>
}

export type SweepDecisionsOutcome = {
  blocked: number
  expired: number
  // 被超时收口的裁决卡放掉的 blocked_pre 节点
  releasedNodes: string[]
  closedRuns: string[]
}

/**
 * 维护扫描里的决策超时：满 2 小时升 blocked_for_human，满 24 小时按默认动作过期。
 * 与单个受理入口共用同一套 CAS 与事件语义；supervised 只升级不自动收口，
 * report_contradicted 一律留给人裁决（规格 3.6）。
 */
export function sweepDecisions(tx: Tx, secret: string, opts: SweepDecisionsOptions): SweepDecisionsOutcome {
  const nowMs = Date.parse(opts.now)
  const blockedAfterMs = opts.blockedAfterMs ?? 2 * 60 * 60 * 1000
  const expireAfterMs = opts.expireAfterMs ?? 24 * 60 * 60 * 1000
  const rows = tx.all<{
    decision_id: string
    run_id: string
    status: string
    revision: number
    created_at: string
    autonomy: string
    run_status: string | null
    node_status: string | null
    node_run_id: string | null
  }>(
    'SELECT d.decision_id, d.run_id, d.status, d.revision, d.created_at, d.node_run_id, '
      + 'COALESCE(t.autonomy, \'autonomous\') AS autonomy, r.status AS run_status, n.status AS node_status '
      + 'FROM decisions d LEFT JOIN runs r ON r.run_id = d.run_id LEFT JOIN tasks t ON t.task_id = r.task_id '
      + 'LEFT JOIN node_runs n ON n.node_run_id = d.node_run_id '
      + "WHERE d.kind <> 'report_contradicted' "
      + 'AND NOT EXISTS (SELECT 1 FROM memory_batches b WHERE b.decision_id = d.decision_id) '
      + 'AND NOT EXISTS (SELECT 1 FROM memory_write_recoveries m WHERE m.decision_id = d.decision_id OR m.abandon_ack_id = d.decision_id) '
      + `AND d.status IN ${ACTIVE_STATUSES}`,
  )
  const out: SweepDecisionsOutcome = { blocked: 0, expired: 0, releasedNodes: [], closedRuns: [] }
  for (const row of rows) {
    // 断链/不确定节点上的裁决卡：不自动升级、不放行（评审 P1-1）
    if (row.node_run_id && opts.skipNodeRunIds?.has(row.node_run_id)) continue
    if (opts.skipRunIds?.has(row.run_id)) continue
    // run 已终态：这张卡不再有业务含义，不自动改写也不尝试收口
    if (row.run_status !== null && (RUN_TERMINAL_STATUSES as readonly string[]).includes(row.run_status)) continue
    const age = nowMs - Date.parse(row.created_at)
    // blocked_post 压在人工核验上：证据门只能由人关，自动过期会留下“卡没了、节点还卡着”的死角
    const holdForHuman = timeoutDisposition(row.autonomy) === 'hold_for_human' || row.node_status === 'blocked_post'
    if (age >= expireAfterMs && !holdForHuman) {
      const closed = cancelDecision(tx, secret, { decisionId: row.decision_id, now: opts.now, reason: 'expired_final' })
      // 并发的人工裁决抢先改了 revision：本轮不算自动处理成功
      if (!closed.changed) continue
      out.expired += 1
      const released = releaseBlockedPreNode(tx, secret, { decisionId: row.decision_id, now: opts.now })
      if (released) out.releasedNodes.push(released)
      if (opts.closeRunAfter !== false && !opts.skipRunIds?.has(row.run_id)) {
        if (closeRun(tx, secret, row.run_id, opts.now)) out.closedRuns.push(row.run_id)
      }
      continue
    }
    if (age >= blockedAfterMs && row.status !== 'blocked_for_human') {
      const res = tx.run(
        "UPDATE decisions SET status = 'blocked_for_human', revision = revision + 1 WHERE decision_id = ? AND revision = ? AND status IN ('pending', 'acknowledged')",
        [row.decision_id, row.revision],
      )
      if (res.changes !== 1) continue
      appendEvent(tx, {
        type: 'decision.blocked',
        payload: {
          decisionId: row.decision_id,
          revision: row.revision + 1,
          reason: 'timeout_escalated',
          blockedAfterMs,
        },
      })
      out.blocked += 1
    }
  }
  return out
}

// 自动过期后，压在卡上的 blocked_pre 节点必须一起放掉：否则 run 永远等一个已经关掉的卡。
function releaseBlockedPreNode(tx: Tx, secret: string, p: { decisionId: string; now: string }): string | null {
  const node = tx.get<{ node_run_id: string; attempt: number }>(
    "SELECT node_run_id, attempt FROM node_runs WHERE blocked_decision_id = ? AND status = 'blocked_pre'",
    [p.decisionId],
  )
  if (!node) return null
  try {
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id,
      from: ['blocked_pre'],
      to: 'failed',
      ruleId: 'M-41',
      attempt: node.attempt,
      now: p.now,
      patch: {
        resume_state: null,
        blocked_decision_id: null,
        lease_id: null,
        lease_expires_at: null,
        executor_session_id: null,
        executor_agent_id: null,
      },
    })
  } catch {
    return null
  }
  appendNodeRunEvent(tx, secret, node.node_run_id, 'decision.expired', {
    decision_id: p.decisionId,
    from: 'blocked_pre',
    to: 'failed',
  })
  return node.node_run_id
}

/** 兼容入口：只关心升级/过期条数的调用方用它。secret 必须是真密钥——事件哈希链要用它验。 */
export function escalateDecisions(tx: Tx, secret: string, opts: EscalateOptions): { blocked: number; expired: number } {
  const out = sweepDecisions(tx, secret, { ...opts, closeRunAfter: false })
  return { blocked: out.blocked, expired: out.expired }
}

