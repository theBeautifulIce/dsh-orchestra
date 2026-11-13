// src/service/sweep.ts —— 维护扫描（规格 4.9 行 426-429）
import type { Db } from '../infra/sqlite/driver.ts'
import { inTx } from '../infra/db/tx.ts'
import { sweepExpiredLeases } from './commands/lease.ts'
import { pickReplayHead, revokeFence, type FenceRow } from './commands/cancel.ts'
import { transitionNode } from './commands/node-state.ts'

export type SweepResult = {
  lease_expired: string[]
  fence_revoked: string[]
  // 判定时限到点、超时转阻塞的节点（规格 4.4 行 333）
  verify_timed_out: string[]
  // 围栏撤销后该重放的队头；S3 接上决定重放后由决策循环消费
  replay_heads: { node_run_id: string; report_id: string; report_seq: number }[]
  scanned_at: string
}

// 扫描必须可重入：重复跑不会产生第二份副作用
export function sweep(db: Db, secret: string, params: { now: string }): SweepResult {
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
    // 判定时限到点：verifying 超时转 blocked_post，并留一条 verify_human（规格 4.4 行 333）
    const timedOut: string[] = []
    const verifying = tx.all<{ node_run_id: string; attempt: number; revision: number; verify_deadline_at: string }>(
      'SELECT node_run_id, attempt, revision, verify_deadline_at FROM node_runs WHERE status = ? AND verify_deadline_at IS NOT NULL',
      ['verifying'],
    )
    for (const row of verifying) {
      if (Date.parse(row.verify_deadline_at) > Date.parse(params.now)) continue
      try {
        transitionNode(tx, secret, {
          nodeRunId: row.node_run_id,
          from: 'verifying',
          to: 'blocked_post',
          attempt: row.attempt,
          revision: row.revision,
          now: params.now,
          reason: 'verify_timeout',
          verifyHuman: { reason: 'verify_timeout', missing: [] },
        })
        timedOut.push(row.node_run_id)
      } catch {
        // 别的流程刚改过这一行：跳过这一行，不让单行失败拖垮整批扫描（审计 N-04）
      }
    }
    return { lease_expired: leaseExpired, fence_revoked: revoked, verify_timed_out: timedOut, replay_heads: heads, scanned_at: params.now }
  })
}
