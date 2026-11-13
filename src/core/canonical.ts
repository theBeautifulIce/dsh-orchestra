// canonical_json（JCS 口径）、SHA256 与 HMAC：哈希链、产物哈希、回执 request_hash 的唯一序列化口径（总纲 4.3）
import { createHash, createHmac } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical_json 不接受非有限数字')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
  }
  throw new TypeError('canonical_json 不接受这个类型: ' + typeof value)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256Hex(secret: string | Buffer, input: string | Buffer): string {
  return createHmac('sha256', secret).update(input).digest('hex')
}
