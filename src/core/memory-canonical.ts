import { Buffer } from 'node:buffer'
import { canonicalJson, sha256Hex } from './canonical.ts'
import { OrchError } from './errors.ts'

export type MemoryItemInput = {
  client_key: string
  action: 'create' | 'update'
  target_id: string | null
  layer: 'L2' | 'L4' | 'L5' | 'L6'
  title: string
  content: string
  tags: string[]
  questions: string[]
  key: string | null
  importance: number | null
  ttl_days: number | null
  quote: string
  reason: string
}

export const MEMORY_LIMITS = {
  items: 20,
  itemBytes: 64 * 1024,
  batchBytes: 256 * 1024,
  titleMin: 1,
  titleMax: 120,
  quoteMin: 1,
  quoteMax: 1000,
  reasonMin: 1,
  reasonMax: 500,
  questions: 4,
  tags: 12,
} as const

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!)
  const b = Array.from(right, (char) => char.codePointAt(0)!)
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

export function canonicalItem(item: MemoryItemInput): Record<string, unknown> {
  return {
    client_key: item.client_key,
    action: item.action,
    target_id: item.target_id,
    layer: item.layer,
    title: item.title,
    content: item.content,
    tags: [...new Set(item.tags)].sort(compareCodePoints),
    questions: [...item.questions],
    key: item.key,
    importance: item.importance,
    ttl_days: item.ttl_days,
    quote: item.quote,
    reason: item.reason,
  }
}

export function canonicalProposal(items: readonly MemoryItemInput[]): Array<Record<string, unknown>> {
  return [...items]
    .sort((a, b) => a.client_key < b.client_key ? -1 : a.client_key > b.client_key ? 1 : 0)
    .map(canonicalItem)
}

export function contentHash(item: MemoryItemInput): string {
  return sha256Hex(canonicalJson(canonicalItem(item)))
}

export function proposalHash(items: readonly MemoryItemInput[]): string {
  return sha256Hex(canonicalJson(canonicalProposal(items)))
}

function textLength(value: string): number { return Array.from(value).length }

export function assertProposalSize(items: readonly MemoryItemInput[]): void {
  if (items.length > MEMORY_LIMITS.items) {
    throw new OrchError('MEMORY_BATCH_TOO_LARGE', `一次最多整理 ${MEMORY_LIMITS.items} 条`, { limit: MEMORY_LIMITS.items })
  }
  let totalBytes = 0
  for (const item of items) {
    const bytes = Buffer.byteLength(item.content, 'utf8')
    if (bytes > MEMORY_LIMITS.itemBytes) {
      throw new OrchError('MEMORY_BATCH_TOO_LARGE', '有一条内容太长', { limit_bytes: MEMORY_LIMITS.itemBytes })
    }
    totalBytes += bytes
  }
  if (totalBytes > MEMORY_LIMITS.batchBytes) {
    throw new OrchError('MEMORY_BATCH_TOO_LARGE', '这一批内容加起来太长', { limit_bytes: MEMORY_LIMITS.batchBytes })
  }
}

export function assertProposal(items: readonly MemoryItemInput[]): void {
  assertProposalSize(items)
  const clientKeys = new Set<string>()
  for (const item of items) {
    const invalid = (condition: boolean, field: string, message: string): void => {
      if (condition) throw new OrchError('MEMORY_PROPOSAL_INVALID', message, { client_key: item.client_key, field })
    }
    invalid(!/^[a-z0-9_-]{1,64}$/.test(item.client_key), 'client_key', 'client_key 格式不合法')
    invalid(clientKeys.has(item.client_key), 'client_key', 'client_key 不能重复')
    clientKeys.add(item.client_key)
    invalid(!['create', 'update'].includes(item.action), 'action', '提议动作只能是 create 或 update')
    invalid(item.action === 'create' ? item.target_id !== null : !item.target_id?.trim(), 'target_id', 'target_id 与提议动作不匹配')
    invalid(!['L2', 'L4', 'L5', 'L6'].includes(item.layer), 'layer', '记忆层级不允许写入')
    invalid(textLength(item.title.trim()) < MEMORY_LIMITS.titleMin || textLength(item.title) > MEMORY_LIMITS.titleMax, 'title', '标题长度必须为 1–120 字')
    invalid(textLength(item.quote.trim()) < MEMORY_LIMITS.quoteMin || textLength(item.quote) > MEMORY_LIMITS.quoteMax, 'quote', '来源引文长度必须为 1–1000 字')
    invalid(textLength(item.reason.trim()) < MEMORY_LIMITS.reasonMin || textLength(item.reason) > MEMORY_LIMITS.reasonMax, 'reason', '提议理由长度必须为 1–500 字')
    invalid(item.questions.length > MEMORY_LIMITS.questions, 'questions', '问题最多 4 条')
    invalid(item.tags.length > MEMORY_LIMITS.tags, 'tags', '标签最多 12 个')
    invalid(!item.tags.every((tag) => typeof tag === 'string'), 'tags', '标签必须是字符串')
    invalid(!item.questions.every((question) => typeof question === 'string'), 'questions', '问题必须是字符串')
    invalid(item.importance !== null && (!Number.isInteger(item.importance) || item.importance < 1 || item.importance > 10), 'importance', '重要度必须是 1–10 的整数')
    invalid(item.ttl_days !== null && (!Number.isInteger(item.ttl_days) || item.ttl_days < 1), 'ttl_days', 'ttl_days 必须是正整数')
  }
}
