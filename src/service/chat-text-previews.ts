import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifactContent } from './queries/artifacts.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'

export type ChatTextPreview = { title: string; text: string; file_name: string; truncated: boolean; artifact_id: string; sha256: string }

export function readChatTextPreviews(db: Db, runId: string, checks: readonly RunDeliveryCheck[], now = Date.now()) {
  let remaining = 2400
  const previews: ChatTextPreview[] = []
  const accepted = checks.filter((c) => c.kind === 'chat/text_result' && c.outcome === 'passed')
    .sort((a, b) => (a.item_index ?? 0) - (b.item_index ?? 0))
  for (const [index, check] of accepted.entries()) {
    if (!check.artifact_id || !check.sha256 || !check.file_name) continue
    try {
      const { item } = getArtifactContent(db, runId, check.artifact_id, 'preview', now)
      if (item.kind !== 'preview' || item.sha256 !== check.sha256 || item.file_name !== check.file_name) continue
      const chars = Array.from(item.text)
      // Reserve a share for every later deliverable. Earlier branch summaries
      // must not exhaust the budget and erase the final joined result.
      const visible = chars.slice(0, Math.floor(remaining / (accepted.length - index)))
      remaining -= visible.length
      previews.push({ title: check.title ?? '会话正文', file_name: item.file_name, text: visible.join(''),
        artifact_id: check.artifact_id, sha256: item.sha256,
        truncated: item.truncated || visible.length < chars.length })
    } catch { /* Expired or unreadable versions stay out of chat. */ }
  }
  return previews
}

/** Published chat results are bounded at 64 KiB. Return their full verified
 * version when the generic 32 KiB file preview would truncate delivery. */
export function readChatArtifactContent(db: Db, runId: string, artifactId: string,
  checks: readonly RunDeliveryCheck[], now = Date.now()) {
  const preview = getArtifactContent(db, runId, artifactId, 'preview', now).item
  const accepted = checks.find(check => check.kind === 'chat/text_result' && check.outcome === 'passed'
    && check.artifact_id === artifactId && check.sha256 === preview.sha256 && check.file_name === preview.file_name)
  if (preview.kind !== 'preview' || !preview.truncated || !accepted || preview.size_bytes > 65536) return preview
  const full = getArtifactContent(db, runId, artifactId, 'download', now).item
  if (full.kind !== 'download' || full.sha256 !== preview.sha256) return preview
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(full.base64, 'base64'))
    if (text.includes('\0')) return preview
    return { ...preview, text, truncated: false }
  } catch { return preview }
}
