// src/service/commands/lease.ts —— 租约与心跳（规格 4.9 行 425-429、12.3 行 1063）
import { OrchError, proposedError } from '../../core/errors.ts'
import { uuidv7 } from '../../core/ids.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'

export type NodeRunRow = {
  node_run_id: string
  run_id: string
  node_id: string
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
export function renewLease(tx: Tx, params: { nodeRunId: string; leaseTtlMs: number; now: string }): string {
  const row = loadNodeRun(tx, params.nodeRunId)
  if (!row.lease_id) throw new OrchError('STALE_GENERATION', '节点没有租约，续期无效', { nodeRunId: params.nodeRunId })
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
export function sweepExpiredLeases(tx: Tx, secret: string, params: { now: string; leaseTtlMs: number }): string[] {
  const rows = tx.all<NodeRunRow>(
    'SELECT * FROM node_runs WHERE status IN (?, ?) AND lease_expires_at IS NOT NULL',
    ['dispatched', 'started'],
  )
  const touched: string[] = []
  for (const row of rows) {
    if (!row.lease_expires_at) continue
    if (Date.parse(row.lease_expires_at) > Date.parse(params.now)) continue
    // 跑过启动的先转 startup_unknown，没跑过的转 stopping，两边都要留痕
    const next = row.status === 'started' ? 'startup_unknown' : 'stopping'
    runCas(
      tx,
      'UPDATE node_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND revision = ?',
      [next, params.now, row.node_run_id, row.status, row.revision],
      { rows: 1, what: 'sweepExpiredLeases' },
    )
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
