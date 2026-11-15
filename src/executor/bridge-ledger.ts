// R5-B：桥事件落到 node_run_events 的唯一入口。
// 事件、receipt、持久确认游标必须在同一笔事务里提交；提交成功才算本地 ACK。
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError, proposedError } from '../core/errors.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { BRIDGE_EVENT_TYPES, type BridgeEvent } from './bridge.ts'

export type BridgeLedgerKey = {
  nodeRunId: string
  attempt: number
  executorAgentId: string
}

export type BridgeIngestResult = {
  appended: boolean
  ledgerSeq: number | null
  // 本次事件在桥上的序号：消费器只按它推进处理位
  eventSeq: number
  // 当前已落账位：只用于观测，绝不拿来当处理位
  persistedCursor: number
}

type CursorRow = { last_persisted_ack_seq: number }
type HandledRow = { last_persisted_ack_seq: number; last_handled_seq: number }
type ReceiptRow = { payload_hash: string; ledger_seq: number }

export class BridgeLedger {
  private readonly db: Db
  private readonly secret: string
  private readonly key: BridgeLedgerKey

  constructor(db: Db, secret: string, key: BridgeLedgerKey) {
    this.db = db
    this.secret = secret
    this.key = key
  }

  // 已落账位：事件、receipt、游标在同一笔事务里提交后推进。
  cursor(): number {
    const row = this.db.raw.prepare(
      'SELECT last_persisted_ack_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get(this.key.nodeRunId, this.key.attempt, this.key.executorAgentId) as CursorRow | undefined
    return Number(row?.last_persisted_ack_seq ?? 0)
  }

  // 已处理位：onEvent 返回后才推进；断线重连必须从这里重放，不能从 cursor() 重放。
  handled(): number {
    const row = this.db.raw.prepare(
      'SELECT last_handled_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get(this.key.nodeRunId, this.key.attempt, this.key.executorAgentId) as { last_handled_seq: number } | undefined
    return Number(row?.last_handled_seq ?? 0)
  }

  // 只允许逐条推进：处理位必须正好是已处理位 + 1。
  // 允许跳跃会让“漏处理一条但游标已过”成为静默事实（G3 r11 P2-2）。
  markHandled(seq: number): void {
    withTx(this.db, (tx) => {
      const row = tx.get<HandledRow>(
        'SELECT last_persisted_ack_seq, last_handled_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId],
      )
      const persisted = Number(row?.last_persisted_ack_seq ?? 0)
      const handled = Number(row?.last_handled_seq ?? 0)
      if (seq > persisted) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '处理位不能越过已落账位', { seq, persisted })
      }
      if (seq <= handled) return
      if (seq !== handled + 1) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '处理游标必须逐条推进', { seq, handled })
      }
      tx.run(
        'UPDATE bridge_stream_cursors SET last_handled_seq = ?, updated_at = ? WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
        [seq, new Date().toISOString(), this.key.nodeRunId, this.key.attempt, this.key.executorAgentId],
      )
    })
  }

  // 重启后按桥序号回查已落账事件；只认本 attempt/agent 的 receipt，旧 attempt 不串读
  lookup(seq: number): BridgeEvent | undefined {
    const row = this.db.raw.prepare(
      'SELECT e.payload AS payload FROM bridge_event_receipts r '
      + 'JOIN node_run_events e ON e.node_run_id = r.node_run_id AND e.seq = r.ledger_seq '
      + 'WHERE r.node_run_id = ? AND r.attempt = ? AND r.executor_agent_id = ? AND r.bridge_seq = ?',
    ).get(this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, seq) as { payload: string } | undefined
    if (!row) return undefined
    return JSON.parse(row.payload) as BridgeEvent
  }

  // 只接收连续序号；同 seq 同 payload 幂等，不同 payload 直接协议冲突
  ingest(ev: BridgeEvent): BridgeIngestResult {
    if (!BRIDGE_EVENT_TYPES.includes(ev.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件类型不在固定清单里', { type: ev.type })
    }
    if (!Number.isInteger(ev.seq) || ev.seq < 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号必须是正整数', { seq: ev.seq })
    }
    if (ev.attempt !== undefined && ev.attempt !== this.key.attempt) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件 attempt 与当前账本不一致', { eventAttempt: ev.attempt, ledgerAttempt: this.key.attempt })
    }
    if (ev.executorAgentId !== undefined && ev.executorAgentId !== this.key.executorAgentId) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件 executorAgentId 与当前账本不一致', { eventAgent: ev.executorAgentId, ledgerAgent: this.key.executorAgentId })
    }
    const payloadHash = sha256Hex(canonicalJson({ type: ev.type, payload: ev.payload }))
    return withTx(this.db, (tx) => {
      const cursor = tx.get<CursorRow>(
        'SELECT last_persisted_ack_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId],
      )
      const ackSeq = Number(cursor?.last_persisted_ack_seq ?? 0)
      const receipt = tx.get<ReceiptRow>(
        'SELECT payload_hash, ledger_seq FROM bridge_event_receipts WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ? AND bridge_seq = ?',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, ev.seq],
      )
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) {
          throw proposedError('BRIDGE_SEQ_CONFLICT', '同一桥序号出现了不同 payload，按协议冲突拒绝', { seq: ev.seq })
        }
        return { appended: false, ledgerSeq: Number(receipt.ledger_seq), eventSeq: ev.seq, persistedCursor: ackSeq }
      }
      if (ev.seq !== ackSeq + 1) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号不连续，先补洞再落账', {
          expected: ackSeq + 1,
          got: ev.seq,
        })
      }
      const appended = appendNodeRunEvent(tx, this.secret, this.key.nodeRunId, 'bridge.' + ev.type, ev)
      const now = new Date().toISOString()
      tx.run(
        'INSERT INTO bridge_event_receipts (node_run_id, attempt, executor_agent_id, bridge_seq, event_type, payload_hash, ledger_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, ev.seq, 'bridge.' + ev.type, payloadHash, appended.seq, now],
      )
      tx.run(
        'INSERT INTO bridge_stream_cursors (node_run_id, attempt, executor_agent_id, last_persisted_ack_seq, updated_at) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT(node_run_id, attempt, executor_agent_id) DO UPDATE SET last_persisted_ack_seq = excluded.last_persisted_ack_seq, updated_at = excluded.updated_at',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, ev.seq, now],
      )
      return { appended: true, ledgerSeq: appended.seq, eventSeq: ev.seq, persistedCursor: ev.seq }
    })
  }
}
