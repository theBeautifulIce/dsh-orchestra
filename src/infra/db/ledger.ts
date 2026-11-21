// 账本唯一写入口：events 追加 + node_run_events 链追加、读取与校验（服务内部用，桥与面板不许直连）
import { type Tx } from '../sqlite/driver.ts'
import { chainHash, ZERO_HASH, verifyChain, type ChainBreak, type ChainRow } from '../../core/hash-chain.ts'
import { OrchError } from '../../core/errors.ts'
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

export type ChainPosition = Pick<ChainHead, 'last_seq' | 'last_hash' | 'event_count'>

export function appendNodeRunEvent(tx: Tx, secret: string, nodeRunIdValue: string, type: string, payload: unknown): { seq: number; hash: string } {
  const head = tx.get<{ last_seq: number; last_hash: string; event_count: number }>(
    'SELECT last_seq, last_hash, event_count FROM node_run_chain_heads WHERE node_run_id = ?', [nodeRunIdValue])
  const last = tx.get<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM node_run_events WHERE node_run_id = ? ORDER BY seq DESC LIMIT 1', [nodeRunIdValue])
  // 链头是「这条链记到哪了」的权威：序号与上一条哈希都从链头取。
  // 这样链被截断过之后再追加，序号不会倒退、缺口也不会被新事件盖住。
  // 链头没有但账本里已经有事件：这是被删过链头的坏账，不能再凭事件行猜着往下写，
  // 否则链头缺失会被新事件顺手补上，verifyLedger 的缺口就永远查不出来。
  if (!head && last) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '链头缺失但账本里已有事件，不能继续追加', {
      node_run_id: nodeRunIdValue,
      last_seq: last.seq,
    })
  }
  const seq = head ? head.last_seq + 1 : 1
  const prev = head ? head.last_hash : ZERO_HASH
  // 计数在落库前取：插完再数就把新事件算两遍了；新链从 1 开始
  const eventCount = head ? head.event_count + 1 : 1
  // 哈希算在落库后的 payload 文本上：校验端拿到的是字符串，两边必须同一份材料（规格 12.1 I2）
  const payloadText = JSON.stringify(payload)
  const body = { node_run_id: nodeRunIdValue, seq, type, payload: payloadText }
  const hash = chainHash(secret, prev, body)
  const now = new Date().toISOString()
  tx.run('INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nodeRunIdValue, seq, type, prev, hash, payloadText, now])
  // 链头与事件同一笔事务落：链头落后于事件，校验端就会报缺口。
  // 新增与推进分开写：SQLite 的 UPSERT 在冲突时也会先触发 BEFORE INSERT，
  // 会被「新链头必须恰好对应首条事件」误拦，所以这里按有无链头走 INSERT / UPDATE。
  if (head) {
    tx.run(
      'UPDATE node_run_chain_heads SET last_seq = ?, last_hash = ?, event_count = ?, updated_at = ? WHERE node_run_id = ?',
      [seq, hash, eventCount, now, nodeRunIdValue])
  } else {
    tx.run(
      'INSERT INTO node_run_chain_heads (node_run_id, last_seq, last_hash, event_count, updated_at) VALUES (?, ?, ?, ?, ?)',
      [nodeRunIdValue, seq, hash, eventCount, now])
  }
  return { seq, hash }
}

export function readChain(tx: Pick<Tx, 'all'>, nodeRunIdValue: string): ChainRow[] {
  return tx.all<ChainRow>('SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC', [nodeRunIdValue])
}

// 读链头：校验端与排障用
export function readChainHead(tx: Pick<Tx, 'get'>, nodeRunIdValue: string): ChainHead | undefined {
  return tx.get<ChainHead>('SELECT node_run_id, last_seq, last_hash, event_count, updated_at FROM node_run_chain_heads WHERE node_run_id = ?', [nodeRunIdValue])
}

export function chainBreakOf(secret: string, rows: ChainRow[]): ChainBreak | null {
  return verifyChain(secret, rows)
}

export function chainIsIntact(secret: string, rows: ChainRow[], head: ChainPosition | undefined, needsEvents = false): boolean {
  const tail = rows.at(-1)
  if (!tail) return !needsEvents && !head
  return !!head && head.event_count === rows.length && head.last_seq === tail.seq
    && head.last_hash === tail.hash && !chainBreakOf(secret, rows)
}

/**
 * 断链闸门：任何要往这条链上追加事件的入口都先验链。
 * 链断就是账本已经被改过，继续写只会把断链事实洗掉（S3 r19 P1-1 / S2 r68 P1-1）。
 */
export function assertChainIntact(tx: Tx, secret: string, nodeRunIdValue: string): void {
  const brk = verifyChain(secret, readChain(tx, nodeRunIdValue))
  if (brk) {
    throw new OrchError('FORBIDDEN', '节点哈希链已断，拒绝写入，等人工核账', {
      nodeRunId: nodeRunIdValue,
      reason: 'chain_broken',
      seq: brk.seq,
      detail: brk.reason,
    })
  }
}
