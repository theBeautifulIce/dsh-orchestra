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

// 链头投影：这条链记到第几条、链尾哈希是多少、一共几条。
// 校验端拿它跟账本里的链对账：链被截断或整条被删掉时，只看链本身看不出缺口。
export type ChainHead = {
  node_run_id: string
  last_seq: number
  last_hash: string
  event_count: number
  updated_at: string
}

export function appendNodeRunEvent(tx: Tx, secret: string, nodeRunIdValue: string, type: string, payload: unknown): { seq: number; hash: string } {
  const head = tx.get<{ last_seq: number; last_hash: string; event_count: number }>(
    'SELECT last_seq, last_hash, event_count FROM node_run_chain_heads WHERE node_run_id = ?', [nodeRunIdValue])
  const last = tx.get<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM node_run_events WHERE node_run_id = ? ORDER BY seq DESC LIMIT 1', [nodeRunIdValue])
  // 链头是「这条链记到哪了」的权威：序号与上一条哈希都从链头取。
  // 这样链被截断过之后再追加，序号不会倒退、缺口也不会被新事件盖住。
  // 链头没有（老库、或链头被人删了）就退回事件行本身，行为跟以前一样。
  const seq = head ? head.last_seq + 1 : (last?.seq ?? 0) + 1
  const prev = head ? head.last_hash : (last?.hash ?? ZERO_HASH)
  // 计数在落库前取：插完再数就把新事件算两遍了
  const eventCount = head ? head.event_count + 1 : chainRowCount(tx, nodeRunIdValue) + 1
  // 哈希算在落库后的 payload 文本上：校验端拿到的是字符串，两边必须同一份材料（规格 12.1 I2）
  const payloadText = JSON.stringify(payload)
  const body = { node_run_id: nodeRunIdValue, seq, type, payload: payloadText }
  const hash = chainHash(secret, prev, body)
  const now = new Date().toISOString()
  tx.run('INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nodeRunIdValue, seq, type, prev, hash, payloadText, now])
  // 链头与事件同一笔事务落：链头落后于事件，校验端就会报缺口
  tx.run(
    'INSERT INTO node_run_chain_heads (node_run_id, last_seq, last_hash, event_count, updated_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(node_run_id) DO UPDATE SET last_seq = excluded.last_seq, last_hash = excluded.last_hash, '
    + 'event_count = excluded.event_count, updated_at = excluded.updated_at',
    [nodeRunIdValue, seq, hash, eventCount, now])
  return { seq, hash }
}

// 链头缺失时的兜底计数：只有老库或链头被删才会走到这里
function chainRowCount(tx: Tx, nodeRunIdValue: string): number {
  const row = tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ?', [nodeRunIdValue])
  return Number(row?.n ?? 0)
}

export function readChain(tx: Tx, nodeRunIdValue: string): ChainRow[] {
  return tx.all<ChainRow>('SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC', [nodeRunIdValue])
}

// 读链头：校验端与排障用
export function readChainHead(tx: Tx, nodeRunIdValue: string): ChainHead | undefined {
  return tx.get<ChainHead>('SELECT node_run_id, last_seq, last_hash, event_count, updated_at FROM node_run_chain_heads WHERE node_run_id = ?', [nodeRunIdValue])
}

export function chainBreakOf(secret: string, rows: ChainRow[]): ChainBreak | null {
  return verifyChain(secret, rows)
}
