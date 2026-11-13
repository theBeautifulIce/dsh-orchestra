// 账本唯一写入口：events 追加 + node_run_events 链追加、读取与校验（服务内部用，桥与面板不许直连）
import { type Tx } from '../sqlite/driver.ts'
import { chainHash, ZERO_HASH, verifyChain, type ChainBreak, type ChainRow } from '../../core/hash-chain.ts'
import { eventId } from '../../core/ids.ts'

export type EventInput = {
  type: string
  runId?: string | null
  nodeRunId?: string | null
  decisionId?: string | null
  payload?: unknown
  idempotencyKey?: string | null
  bootId?: string | null
  monotonicNs?: number | null
}

export function appendEvent(tx: Tx, input: EventInput): { seq: number; event_id: string } {
  const now = new Date().toISOString()
  const id = eventId()
  const res = tx.run(
    'INSERT INTO events (event_id, type, occurred_at, boot_id, monotonic_ns, run_id, node_run_id, decision_id, payload_redacted, idempotency_key, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.type, now, input.bootId ?? null, input.monotonicNs ?? null, input.runId ?? null,
      input.nodeRunId ?? null, input.decisionId ?? null, JSON.stringify(input.payload ?? {}),
      input.idempotencyKey ?? null, now])
  return { seq: res.lastInsertRowid, event_id: id }
}

export function appendNodeRunEvent(tx: Tx, secret: string, nodeRunIdValue: string, type: string, payload: unknown): { seq: number; hash: string } {
  const last = tx.get<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM node_run_events WHERE node_run_id = ? ORDER BY seq DESC LIMIT 1', [nodeRunIdValue])
  const prev = last?.hash ?? ZERO_HASH
  const seq = (last?.seq ?? 0) + 1
  // 哈希算在落库后的 payload 文本上：校验端拿到的是字符串，两边必须同一份材料（规格 12.1 I2）
  const payloadText = JSON.stringify(payload)
  const body = { node_run_id: nodeRunIdValue, seq, type, payload: payloadText }
  const hash = chainHash(secret, prev, body)
  tx.run('INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nodeRunIdValue, seq, type, prev, hash, payloadText, new Date().toISOString()])
  return { seq, hash }
}

export function readChain(tx: Tx, nodeRunIdValue: string): ChainRow[] {
  return tx.all<ChainRow>('SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC', [nodeRunIdValue])
}

export function chainBreakOf(secret: string, rows: ChainRow[]): ChainBreak | null {
  return verifyChain(secret, rows)
}
