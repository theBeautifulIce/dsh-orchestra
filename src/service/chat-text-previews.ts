import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifactContent } from './queries/artifacts.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'
import { withReadTx } from './queries/read-tx.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'
import { readBoundText } from './text-result.ts'

export type ChatTextPreview = { title: string; text: string; file_name: string; truncated: boolean; artifact_id: string; sha256: string }

export function readChatTextPreviews(db: Db, runId: string, checks: readonly RunDeliveryCheck[], now = Date.now()) {
  const accepted = checks.filter(c => c.kind === 'chat/text_result' && c.outcome === 'passed')
    .sort((a, b) => (a.item_index ?? 0) - (b.item_index ?? 0))
  return previewPublications(db, runId, accepted, now)
}

/** A blocked run may already have finished siblings. Only show their current, plan-bound publications. */
export function readCompletedChatTextPreviews(db: Db, runId: string, now = Date.now()) {
  const publications = withReadTx(db, ({ tx }) => {
    const plan = readApprovedTaskPlanForRun(tx, runId)
    if (!plan) return []
    const completed = new Set(tx.all<{ node_run_id: string }>(
      "SELECT node_run_id FROM node_runs WHERE run_id=? AND status='done' AND replacement_node_run_id IS NULL", [runId],
    ).map(row => row.node_run_id))
    const at = new Date(now).toISOString()
    return plan.proposal.deliverables.flatMap((item, index) => {
      if (item.acceptance.kind !== 'chat/text_result') return []
      const file = readBoundText(tx, runId, item.node_id, plan.plan_id, plan.content_hash, index, at)
      return file && completed.has(file.node_run_id) ? [{ title: item.title, ...file }] : []
    })
  })
  return previewPublications(db, runId, publications, now)
}

function previewPublications(db: Db, runId: string, publications: Pick<RunDeliveryCheck, 'title' | 'artifact_id' | 'sha256' | 'file_name'>[], now: number) {
  let remaining = 2400
  const previews: ChatTextPreview[] = []
  for (const [index, check] of publications.entries()) {
    if (!check.artifact_id || !check.sha256 || !check.file_name) continue
    try {
      const { item } = getArtifactContent(db, runId, check.artifact_id, 'preview', now)
      if (item.kind !== 'preview' || item.sha256 !== check.sha256 || item.file_name !== check.file_name) continue
      const chars = Array.from(item.text)
      // Reserve a share for every later deliverable. Earlier branch summaries
      // must not exhaust the budget and erase the final joined result.
      const visible = chars.slice(0, Math.floor(remaining / (publications.length - index)))
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
  const accepted = checks.find(check => check.kind === 'chat/text_result' && check.outcome === 'passed'
    && check.artifact_id === artifactId)
  return getArtifactContent(db, runId, artifactId, 'preview', now, accepted?.sha256 && accepted.file_name
    ? { sha256: accepted.sha256, file_name: accepted.file_name } : undefined).item
}
