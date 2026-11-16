// 命令幂等与回执（规格 6.2 步骤 10、8.4；S4 计划 Task 9）
//
// 回执与业务在同一笔事务里写：先登记 running，业务成功后再改 applied 并落 receipt_json。
// 业务抛错时整笔回滚，inbox 行也不留下——调用方可以用同一个 operation_id 重试。
import { type Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import { OrchError } from '../../core/errors.ts'
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'

export type CommandReceipt = {
  operation_id: string
  kind: string
  request_hash: string
  result: unknown
}

type InboxRow = {
  operation_id: string
  kind: string
  request_hash: string
  status: string
  receipt_json: string | null
  receipt_expired_at: string | null
}

/**
 * operation_id 是全局命令身份：协议规定 UUIDv7（规格 3.7），不是示例口径。
 * 小写带连字符，版本位 7，variant 位 [89ab]。
 */
export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function assertOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V7_RE.test(value)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'operation_id 必须是 UUIDv7（小写带连字符）', {
      operation_id: typeof value === 'string' ? value : null,
    })
  }
  return value
}

/** 同一份请求算同一个哈希：canonical_json 是回执口径的唯一序列化方式 */
export const requestHashOf = (kind: string, payload: unknown): string => sha256Hex(canonicalJson({ kind, payload }))

export function runIdempotentCommand<T>(
  tx: Tx,
  p: { kind: string; operationId: string; requestHash: string; now: string },
  apply: () => T,
): { result: T; replayed: boolean } {
  const existing = tx.get<InboxRow>(
    'SELECT operation_id, kind, request_hash, status, receipt_json, receipt_expired_at FROM inbox WHERE operation_id = ?',
    [p.operationId],
  )
  if (existing) {
    if (existing.kind !== p.kind || existing.request_hash !== p.requestHash) {
      throw new OrchError('OPERATION_ID_CONFLICT', '同一个 operation_id 被用于不同的请求', {
        operation_id: p.operationId,
        registered_kind: existing.kind,
      })
    }
    // 过期判断放在回执存在性之前：sweep 清掉 receipt_json 后仍必须回 OPERATION_EXPIRED，
    // 否则会掉进下面的通用分支被误报成 OPERATION_ID_CONFLICT（审计 P2）
    if (existing.receipt_expired_at && new Date(existing.receipt_expired_at).getTime() <= new Date(p.now).getTime()) {
      throw new OrchError('OPERATION_EXPIRED', '回执已过期，请用新的 operation_id 重新发起', {
        operation_id: p.operationId,
        receipt_expired_at: existing.receipt_expired_at,
      })
    }
    if (existing.status === 'applied' && existing.receipt_json) {
      // 幂等重放：把上次的回执原样还回去，不重复产生业务副作用
      const receipt = JSON.parse(existing.receipt_json) as { result: T }
      return { result: receipt.result, replayed: true }
    }
    if (existing.status === 'running') {
      throw new OrchError('COMMAND_BUSY', '同一个 operation_id 还在处理中', { operation_id: p.operationId })
    }
    throw new OrchError('OPERATION_ID_CONFLICT', '这条命令已经以别的结果收口', {
      operation_id: p.operationId,
      status: existing.status,
    })
  }

  tx.run(
    'INSERT INTO inbox (kind, operation_id, request_hash, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [p.kind, p.operationId, p.requestHash, 'running', p.now],
  )
  const result = apply()
  const receipt: CommandReceipt = {
    operation_id: p.operationId,
    kind: p.kind,
    request_hash: p.requestHash,
    result,
  }
  tx.run(
    "UPDATE inbox SET status = 'applied', receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'running'",
    [JSON.stringify(receipt), p.now, p.operationId],
  )
  appendEvent(tx, {
    type: 'command.applied',
    payload: { operation_id: p.operationId, kind: p.kind, request_hash: p.requestHash },
  })
  return { result, replayed: false }
}
