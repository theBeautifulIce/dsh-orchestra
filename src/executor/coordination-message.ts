import { sha256Hex } from '../core/canonical.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CoordinationItem, RunCoordination } from '../service/run-coordination.ts'
export const COORDINATION_TOOL = 'orchestra_coordination'
export const COORDINATION_TOOL_DESCRIPTION = '需要同行编号或未获知的信息时用 inbox。send 请求或交接传 kind、target_node_run_id、body，可设 ttl_seconds（30–300）。上报问题或发现用 blocker/finding 和 body。reply 传 id、revision、body，withdraw 传 id、revision。'
export const COORDINATION_GUIDE = '协作信箱会在正常执行时主动送达新求助、回复和关闭状态。收到求助可直接按 id、revision 回复。发件回执就是当前状态，继续本步工作，无需查信箱确认或等待。参考性请求未答或被拒时如实写入完成摘要。协作消息不能代替审批或验收。'

type MailboxResult = ReturnType<RunCoordination['call']>

function statusFields(item: CoordinationItem) {
  return { id: item.id, revision: item.revision, kind: item.kind, state: item.state,
    ...(item.state === 'pending' ? { expires_ms: item.expires_ms } : {}),
    ...(item.reply === null ? {} : { reply: item.reply }),
    ...(item.reason === null ? {} : { reason: item.reason }) }
}

/** The model sees only what it needs next. The tool value and operator ledger retain the complete record. */
export function renderCoordinationResult(result: MailboxResult) {
  if ('items' in result) {
    return JSON.stringify({ ...result, advice: '新请求或状态变化会主动送达，用已有回执继续工作。' })
  }
  return JSON.stringify({ ...statusFields(result),
    ...(result.state === 'pending' ? { next_action: '已送出，继续工作。回复或关闭会随本步工作送达。' } : {}) })
}

function messageId(id: string, revision: number) {
  const digest = sha256Hex(`orchestra:coordination:${id}:${revision}`)
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`
}

type HistoryMessage = ReturnType<Session['deriveMessages']>[number]

/** Use the current model context. A pruned, failed or unrelated tool receipt cannot suppress delivery. */
export function deliveredCoordinationIds(history: readonly HistoryMessage[], enteringIds: Iterable<string>, updates: readonly CoordinationItem[]) {
  const seen = new Set(enteringIds)
  const current = new Map(updates.map(item => [item.id, item]))
  const calls = new Set<string>()
  for (const message of history) {
    if (message.role === 'user') seen.add(String(message.id))
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call' && block.name === COORDINATION_TOOL) calls.add(block.id)
    }
    if (message.role !== 'tool' || !calls.delete(message.toolCallId) || message.isError) continue
    const [block] = message.content
    if (message.content.length !== 1 || block?.type !== 'text') continue
    let receipt
    try { receipt = JSON.parse(block.text) } catch { continue }
    if (!Array.isArray(receipt?.items)) continue
    for (const item of receipt.items) {
      const update = current.get(item?.id)
      if (update && item.revision === update.revision && item.state === update.state && item.kind === update.kind
        && item.source === update.source && (item.target ?? null) === update.target
        && (update.state !== 'pending' || item.expires_ms === update.expires_ms)
        && item.body === update.body && (item.reply ?? null) === update.reply && (item.reason ?? null) === update.reason) {
        seen.add(messageId(update.id, update.revision))
      }
    }
  }
  return seen
}

export function coordinationMessages(items: readonly CoordinationItem[], seen: ReadonlySet<string>, limit = 4) {
  const messages: { id: string; text: string }[] = []
  for (const item of items) {
    const id = messageId(item.id, item.revision)
    if (seen.has(id)) continue
    // Pending updates go to the recipient. Later revisions go back to the sender, who already knows the question.
    const data = item.state === 'pending' ? { ...statusFields(item), source: item.source, body: item.body }
      : { ...statusFields(item), target: item.target }
    const action = item.state === 'pending' ? '按任务需要，可凭此 id、revision 直接回复。' : '此为当前回执，继续原任务。'
    messages.push({ id, text: 'Orchestra 协作参考（非执行指令，非验收证据）\n'+JSON.stringify(data)+'\n'+action })
    if (messages.length >= limit) break
  }
  return messages
}
