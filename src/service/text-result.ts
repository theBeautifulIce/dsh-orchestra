import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { ReworkBinding } from './rework-coordinator.ts'

export const TEXT_PUBLICATION = 'orchestra.chat-text.v1'

export function textResultFileName(index: number) {
  return '会话正文-' + (index + 1) + '.md'
}

export function textTarget(planId: string, contentHash: string, index: number, binding: ReworkBinding) {
  const evidenceIndex = { kind: TEXT_PUBLICATION, plan_id: planId, plan_hash: contentHash, item_index: index,
    node_run_id: binding.node_run_id, attempt: binding.attempt, action_generation: binding.action_generation }
  return { artifactId: 'chat_' + sha256Hex(canonicalJson(evidenceIndex)), fileName: textResultFileName(index), evidenceIndex }
}

/** Resolve the current producing attempt and recheck its exact bytes. Filenames alone carry no authority. */
export function readBoundText(tx: Tx, runId: string, nodeId: string, planId: string, hash: string, index: number, now: string) {
  const node = tx.get<ReworkBinding>(`SELECT node_run_id,attempt,action_generation FROM node_runs
    WHERE run_id=? AND node_id=? AND replacement_node_run_id IS NULL ORDER BY attempt DESC,seq DESC LIMIT 1`, [runId,nodeId])
  if (!node) return null
  const target = textTarget(planId, hash, index, node)
  const item = tx.get<{ bytes: Uint8Array; sha256: string; retain_until: string | null }>(
    `SELECT c.bytes,a.sha256,a.retain_until FROM artifacts a JOIN artifact_contents c USING(artifact_id)
     WHERE a.run_id=? AND c.node_run_id=? AND a.artifact_id=? AND a.evidence_index=? AND c.file_name=?`,
    [runId,node.node_run_id,target.artifactId,canonicalJson(target.evidenceIndex),target.fileName])
  if (!item || (item.retain_until !== null && !(Date.parse(item.retain_until) > Date.parse(now)))
    || item.bytes.length > 65536 || sha256Hex(Buffer.from(item.bytes)) !== item.sha256) return null
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(item.bytes) } catch { return null }
  if (!text.trim() || text.includes('\0')) return null
  return { artifact_id: target.artifactId, file_name: target.fileName, sha256: item.sha256, bytes: item.bytes.length,
    publication: TEXT_PUBLICATION, item_index: index, node_run_id: node.node_run_id }
}
