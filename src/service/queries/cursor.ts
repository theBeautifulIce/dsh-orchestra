// 不透明游标：v/kind/filter_hash/last_key/last_id/as_of_seq/issued_at；10 分钟过期（规格 8.3 行 638）
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { OrchError } from '../../core/errors.ts'

export type Cursor = {
  v: 1
  kind: string
  filter_hash: string
  last_key: string
  last_id: string
  as_of_seq: number
  issued_at: number
}

export const CURSOR_TTL_MS = 10 * 60 * 1000

export function encodeCursor(c: Cursor): string {
  return Buffer.from(canonicalJson(c), 'utf8').toString('base64url')
}

export function makeCursor(kind: string, filter: unknown, lastKey: string, lastId: string, asOfSeq: number, now = Date.now()): Cursor {
  return { v: 1, kind, filter_hash: sha256Hex(canonicalJson(filter)), last_key: lastKey, last_id: lastId, as_of_seq: asOfSeq, issued_at: now }
}

export function decodeCursor(raw: string, kind: string, filter: unknown, now = Date.now()): Cursor {
  let c: Cursor
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
  } catch {
    throw new OrchError('CURSOR_EXPIRED', '游标解不开', { raw })
  }
  if (c.v !== 1) throw new OrchError('PROTOCOL_VERSION_MISMATCH', '游标版本不认识', { v: c.v })
  if (c.kind !== kind) throw new OrchError('CURSOR_FILTER_MISMATCH', '游标与当前查询不是一个种类', { kind, got: c.kind })
  if (sha256Hex(canonicalJson(filter)) !== c.filter_hash) {
    throw new OrchError('CURSOR_FILTER_MISMATCH', '过滤条件变了，游标要重来', { kind })
  }
  if (now - c.issued_at > CURSOR_TTL_MS) {
    throw new OrchError('CURSOR_EXPIRED', '游标过期了', { kind })
  }
  return c
}
