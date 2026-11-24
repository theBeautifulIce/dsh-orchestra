import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifactContent } from './queries/artifacts.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'

export type ChatTextPreview = { title: string; text: string; file_name: string; truncated: boolean }

export function readChatTextPreviews(db: Db, runId: string, checks: readonly RunDeliveryCheck[], now = Date.now()) {
  let remaining = 2400
  const previews: ChatTextPreview[] = []
  for (const check of checks.filter((c) => c.kind === 'chat/text_result' && c.outcome === 'passed')
    .sort((a, b) => (a.item_index ?? 0) - (b.item_index ?? 0))) {
    if (!check.artifact_id || !check.sha256 || !check.file_name) continue
    try {
      const { item } = getArtifactContent(db, runId, check.artifact_id, 'preview', now)
      if (item.kind !== 'preview' || item.sha256 !== check.sha256 || item.file_name !== check.file_name) continue
      const chars = Array.from(item.text)
      const visible = chars.slice(0, Math.min(1000, remaining))
      remaining -= visible.length
      previews.push({ title: check.title ?? '会话正文', file_name: item.file_name, text: visible.join(''),
        truncated: item.truncated || visible.length < chars.length })
    } catch { /* Expired or unreadable versions stay out of chat. */ }
  }
  return previews
}
