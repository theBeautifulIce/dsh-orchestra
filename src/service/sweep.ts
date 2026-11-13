// src/service/sweep.ts —— 维护扫描（规格 4.9 行 426-429）
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'
import { sweepExpiredLeases } from './commands/lease.ts'
import { pickReplayHead, revokeFence, type FenceRow } from './commands/cancel.ts'
import { transitionNode } from './commands/node-state.ts'
import type { ClockProvider, Deadline } from '../core/clock.ts'

export type SweepResult = {
  lease_expired: string[]
  fence_revoked: string[]
  // 判定时限到点、超时转阻塞的节点（规格 4.4 行 333）
  verify_timed_out: string[]
  // 时钟不确定（漂移超差、跨 boot、没有判定锚点）转阻塞的节点：宁可等人来看，也不自动判超时（规格 3.4 行 171）
  verify_uncertain: string[]
  // 围栏撤销后该重放的队头；S3 接上决定重放后由决策循环消费
  replay_heads: { node_run_id: string; report_id: string; report_seq: number }[]
  scanned_at: string
}

type VerifyRow = {
  node_run_id: string
  attempt: number
  revision: number
  verify_deadline_at: string | null
  verify_deadline_boot_id: string | null
  verify_deadline_monotonic_ns: number | null
}

// 扫描必须可重入：重复跑不会产生第二份副作用
export function sweep(db: Db, secret: string, params: { now: string; clock?: ClockProvider }): SweepResult {
  return inTx(db, (tx) => {
    const leaseExpired = sweepExpiredLeases(tx, secret, { now: params.now, leaseTtlMs: 0 })
    // 围栏宽限到点：撤围栏回 stopping，并把当前 attempt 的队头挑出来（规格 4.5 行 346）
    const fences = tx.all<FenceRow>(
      'SELECT node_run_id, attempt, revision, status, fence_state, fence_grace_until FROM node_runs WHERE fence_state = ? AND fence_grace_until IS NOT NULL',
      ['armed'],
    )
    const revoked: string[] = []
    const heads: SweepResult['replay_heads'] = []
    for (const row of fences) {
      if (!revokeFence(tx, secret, { row, now: params.now })) continue
      revoked.push(row.node_run_id)
      const head = pickReplayHead(tx, row.node_run_id, row.attempt)
      if (head) heads.push({ node_run_id: row.node_run_id, report_id: head.report_id, report_seq: head.report_seq })
    }
    // 判定时限：只读 boot_id 与单调纳秒，墙钟只用于展示（规格 3.4 行 171、12.3 行 1066）
    const timedOut: string[] = []
    const uncertain: string[] = []
    const verifying = tx.all<VerifyRow>(
      'SELECT node_run_id, attempt, revision, verify_deadline_at, verify_deadline_boot_id, verify_deadline_monotonic_ns FROM node_runs WHERE status = ? AND verify_deadline_at IS NOT NULL',
      ['verifying'],
    )
    for (const row of verifying) {
      const deadline = verifyDeadline(row)
      // 没有判定锚点就没有判定依据：按不确定处理，不拿墙钟硬比（规格 3.4 行 171）
      if (!deadline || !params.clock) {
        if (blockVerifying(tx, secret, row, params.now, 'timer_uncertain', ['verify_deadline_anchor_missing'])) {
          uncertain.push(row.node_run_id)
        }
        continue
      }
      const decision = params.clock.decide(deadline)
      if (decision.kind === 'pending') continue
      if (decision.kind === 'expired') {
        if (blockVerifying(tx, secret, row, params.now, 'verify_timeout', [])) timedOut.push(row.node_run_id)
        continue
      }
      if (blockVerifying(tx, secret, row, params.now, 'timer_uncertain', [decision.reason])) {
        uncertain.push(row.node_run_id)
      }
    }
    return {
      lease_expired: leaseExpired,
      fence_revoked: revoked,
      verify_timed_out: timedOut,
      verify_uncertain: uncertain,
      replay_heads: heads,
      scanned_at: params.now,
    }
  })
}

// 节点行上的判定锚点 → 判定用的 Deadline；墙钟只是展示用（规格 3.4 行 171）
function verifyDeadline(row: VerifyRow): Deadline | null {
  if (!row.verify_deadline_boot_id || row.verify_deadline_monotonic_ns === null || !row.verify_deadline_at) return null
  return {
    bootId: row.verify_deadline_boot_id,
    monotonicNs: Number(row.verify_deadline_monotonic_ns),
    wallClockMs: Date.parse(row.verify_deadline_at),
  }
}

// 转阻塞并留一条 verify_human：超时就写 verify_timeout，不确定就写 timer_uncertain
function blockVerifying(tx: Tx, secret: string, row: VerifyRow, now: string, reason: string, missing: string[]): boolean {
  try {
    transitionNode(tx, secret, {
      nodeRunId: row.node_run_id,
      from: 'verifying',
      to: 'blocked_post',
      attempt: row.attempt,
      revision: row.revision,
      now,
      reason,
      verifyHuman: { reason, missing },
    })
    return true
  } catch {
    // 别的流程刚改过这一行：跳过这一行，不让单行失败拖垮整批扫描（审计 N-04）
    return false
  }
}
