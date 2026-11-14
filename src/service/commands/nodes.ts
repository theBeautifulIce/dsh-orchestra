// src/service/commands/nodes.ts —— 单条 CAS 迁移执行器（S3 Task 2，规格 4.3/4.4）
import { OrchError } from '../../core/errors.ts'
import { canTransition, TRANSITIONS, type NodeStatus, type TransitionContext } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { uuidv7 } from '../../core/ids.ts'
import {
  chooseBranch, evaluatePolicy,
  type BranchChoice, type BranchEdge, type PolicyCondition, type PolicyOutcome,
} from '../../core/policy.ts'
import { openDecision } from './decisions.ts'

export type TransitionPatch = Readonly<Record<string, string | number | null>>

// 只允许迁移规则显式声明的列；patch 的键不能来自外部请求的自由文本。
const PATCH_COLUMNS = new Set([
  'action_generation',
  'rearm_generation',
  'hang_reason',
  'contradiction_decision_id',
  'startup_unknown_remaining_ns',
  'startup_unknown_deadline_at',
  'startup_unknown_boot_id',
  'startup_unknown_monotonic_ns',
  'fence_state',
  'fence_grace_until',
  'fence_grace_boot_id',
  'fence_grace_monotonic_ns',
  'deadline_at',
  'deadline_boot_id',
  'deadline_monotonic_ns',
  'verify_remaining_ns',
  'verify_started_at',
  'verify_deadline_at',
  'verify_deadline_boot_id',
  'verify_deadline_monotonic_ns',
  // 审批往返：blocked_pre 记回队目标与审批卡，同时收回旧租约
  'resume_state',
  'blocked_decision_id',
  'lease_id',
  'lease_expires_at',
  'executor_session_id',
  'executor_agent_id',
  // 等待节点：进入时收租约并挂 wait 钟，唤醒/超时时清钟
  'wait_started_at',
  'wait_deadline_at',
  'wait_deadline_boot_id',
  'wait_deadline_monotonic_ns',
])

export type TransitionRequest = {
  nodeRunId: string
  from: readonly NodeStatus[]
  to: NodeStatus
  attempt: number
  now: string
  actionGeneration?: number
  // 重新武装类迁移必须带读到的旧 Gr，成功后同一笔 CAS 里 Gr+1
  rearmGeneration?: number
  patch?: TransitionPatch
  // 只有写 hang_reason 的规则可以越过 hang_reason IS NULL 的普通出口闸门
  allowHung?: boolean
  // 等待节点的 M-20/M-21/M-22 是重新武装，同一笔 CAS 里 Gr+1
  bumpRearm?: boolean
  // 带 requires 的迁移必须带判定上下文；只给形状、触发条件由命中的规则补齐
  context?: Omit<TransitionContext, 'status' | 'target' | 'trigger'>
}

/**
 * 把一条迁移落成单条 UPDATE：
 * - 条件含 node_run_id、from 集合、attempt，普通出口再带 hang_reason IS NULL；
 * - 受影响行数必须恰为 1，否则抛 STALE_GENERATION，由调用方事务整体回滚。
 */
export function applyTransition(tx: Tx, req: TransitionRequest): void {
  if (req.from.length === 0) {
    throw new OrchError('STALE_GENERATION', '迁移缺少来源状态', { nodeRunId: req.nodeRunId })
  }
  // 状态对必须来自唯一迁移表；同状态写只用于挂起/清挂起，不改变状态。
  for (const from of req.from) {
    if (from === req.to) continue
    if (!canTransition(from, req.to)) {
      throw new OrchError('STALE_GENERATION', '这条迁移不在合法迁移表里', {
        nodeRunId: req.nodeRunId,
        from,
        to: req.to,
      })
    }
    // 只有 requires 边时，必须拿到上下文并真正满足前提；不能凭“表里有这条边”放行。
    const candidates = TRANSITIONS.filter((rule) => rule.from.includes(from) && rule.to.includes(req.to))
    if (candidates.length > 0 && candidates.every((rule) => rule.requires !== undefined)) {
      const ctx = req.context
      const satisfied = ctx !== undefined && candidates.some((rule) => rule.requires?.({
        ...ctx,
        status: from,
        target: req.to,
        trigger: rule.trigger,
      }) === true)
      if (!satisfied) {
        throw new OrchError('STALE_GENERATION', '这条迁移的前提不成立', {
          nodeRunId: req.nodeRunId,
          from,
          to: req.to,
        })
      }
    }
  }
  const patch = req.patch ?? {}
  const columns = Object.keys(patch)
  for (const column of columns) {
    if (!PATCH_COLUMNS.has(column)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '迁移 patch 含未登记的列', { column })
    }
  }
  const setSql = ['status = ?', 'revision = revision + 1', 'updated_at = ?']
    .concat(req.bumpRearm ? ['rearm_generation = rearm_generation + 1'] : [])
    .concat(columns.map((column) => column + ' = ?'))
    .join(', ')
  const whereSql = [
    'node_run_id = ?',
    'status IN (' + req.from.map(() => '?').join(', ') + ')',
    'attempt = ?',
  ]
  const whereBinds: unknown[] = [req.nodeRunId, ...req.from, req.attempt]
  if (!req.allowHung) whereSql.push('hang_reason IS NULL')
  if (req.actionGeneration !== undefined) {
    whereSql.push('action_generation = ?')
    whereBinds.push(req.actionGeneration)
  }
  if (req.rearmGeneration !== undefined) {
    whereSql.push('rearm_generation = ?')
    whereBinds.push(req.rearmGeneration)
  }
  const values: unknown[] = [req.to, req.now, ...columns.map((column) => patch[column])]
  const res = tx.run(
    'UPDATE node_runs SET ' + setSql + ' WHERE ' + whereSql.join(' AND '),
    [...values, ...whereBinds],
  )
  if (res.changes !== 1) {
    throw new OrchError('STALE_GENERATION', 'node_run 迁移 CAS 未命中', {
      nodeRunId: req.nodeRunId,
      from: req.from,
      to: req.to,
      attempt: req.attempt,
    })
  }
}

export type CreateNodeRunRequest = {
  newNodeRunId: string
  runId: string
  nodeId: string
  seq: number
  nodeType: string
  attempt: number
  originNodeRunId: string
  now: string
}

/**
 * 新建一个 attempt：新行 queued、revision=1，旧行写 replacement_node_run_id。
 * 旧行不能已有 replacement；唯一索引 node_runs_origin_uq 保证一个旧行只被接班一次。
 */
export function createNodeRun(tx: Tx, req: CreateNodeRunRequest): void {
  if (req.attempt < 1) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'attempt 必须从 1 开始', { attempt: req.attempt })
  }
  if (req.originNodeRunId) {
    const origin = tx.get<{ hang_reason: string | null }>('SELECT hang_reason FROM node_runs WHERE node_run_id = ?', [req.originNodeRunId])
    if (origin?.hang_reason) {
      throw new OrchError('STALE_HANG', '旧 attempt 挂在冲突上，新 attempt 要被挡住', {
        originNodeRunId: req.originNodeRunId,
        hangReason: origin.hang_reason,
      })
    }
  }
  tx.run(
    'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, origin_node_run_id, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)",
    [req.newNodeRunId, req.runId, req.nodeId, req.seq, req.nodeType, req.attempt, req.originNodeRunId, req.now, req.now],
  )
  const res = tx.run(
    'UPDATE node_runs SET replacement_node_run_id = ?, updated_at = ? WHERE node_run_id = ? AND replacement_node_run_id IS NULL',
    [req.newNodeRunId, req.now, req.originNodeRunId],
  )
  if (res.changes !== 1) {
    throw new OrchError('STALE_GENERATION', '旧 attempt 不能被再次接班', {
      originNodeRunId: req.originNodeRunId,
      newNodeRunId: req.newNodeRunId,
    })
  }
}

// ── 审批往返（S3 Task 6，M-39/M-40/M-41）────────────────────────────────

type ApprovalDecisionRow = {
  decision_id: string
  node_run_id: string | null
  kind: string
  status: string
  closed_reason: string | null
  content_hash: string | null
  expires_at: string | null
}

function loadApprovalDecision(tx: Tx, decisionId: string): ApprovalDecisionRow {
  const decision = tx.get<ApprovalDecisionRow>(
    'SELECT decision_id, node_run_id, kind, status, closed_reason, content_hash, expires_at FROM decisions WHERE decision_id = ?',
    [decisionId],
  )
  if (!decision) throw new OrchError('DECISION_REQUIRED', '审批卡不存在', { decisionId })
  if (!['pre_execution', 'audit_result'].includes(decision.kind)) {
    throw new OrchError('DECISION_REQUIRED', '这张卡不是审批卡', { decisionId, kind: decision.kind })
  }
  return decision
}

export type EnterBlockedPreRequest = {
  nodeRunId: string
  attempt: number
  decisionId: string
  actionGeneration: number
  now: string
}

/**
 * 进入 blocked_pre：只从 queued / leased 进，收掉旧租约，记 resume_state='queued'。
 * 审批卡必须已经存在且挂在本节点上；节点迁移交给调用方。
 */
export function enterBlockedPre(tx: Tx, secret: string, req: EnterBlockedPreRequest): void {
  const row = tx.get<{ status: NodeStatus; attempt: number; action_generation: number }>(
    'SELECT status, attempt, action_generation FROM node_runs WHERE node_run_id = ?',
    [req.nodeRunId],
  )
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: req.nodeRunId })
  if (row.status !== 'queued' && row.status !== 'leased') {
    throw new OrchError('STALE_GENERATION', '只有 queued / leased 能进 blocked_pre', {
      nodeRunId: req.nodeRunId,
      status: row.status,
    })
  }
  const decision = loadApprovalDecision(tx, req.decisionId)
  if (decision.node_run_id !== req.nodeRunId) {
    throw new OrchError('DECISION_REQUIRED', '审批卡没有挂在这个节点上', {
      decisionId: req.decisionId,
      nodeRunId: req.nodeRunId,
    })
  }
  if (!['pending', 'acknowledged', 'blocked_for_human'].includes(decision.status)) {
    throw new OrchError('DECISION_REQUIRED', '审批卡已经收口，不能再次阻塞', {
      decisionId: req.decisionId,
      status: decision.status,
    })
  }
  const fromStatus = row.status
  applyTransition(tx, {
    nodeRunId: req.nodeRunId,
    from: [fromStatus],
    to: 'blocked_pre',
    attempt: req.attempt,
    actionGeneration: req.actionGeneration,
    now: req.now,
    patch: {
      resume_state: 'queued',
      blocked_decision_id: req.decisionId,
      // 进审批前收回执行租约，批准后重新排队再拿新租约，不复用旧租约。
      lease_id: null,
      lease_expires_at: null,
    },
  })
  appendNodeRunEvent(tx, secret, req.nodeRunId, 'status_changed', {
    from: fromStatus,
    to: 'blocked_pre',
    decision_id: req.decisionId,
    resume_state: 'queued',
  })
}

export type ResumeFromBlockedPreRequest = {
  nodeRunId: string
  attempt: number
  decisionId: string
  approved: boolean
  now: string
  // 审批绑定的内容哈希；卡上记录了哈希时必须逐字相等。
  contentHash?: string | null
}

/**
 * 审批结论落地：
 * - 批准：回 queued，attempt 不变，必须先确认旧租约已收回；
 * - 拒绝 / 超时：落 failed，审批卡 id 留在节点上备查；
 * - 内容哈希不一致或卡已过期，拒绝放行。
 */
export function resumeFromBlockedPre(tx: Tx, secret: string, req: ResumeFromBlockedPreRequest): void {
  const row = tx.get<{
    status: NodeStatus
    attempt: number
    lease_id: string | null
    blocked_decision_id: string | null
  }>(
    'SELECT status, attempt, lease_id, blocked_decision_id FROM node_runs WHERE node_run_id = ?',
    [req.nodeRunId],
  )
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: req.nodeRunId })
  if (row.status !== 'blocked_pre') {
    throw new OrchError('STALE_GENERATION', '节点不在 blocked_pre', {
      nodeRunId: req.nodeRunId,
      status: row.status,
    })
  }
  if (row.lease_id !== null) {
    throw new OrchError('STALE_GENERATION', 'blocked_pre 不能带着旧租约重新排队', {
      nodeRunId: req.nodeRunId,
      leaseId: row.lease_id,
    })
  }
  if (row.blocked_decision_id !== req.decisionId) {
    throw new OrchError('DECISION_REQUIRED', '审批卡与节点当前阻塞卡不一致', {
      nodeRunId: req.nodeRunId,
      expected: row.blocked_decision_id,
      actual: req.decisionId,
    })
  }
  const decision = loadApprovalDecision(tx, req.decisionId)
  if (req.approved && decision.expires_at && Date.parse(req.now) >= Date.parse(decision.expires_at)) {
    throw new OrchError('CONFIRMATION_EXPIRED', '审批卡已过期，默认动作走 failed', {
      decisionId: req.decisionId,
      expiresAt: decision.expires_at,
      now: req.now,
    })
  }
  if (decision.content_hash !== null && (req.contentHash ?? null) !== decision.content_hash) {
    throw new OrchError('CONFIRMATION_MISMATCH', '审批绑定的内容已变化，批准失效', {
      decisionId: req.decisionId,
    })
  }
  const expectedReason = req.approved ? 'approved' : 'rejected'
  const allowedReasons = req.approved ? ['approved'] : ['rejected', 'expired_final']
  if (decision.status !== 'resolved' || !allowedReasons.includes(decision.closed_reason ?? '')) {
    throw new OrchError('DECISION_REQUIRED', '审批卡还没有对应的收口结论', {
      decisionId: req.decisionId,
      status: decision.status,
      closedReason: decision.closed_reason,
      expected: expectedReason,
    })
  }
  if (req.approved) {
    applyTransition(tx, {
      nodeRunId: req.nodeRunId,
      from: ['blocked_pre'],
      to: 'queued',
      attempt: req.attempt,
      now: req.now,
      patch: { resume_state: null, blocked_decision_id: null },
    })
  } else {
    applyTransition(tx, {
      nodeRunId: req.nodeRunId,
      from: ['blocked_pre'],
      to: 'failed',
      attempt: req.attempt,
      now: req.now,
      patch: { resume_state: null },
    })
  }
  appendNodeRunEvent(tx, secret, req.nodeRunId, 'status_changed', {
    from: 'blocked_pre',
    to: req.approved ? 'queued' : 'failed',
    decision_id: req.decisionId,
    resolution: req.approved ? 'approved' : 'rejected',
    attempt: req.attempt,
  })
}

// ── branch 路由与 policy 求值落账（S3 Task 7）──────────────────────────────

function branchPolicyOutcome(choice: BranchChoice): PolicyOutcome {
  if (choice.kind === 'selected') {
    return {
      schema_version: 1,
      matched: true,
      ruleId: choice.ruleId,
      decision: 'pass',
      must_pass_items: [{ id: choice.ruleId, result: 'pass', evidence_ids: [] }],
      failed_items: [],
      evidence_ids: [],
      reason: 'branch 命中',
    }
  }
  const label = choice.reason === 'ambiguous' ? 'branch 多命中' : 'branch 无命中'
  return {
    schema_version: 1,
    matched: false,
    ruleId: null,
    decision: 'fail',
    must_pass_items: [],
    failed_items: choice.matched,
    evidence_ids: [],
    reason: label,
  }
}

export type ApplyBranchRouteRequest = {
  nodeRunId: string
  attempt: number
  from: readonly NodeStatus[]
  edges: readonly BranchEdge[]
  input: unknown
  now: string
  // 无命中时生成的 rule_ambiguous 卡；缺省自动生成
  decisionId?: string
  runId?: string
}

/**
 * branch 只做路由：
 * - 多命中：抛 BRANCH_AMBIGUOUS，节点状态不动；
 * - 全不命中且无 default：落 blocked_post 并生成 rule_ambiguous；
 * - 单命中/default：追加 policy.evaluated，路由交给调用方。
 */
export function applyBranchRoute(tx: Tx, secret: string, req: ApplyBranchRouteRequest): BranchChoice {
  const choice = chooseBranch(req.edges, req.input)
  if (choice.kind === 'blocked' && choice.reason === 'ambiguous') {
    throw new OrchError('BRANCH_AMBIGUOUS', 'branch 运行期多命中，不能猜', {
      nodeRunId: req.nodeRunId,
      matched: choice.matched,
    })
  }
  if (choice.kind === 'selected') {
    appendNodeRunEvent(tx, secret, req.nodeRunId, 'policy.evaluated', branchPolicyOutcome(choice))
    return choice
  }
  const decisionId = req.decisionId ?? 'dec_' + uuidv7()
  const runId = req.runId ?? tx.get<{ run_id: string }>(
    'SELECT run_id FROM node_runs WHERE node_run_id = ?', [req.nodeRunId],
  )?.run_id
  if (!runId) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId: req.nodeRunId })
  openDecision(tx, {
    decisionId,
    runId,
    nodeRunId: req.nodeRunId,
    kind: 'rule_ambiguous',
    payload: { matched: choice.matched, edges: req.edges.map((edge) => edge.to) },
    createdAt: req.now,
  })
  for (const from of req.from) {
    const exists = tx.get<{ node_run_id: string }>(
      'SELECT node_run_id FROM node_runs WHERE node_run_id = ? AND status = ? AND attempt = ?',
      [req.nodeRunId, from, req.attempt],
    )
    if (!exists) continue
    applyTransition(tx, {
      nodeRunId: req.nodeRunId,
      from: [from],
      to: 'blocked_post',
      attempt: req.attempt,
      now: req.now,
      patch: { resume_state: null },
    })
    appendNodeRunEvent(tx, secret, req.nodeRunId, 'policy.evaluated', branchPolicyOutcome(choice))
    appendNodeRunEvent(tx, secret, req.nodeRunId, 'status_changed', {
      from,
      to: 'blocked_post',
      decision_id: decisionId,
      reason: 'rule_ambiguous',
    })
    return choice
  }
  throw new OrchError('STALE_GENERATION', 'branch 节点不在声明的来源状态', {
    nodeRunId: req.nodeRunId,
    from: req.from,
    attempt: req.attempt,
  })
}

/** 单个 policy 条件求值并落到 node_run_events；不镜像进 events。 */
export function recordPolicyEvaluation(
  tx: Tx,
  secret: string,
  nodeRunId: string,
  condition: PolicyCondition | readonly PolicyCondition[],
  input: unknown,
  options?: { ruleId?: string; evidenceIds?: string[] },
): PolicyOutcome {
  const outcome = evaluatePolicy(condition, input, options)
  appendNodeRunEvent(tx, secret, nodeRunId, 'policy.evaluated', outcome)
  return outcome
}
