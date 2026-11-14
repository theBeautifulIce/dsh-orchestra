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
  ackSeq: number
}

type CursorRow = { last_persisted_ack_seq: number }
type ReceiptRow = { payload_hash: string; ledger_seq: number }

export class BridgeLedger {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly key: BridgeLedgerKey,
  ) {}

  // 重启后唯一可信的恢复点；没有记录就是 0
  cursor(): number {
    const row = this.db.raw.prepare(
      'SELECT last_persisted_ack_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get(this.key.nodeRunId, this.key.attempt, this.key.executorAgentId) as CursorRow | undefined
    return Number(row?.last_persisted_ack_seq ?? 0)
  }

  // 只接收连续序号；同 seq 同 payload 幂等，不同 payload 直接协议冲突
  ingest(ev: BridgeEvent): BridgeIngestResult {
    if (!BRIDGE_EVENT_TYPES.includes(ev.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件类型不在固定清单里', { type: ev.type })
    }
    if (!Number.isInteger(ev.seq) || ev.seq < 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号必须是正整数', { seq: ev.seq })
    }
    const payloadHash = sha256Hex(canonicalJson(ev))
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
        return { appended: false, ledgerSeq: Number(receipt.ledger_seq), ackSeq }
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
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, ev.seq, ev.type, payloadHash, appended.seq, now],
      )
      tx.run(
        'INSERT INTO bridge_stream_cursors (node_run_id, attempt, executor_agent_id, last_persisted_ack_seq, updated_at) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT(node_run_id, attempt, executor_agent_id) DO UPDATE SET last_persisted_ack_seq = excluded.last_persisted_ack_seq, updated_at = excluded.updated_at',
        [this.key.nodeRunId, this.key.attempt, this.key.executorAgentId, ev.seq, now],
      )
      return { appended: true, ledgerSeq: appended.seq, ackSeq: ev.seq }
    })
  }
}
