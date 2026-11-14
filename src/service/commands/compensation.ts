// src/service/commands/compensation.ts —— 补偿幂等执行与未验证副作用落账（S3 Task 11，规格 4.7）
import { OrchError } from '../../core/errors.ts'
import { canonicalJson, compensationId, sha256Hex } from '../../core/canonical.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { applyTransition } from './nodes.ts'

export type CompensationState = 'running' | 'applied' | 'failed' | 'unverified' | 'skipped'

export type CompensationDescriptor = {
  tool: string
  args: readonly string[]
  verify: { command: string; args: readonly string[] }
  descriptorVersion: string
}

export type CompensationRow = {
  compensation_id: string | null
  node_run_id: string
  attempt: number
  kind: 'executable' | 'none'
  tool: string
  args_hash: string
  descriptor_version: string
  state: CompensationState
  evidence_json: string | null
  created_at: string
  updated_at: string
}

const UNVERIFIED_FROM = [
  'verifying',
  'stopping',
  'failed',
  'timeout',
  'indeterminate_side_effect',
  'abandoned_unverified',
] as const

/** 补偿描述符必须真的能执行：工具名、验证命令、描述符版本都不能为空。 */
export function assertCompensationDescriptor(descriptor: CompensationDescriptor): void {
  if (descriptor.tool.trim() === '' || descriptor.verify.command.trim() === '') {
    throw new OrchError('COMPENSATION_UNEXECUTABLE', '补偿描述符缺工具或验证命令，不能执行', {
      tool: descriptor.tool,
      verify: descriptor.verify.command,
    })
  }
  if (descriptor.descriptorVersion.trim() === '') {
    throw new OrchError('COMPENSATION_UNEXECUTABLE', '补偿描述符缺 descriptorVersion，无法幂等', {})
  }
  if (!Array.isArray(descriptor.args) || !Array.isArray(descriptor.verify.args)) {
    throw new OrchError('COMPENSATION_UNEXECUTABLE', '补偿参数必须是字符串数组', {})
  }
  if (!descriptor.args.every((a) => typeof a === 'string') || !descriptor.verify.args.every((a) => typeof a === 'string')) {
    throw new OrchError('COMPENSATION_UNEXECUTABLE', '补偿参数必须是字符串数组', {})
  }
}

export function getCompensation(tx: Tx, id: string): CompensationRow | undefined {
  return tx.get<CompensationRow>(
    'SELECT compensation_id, node_run_id, attempt, kind, tool, args_hash, descriptor_version, state, evidence_json, created_at, updated_at FROM compensations WHERE compensation_id = ?',
    [id],
  )
}

/**
 * 幂等开始一次补偿：同一 (node_run_id, attempt, descriptorVersion) 只会插入一行、发一条 started。
 * 返回 true 表示这次真的拿到了执行权。
 */
export function startCompensation(
  tx: Tx,
  secret: string,
  args: { nodeRunId: string; attempt: number; descriptor: CompensationDescriptor; now: string },
): { compensationId: string; started: boolean } {
  assertCompensationDescriptor(args.descriptor)
  const id = compensationId(args.nodeRunId, args.attempt, args.descriptor.descriptorVersion)
  const argsHash = sha256Hex(canonicalJson({
    tool: args.descriptor.tool,
    args: args.descriptor.args,
    verify: args.descriptor.verify,
  }))
  const inserted = tx.run(
    'INSERT INTO compensations (compensation_id, node_run_id, attempt, kind, tool, args_hash, descriptor_version, state, created_at, updated_at) '
      + "VALUES (?, ?, ?, 'executable', ?, ?, ?, 'running', ?, ?) ON CONFLICT DO NOTHING",
    [id, args.nodeRunId, args.attempt, args.descriptor.tool, argsHash, args.descriptor.descriptorVersion, args.now, args.now],
  )
  if (inserted.changes !== 1) {
    const existing = getCompensation(tx, id)
    if (!existing) {
      throw new OrchError('OPERATION_ID_CONFLICT', '补偿幂等键冲突但找不到原记录', { compensationId: id })
    }
    if (existing.node_run_id !== args.nodeRunId || existing.attempt !== args.attempt) {
      throw new OrchError('OPERATION_ID_CONFLICT', '补偿幂等键被别的节点占用', { compensationId: id })
    }
    if (existing.tool !== args.descriptor.tool || existing.args_hash !== argsHash) {
      throw new OrchError('OPERATION_ID_CONFLICT', '同一补偿描述符版本换了工具或参数', { compensationId: id })
    }
    return { compensationId: id, started: false }
  }
  appendNodeRunEvent(tx, secret, args.nodeRunId, 'compensation.started', {
    compensation_id: id,
    attempt: args.attempt,
    tool: args.descriptor.tool,
    descriptor_version: args.descriptor.descriptorVersion,
  })
  return { compensationId: id, started: true }
}

function markUnverified(tx: Tx, secret: string, nodeRunId: string, attempt: number, now: string, reason: string): void {
  const node = tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', [nodeRunId])
  if (!node) throw new OrchError('STALE_GENERATION', '补偿节点不存在', { nodeRunId })
  if (node.status === 'failed_with_unverified') return
  if (!(UNVERIFIED_FROM as readonly string[]).includes(node.status)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '当前节点状态不能落 failed_with_unverified', {
      nodeRunId,
      status: node.status,
    })
  }
  applyTransition(tx, {
    nodeRunId,
    from: UNVERIFIED_FROM,
    to: 'failed_with_unverified',
    attempt,
    now,
  })
  appendNodeRunEvent(tx, secret, nodeRunId, 'status_changed', {
    from: node.status,
    to: 'failed_with_unverified',
    attempt,
    reason,
  })
}

/**
 * 收口一次补偿：applied 保留节点原状态；failed/unverified 必须落 failed_with_unverified，
 * attempt 与 Gr 都不变（规格 4.7；M-54/M-55）。
 */
export function settleCompensation(
  tx: Tx,
  secret: string,
  args: { compensationId: string; state: 'applied' | 'failed' | 'unverified'; evidence?: unknown; now: string; reason?: string },
): boolean {
  const row = getCompensation(tx, args.compensationId)
  if (!row) throw new OrchError('COMPENSATION_UNEXECUTABLE', '补偿记录不存在', { compensationId: args.compensationId })
  if (row.state === args.state) return false
  if (row.state !== 'running') {
    throw new OrchError('OPERATION_ID_CONFLICT', '补偿已经收口，不能改成另一个终态', {
      compensationId: args.compensationId,
      state: row.state,
      requested: args.state,
    })
  }
  const evidenceJson = args.evidence === undefined ? null : canonicalJson(args.evidence)
  const res = tx.run(
    "UPDATE compensations SET state = ?, evidence_json = ?, updated_at = ? WHERE compensation_id = ? AND state = 'running'",
    [args.state, evidenceJson, args.now, args.compensationId],
  )
  if (res.changes !== 1) {
    throw new OrchError('STALE_GENERATION', '补偿收口 CAS 未命中', { compensationId: args.compensationId })
  }
  const type = args.state === 'applied' ? 'compensation.applied' : 'compensation.failed'
  appendNodeRunEvent(tx, secret, row.node_run_id, type, {
    compensation_id: args.compensationId,
    attempt: row.attempt,
    state: args.state,
    evidence: args.evidence ?? null,
    reason: args.reason ?? null,
  })
  if (args.state !== 'applied') {
    markUnverified(tx, secret, row.node_run_id, row.attempt, args.now, args.reason ?? `compensation_${args.state}`)
  }
  return true
}

/**
 * 没有可执行补偿时的幂等落账：compensation_id 为 NULL，用 (node_run_id, attempt) 唯一标记，
 * 并把节点落 failed_with_unverified，不许落普通 failed。
 */
export function registerNoExecutableCompensation(
  tx: Tx,
  secret: string,
  args: { nodeRunId: string; attempt: number; now: string },
): { created: boolean } {
  const inserted = tx.run(
    "INSERT INTO compensations (compensation_id, node_run_id, attempt, kind, tool, args_hash, descriptor_version, state, created_at, updated_at) "
      + "VALUES (NULL, ?, ?, 'none', '', '', 'no_executable_compensation', 'skipped', ?, ?) "
      + "ON CONFLICT DO NOTHING",
    [args.nodeRunId, args.attempt, args.now, args.now],
  )
  const created = inserted.changes === 1
  if (created) {
    appendNodeRunEvent(tx, secret, args.nodeRunId, 'compensation.failed', {
      compensation_id: null,
      attempt: args.attempt,
      state: 'unverified',
      reason: 'no_executable_compensation',
    })
  }
  markUnverified(tx, secret, args.nodeRunId, args.attempt, args.now, 'no_executable_compensation')
  return { created }
}
