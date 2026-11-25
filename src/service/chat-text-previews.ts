import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifactContent } from './queries/artifacts.ts'
import type { RunDeliveryCheck } from './queries/runs.ts'
import { withReadTx } from './queries/read-tx.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'
import { textTarget } from './text-result.ts'
import { canonicalJson } from '../core/canonical.ts'
import type { ReworkBinding } from './rework-coordinator.ts'

export type ChatTextPreview = { title: string; text: string; file_name: string; truncated: boolean; artifact_id: string; sha256: string }

export function readChatTextPreviews(db: Db, runId: string, checks: readonly RunDeliveryCheck[], now = Date.now()) {
  const accepted = checks.filter(c => c.kind === 'chat/text_result' && c.outcome === 'passed')
    .sort((a, b) => (a.item_index ?? 0) - (b.item_index ?? 0))
  return previewPublications(db, runId, accepted, now)
}

/** A blocked run may already have finished siblings. Only show their current, plan-bound publications. */
export function completedChatTextRefs(db: Db, runId: string, now = Date.now()) {
  return withReadTx(db, ({ tx }) => {
    const plan = readApprovedTaskPlanForRun(tx, runId)
    if (!plan) return []
    const completed = new Map(tx.all<ReworkBinding & { node_id: string }>(
      "SELECT node_id,node_run_id,attempt,action_generation FROM node_runs WHERE run_id=? AND status='done' AND replacement_node_run_id IS NULL ORDER BY attempt,seq", [runId],
    ).map(row => [row.node_id, row]))
    return plan.proposal.deliverables.flatMap((item, index) => {
      const node = completed.get(item.node_id)
      if (!node || item.acceptance.kind !== 'chat/text_result') return []
      const target = textTarget(plan.plan_id, plan.content_hash, index, node)
      const file = tx.get<{ sha256: string }>(`SELECT a.sha256 FROM artifacts a JOIN artifact_contents c USING(artifact_id)
        WHERE a.run_id=? AND c.node_run_id=? AND a.artifact_id=? AND a.evidence_index=? AND c.file_name=?
          AND length(c.bytes) BETWEEN 1 AND 65536 AND (a.retain_until IS NULL OR julianday(a.retain_until)>julianday(?))`,
      [runId, node.node_run_id, target.artifactId, canonicalJson(target.evidenceIndex), target.fileName, new Date(now).toISOString()])
      return file ? [{ title: item.title, artifact_id: target.artifactId, file_name: target.fileName, sha256: file.sha256 }] : []
    })
  })
}

export function previewPublications(db: Db, runId: string, publications: Pick<RunDeliveryCheck, 'title' | 'artifact_id' | 'sha256' | 'file_name'>[], now = Date.now()) {
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
