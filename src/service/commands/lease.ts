// src/service/commands/lease.ts —— 租约与心跳（规格 4.9 行 425-429、12.3 行 1063）
import { OrchError, proposedError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent, chainBreakOf, readChain } from '../../infra/db/ledger.ts'
import { applyTransition } from './nodes.ts'
import { deadlineFromSample, type ClockProvider } from '../../core/clock.ts'

export type NodeRunRow = {
  node_run_id: string
  run_id: string
  node_id: string
  node_type: string
  seq: number
  attempt: number
  status: string
  revision: number
  owner_epoch: number | null
  lease_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  action_generation: number
  rearm_generation: number
  fence_state: string
  fence_grace_until: string | null
  parent_node_run_id: string | null
  side_effect_policy: 'pure' | 'compensable' | 'irreversible'
  deadline_at: string | null
  deadline_boot_id: string | null
  deadline_monotonic_ns: number | null
  hang_reason: string | null
  contradiction_decision_id: string | null
  startup_unknown_deadline_at: string | null
  startup_unknown_remaining_ns: number | null
  startup_unknown_boot_id: string | null
  startup_unknown_monotonic_ns: number | null
}

export function loadNodeRun(tx: Tx, nodeRunId: string): NodeRunRow {
  const row = tx.get<NodeRunRow>('SELECT * FROM node_runs WHERE node_run_id = ?', [nodeRunId])
  if (!row) throw new OrchError('NOT_FOUND', 'node_run 不存在', { nodeRunId })
  return row
}

export type AcquireLeaseParams = {
  nodeRunId: string
  ownerEpoch: number
  leaseTtlMs: number
  now: string
}

export type AcquireLeaseResult = {
  leaseId: string
  expiresAt: string
  actionGeneration: number
}

// queued → leased → dispatched 同一笔事务；每次派发 Ga 加一，首次为 1，不重置（规格 4.3 行 311）
export function acquireLease(tx: Tx, secret: string, params: AcquireLeaseParams): AcquireLeaseResult {
  const row = loadNodeRun(tx, params.nodeRunId)
  // 租约是进入执行链的唯一入口：链已断的节点不许再派发执行，
  // 否则执行器会继续往坏账本上追加事件，把断链事实洗掉（评审 P1-1 的执行侧旁路）。
  if (chainBreakOf(secret, readChain(tx, params.nodeRunId))) {
    throw new OrchError('FORBIDDEN', '节点哈希链已断，拒绝派发，等人工核账', {
      nodeRunId: params.nodeRunId,
      reason: 'chain_broken',
    })
  }
  if (row.status !== 'queued') {
    throw new OrchError('STALE_GENERATION', '节点不在 queued，拿不到租约', {
      nodeRunId: params.nodeRunId,
      status: row.status,
    })
  }
  // 租约 id：S1 的 ids.ts 里没有 lease 前缀，这里用 uuidv7 加前缀，后续统一了就改这一处
  const leaseId = 'lease_' + uuidv7()
  const expiresAt = new Date(Date.parse(params.now) + params.leaseTtlMs).toISOString()
  const nextGa = row.action_generation + 1
  // 条件里带 revision 与 attempt，防并发抢到同一节点
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, lease_id = ?, lease_expires_at = ?, owner_epoch = ?, action_generation = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['leased', leaseId, expiresAt, params.ownerEpoch, nextGa, params.now, params.nodeRunId, 'queued', row.attempt, row.revision],
    { rows: 1, what: 'acquireLease' },
  )
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND revision = ?',
    ['dispatched', params.now, params.nodeRunId, 'leased', row.attempt, row.revision + 1],
    { rows: 1, what: 'acquireLease-dispatched' },
  )
  tx.run(
    'INSERT INTO leases (lease_id, node_run_id, owner_epoch, expires_at, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [leaseId, params.nodeRunId, params.ownerEpoch, expiresAt, 0, params.now],
  )
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'lease_acquired', {
    lease_id: leaseId,
    action_generation: nextGa,
    expires_at: expiresAt,
  })
  return { leaseId, expiresAt, actionGeneration: nextGa }
}

// 续期只动租约，不动 Ga；Ga 跟动作走，续期跟 Gr 走（规格 4.3 行 309-310）
export function renewLease(tx: Tx, params: { nodeRunId: string; leaseTtlMs: number; now: string; attempt?: number; leaseId?: string; ownerEpoch?: number }): string {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (!row.lease_id) throw new OrchError('STALE_GENERATION', '节点没有租约，续期无效', { nodeRunId: params.nodeRunId })
  // 归属校验：续期只许持有这份租约的同一个执行者做（租约被抢占 / attempt 变了 / 属主变了都算失权）
  if (params.leaseId !== undefined && row.lease_id !== params.leaseId) {
    throw new OrchError('STALE_GENERATION', '租约已被其他执行者接管，续期无效', {
      nodeRunId: params.nodeRunId,
      lease_id: row.lease_id,
    })
  }
  if (params.attempt !== undefined && row.attempt !== params.attempt) {
    throw new OrchError('STALE_GENERATION', '节点 attempt 已变，续期无效', {
      nodeRunId: params.nodeRunId,
      attempt: row.attempt,
    })
  }
  if (params.ownerEpoch !== undefined && row.owner_epoch !== params.ownerEpoch) {
    throw new OrchError('STALE_GENERATION', '租约属主已变，续期无效', {
      nodeRunId: params.nodeRunId,
      owner_epoch: row.owner_epoch,
    })
  }
  assertLeaseValid(row, params.now)
  const expiresAt = new Date(Date.parse(params.now) + params.leaseTtlMs).toISOString()
  runCas(
    tx,
    'UPDATE node_runs SET lease_expires_at = ?, heartbeat_at = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND revision = ? AND lease_id = ?',
    [expiresAt, params.now, params.now, params.nodeRunId, row.revision, row.lease_id],
    { rows: 1, what: 'renewLease' },
  )
  tx.run('UPDATE leases SET expires_at = ?, revision = revision + 1 WHERE lease_id = ?', [expiresAt, row.lease_id])
  return expiresAt
}

// 释放：执行器正常收口时把租约交回去
export function releaseLease(tx: Tx, params: { nodeRunId: string; now: string }): void {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (!row.lease_id) return
  runCas(
    tx,
    'UPDATE node_runs SET lease_id = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND revision = ?',
    [params.now, params.nodeRunId, row.revision],
    { rows: 1, what: 'releaseLease' },
  )
  tx.run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', [params.now, row.lease_id])
}

// 租约过期即失效：迟到上报不许再推进节点（规格 12.3 行 1063）
export function assertLeaseValid(row: NodeRunRow, now: string): void {
  if (!row.lease_expires_at) return
  if (Date.parse(row.lease_expires_at) <= Date.parse(now)) {
    throw proposedError('LEASE_EXPIRED', '租约已过期，执行器迟到上报被拒', {
      node_run_id: row.node_run_id,
      lease_expires_at: row.lease_expires_at,
      now,
    })
  }
}

// 过期扫描：dispatched 或 started 的租约过期后先转 startup_unknown 或 stopping（规格 4.9 行 426）
export function sweepExpiredLeases(tx: Tx, secret: string, params: { now: string; leaseTtlMs: number; skipNodeRunIds?: ReadonlySet<string>; clock?: ClockProvider; unknownWatchdogMs?: number }): string[] {
  const rows = tx.all<NodeRunRow>(
    'SELECT * FROM node_runs WHERE status IN (?, ?) AND lease_expires_at IS NOT NULL',
    ['dispatched', 'started'],
  )
  const touched: string[] = []
  for (const row of rows) {
    if (params.skipNodeRunIds?.has(row.node_run_id)) continue
    if (!row.lease_expires_at) continue
    if (Date.parse(row.lease_expires_at) > Date.parse(params.now)) continue
    // 跑过启动的先转 startup_unknown，没跑过的转 stopping，两边都要留痕
    const next = row.status === 'started' ? 'startup_unknown' : 'stopping'
    // startup_unknown 的 watchdog 也落 boot/mono 锚点：恢复后只看单调钟，不看墙钟
    const watchdog = next === 'startup_unknown' && params.clock
      ? deadlineFromSample(params.clock, params.unknownWatchdogMs ?? 120_000)
      : null
    try {
      applyTransition(tx, secret, {
        nodeRunId: row.node_run_id,
        from: [row.status as 'dispatched' | 'started'],
        to: next,
        attempt: row.attempt,
        now: params.now,
        context: { hasToolCall: false, cancelResult: 'unknown', hangReason: null, sideEffectVerifiedNone: false },
        patch: {
          lease_id: null,
          lease_expires_at: null,
          ...(watchdog
            ? {
                startup_unknown_deadline_at: new Date(watchdog.wallClockMs).toISOString(),
                startup_unknown_boot_id: watchdog.bootId,
                startup_unknown_monotonic_ns: watchdog.monotonicNs,
                // 单位是纳秒（与 node-state.ts 一致）：ms 直接入列会让 clock-recovery 误判 0.12ms 到期（S2 r65 P1-1）
                startup_unknown_remaining_ns: Math.round((params.unknownWatchdogMs ?? 120_000) * 1e6),
              }
            : {}),
        },
      })
    } catch {
      // 并发扫描已经处理过这一行：跳过，不把整批扫描拖垮
      continue
    }
    appendNodeRunEvent(tx, secret, row.node_run_id, 'lease_expired', {
      from: row.status,
      to: next,
      lease_expires_at: row.lease_expires_at,
      reason: 'lease_expired',
    })
    touched.push(row.node_run_id)
  }
  return touched
}
