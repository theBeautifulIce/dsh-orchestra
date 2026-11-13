// src/service/commands/node-state.ts —— 节点状态迁移（规格 4.3 行 309-311、3.5 行 176）
import { OrchError, proposedError } from '../../core/errors.ts'
import { canTransition } from '../../core/state-machine.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'

export type TransitionParams = {
  nodeRunId: string
  from: string
  to: string
  attempt: number
  revision: number
  // 动作代：重新派发或新 attempt 时加一（规格 4.3 行 311）
  actionGeneration?: number
  // 续期代：重新武装截止时间、裁决续期、桥恢复补预算时加一（规格 4.3 行 310）
  rearmGeneration?: number
  now: string
  reason: string
  // 阻塞必须挂一张裁决卡：没有 decision_id 就不许把节点卡住（规格 4.3、G2-06）
  decisionId?: string
  // S2 还没有 decisions 表：证据不足时用 verify_human 请求代替裁决卡，等 S3 接上后按事件重放（S2 计划 :32-38）
  verifyHuman?: { reason: string; missing: string[] }
  // 进 verifying 时挂判定时限；不传就用默认 120 秒（规格 4.4 行 333）
  verifyTimeoutMs?: number
}

// verifying 的判定时限：规格 4.4 行 333 定的是 120 秒
export const DEFAULT_VERIFY_TIMEOUT_MS = 120000


// 迁移必须合法，且 CAS 条件里带 revision 与 attempt
export function transitionNode(tx: Tx, secret: string, params: TransitionParams): void {
  if (!canTransition(params.from, params.to)) {
    throw new OrchError('STALE_GENERATION', '这条迁移不在合法迁移表里', {
      from: params.from,
      to: params.to,
    })
  }
  // 阻塞的两条合法理由：裁决卡，或一条明确的 verify_human 请求；两样都没有就是裸卡住
  const blocking = params.to === 'blocked_pre' || params.to === 'blocked_post'
  if (blocking && !params.decisionId && !params.verifyHuman) {
    throw proposedError('DECISION_REQUIRED', '阻塞节点要挂一张裁决卡或一条 verify_human 请求，不能裸卡住', { to: params.to })
  }
  const sets: string[] = ['status = ?', 'revision = revision + 1', 'updated_at = ?']
  const values: unknown[] = [params.to, params.now]
  if (params.actionGeneration !== undefined) {
    sets.push('action_generation = ?')
    values.push(params.actionGeneration)
  }
  if (params.rearmGeneration !== undefined) {
    sets.push('rearm_generation = ?')
    values.push(params.rearmGeneration)
  }
  // verify 时钟：进 verifying 挂钟，离开半态清钟（规格 4.4 行 328、333）
  let verifyDeadlineAt: string | null = null
  if (params.to === 'verifying') {
    const budgetMs = params.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    verifyDeadlineAt = new Date(Date.parse(params.now) + budgetMs).toISOString()
    sets.push('verify_deadline_at = ?')
    values.push(verifyDeadlineAt)
  } else if (params.from === 'verifying') {
    sets.push('verify_deadline_at = NULL')
  }
  values.push(params.nodeRunId, params.from, params.attempt, params.revision)
  // 条件里必须带 revision 与 attempt；受影响行数必须恰为 1（总纲 §4.4）
  runCas(
    tx,
    'UPDATE node_runs SET ' + sets.join(', ') + ' WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    values,
    { rows: 1, what: 'transitionNode' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'status_changed', {
    from: params.from,
    to: params.to,
    attempt: params.attempt,
    action_generation: params.actionGeneration,
    rearm_generation: params.rearmGeneration,
    reason: params.reason,
    decision_id: params.decisionId,
    verify_human: params.verifyHuman ?? null,
    verify_deadline_at: verifyDeadlineAt,
  })
  // 没有裁决卡时，verify_human 事件就是 S2 的阻塞凭据；S3 按它生成真正的裁决卡
  if (blocking && !params.decisionId && params.verifyHuman) {
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'verify_human', {
      reason: params.verifyHuman.reason,
      missing: params.verifyHuman.missing,
      status: params.to,
    })
  }
}

// 重新武装截止时间：截止时间变了就算续期，Gr 加一，Ga 不动（规格 4.3 行 310）
export function rearmDeadline(tx: Tx, secret: string, params: {
  nodeRunId: string
  attempt: number
  revision: number
  deadlineAt: string
  deadlineBootId: string
  deadlineMonotonicNs: number
  rearmGeneration: number
  now: string
  reason: string
}): void {
  runCas(
    tx,
    'UPDATE node_runs SET deadline_at = ?, deadline_boot_id = ?, deadline_monotonic_ns = ?, rearm_generation = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND revision = ?',
    [params.deadlineAt, params.deadlineBootId, params.deadlineMonotonicNs, params.rearmGeneration, params.now, params.nodeRunId, params.attempt, params.revision],
    { rows: 1, what: 'rearmDeadline' },
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'deadline_rearmed', {
    deadline_at: params.deadlineAt,
    rearm_generation: params.rearmGeneration,
    reason: params.reason,
  })
}
