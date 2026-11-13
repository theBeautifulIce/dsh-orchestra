// node_run 事件哈希链：hash = HMAC-SHA256(serviceSecret, prev_hash || canonical_json(event))（总纲 4.3）
import { canonicalJson, hmacSha256Hex } from './canonical.ts'

export const ZERO_HASH = '0'.repeat(64)

export function chainHash(secret: string, prevHash: string, event: unknown): string {
  return hmacSha256Hex(secret, prevHash + canonicalJson(event))
}

export type ChainRow = { node_run_id: string; seq: number; type: string; prev_hash: string; hash: string; payload: string }

export type ChainBreak = { node_run_id: string; seq: number; reason: string }

export function verifyChain(secret: string, rows: ChainRow[]): ChainBreak | null {
  let prev = ZERO_HASH
  for (const row of rows) {
    if (row.prev_hash !== prev) return { node_run_id: row.node_run_id, seq: row.seq, reason: 'prev_hash 不接上一条' }
    const expect = chainHash(secret, prev, { type: row.type, payload: row.payload, seq: row.seq, node_run_id: row.node_run_id })
    if (expect !== row.hash) return { node_run_id: row.node_run_id, seq: row.seq, reason: 'hash 对不上，内容被改过' }
    prev = row.hash
  }
  return null
}
