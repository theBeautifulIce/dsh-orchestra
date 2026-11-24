import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { appendNodeRunEvent, assertChainIntact, readChain } from '../infra/db/ledger.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { NodeRunRow } from './commands/lease.ts'
import type { ReworkBinding } from './rework-coordinator.ts'
import { textTarget } from './text-result.ts'
import { approvedArtifactRequirements } from './task-planning.ts'

const publicationEvent = 'artifact.published_for_attempt'

type Publication = {
  run_id: string
  plan_id: string
  plan_hash: string
  attempt: number
  action_generation: number
  artifact_id: string
  file_name: string
  sha256: string
  size_bytes: number
}

export function matchesPublication(rule: { file_name: string; textIndex?: number }, fileName: string, id: string,
  plan: { planId: string; contentHash: string }, binding: ReworkBinding) {
  if (rule.file_name !== fileName) return false
  if (rule.textIndex === undefined) return !id.startsWith('chat_')
  return textTarget(plan.planId, plan.contentHash, rule.textIndex, binding).artifactId === id
}

export function recordArtifactPublication(tx: Tx, secret: string, binding: ReworkBinding,
  node: { run_id: string; node_id: string }, fileName: string, artifact: { artifact_id: string; sha256: string; size_bytes: number }) {
  const approved = approvedArtifactRequirements(tx, node.run_id, node.node_id)
  if (!approved || !approved.rules.some((rule) => matchesPublication(rule, fileName, artifact.artifact_id, approved, binding))) return
  assertChainIntact(tx, secret, binding.node_run_id)
  appendNodeRunEvent(tx, secret, binding.node_run_id, publicationEvent, {
    ...artifact, file_name: fileName, run_id: node.run_id, plan_id: approved.planId, plan_hash: approved.contentHash,
    attempt: binding.attempt, action_generation: binding.action_generation,
  } satisfies Publication)
}

export function verifyArtifactCompletion(tx: Tx, secret: string, row: NodeRunRow, now: string) {
  if (row.status !== 'verifying' || row.node_type !== 'agent' || row.side_effect_policy !== 'pure'
    || tx.get('SELECT 1 FROM tool_executions WHERE node_run_id=? AND attempt=? LIMIT 1', [row.node_run_id, row.attempt])) return null
  const approved = approvedArtifactRequirements(tx, row.run_id, row.node_id)
  if (!approved) return null
  assertChainIntact(tx, secret, row.node_run_id)
  const published = readChain(tx, row.node_run_id).filter((event) => event.type === publicationEvent)
    .map((event) => ({ seq: event.seq, publication: JSON.parse(event.payload) as Publication }))
  const evidence = []
  for (const rule of approved.rules) {
    const receipt = published.find(({ publication }) => publication.attempt === row.attempt
      && publication.action_generation === row.action_generation
      && matchesPublication(rule, publication.file_name, publication.artifact_id, approved, row)
      && publication.run_id === row.run_id && publication.plan_id === approved.planId && publication.plan_hash === approved.contentHash)
    if (!receipt) return null
    const { seq, publication } = receipt
    const stored = tx.get<{ sha256: string; bytes: Uint8Array; retain_until: string | null }>(
      'SELECT a.sha256,c.bytes,a.retain_until FROM artifacts a JOIN artifact_contents c USING(artifact_id)'
      + ' WHERE a.artifact_id=? AND a.run_id=? AND c.node_run_id=? AND c.file_name=?',
      [publication.artifact_id, row.run_id, row.node_run_id, rule.file_name],
    )
    if (!stored || stored.bytes.byteLength < rule.minimum_bytes || stored.bytes.byteLength !== publication.size_bytes
      || stored.sha256 !== publication.sha256 || sha256Hex(Buffer.from(stored.bytes)) !== publication.sha256
      || (stored.retain_until !== null && !(Date.parse(stored.retain_until) > Date.parse(now)))) return null
    evidence.push({ receipt_seq: seq, artifact_id: publication.artifact_id, sha256: publication.sha256, file_name: rule.file_name })
  }
  const proof = { source: publicationEvent, run_id: row.run_id, node_run_id: row.node_run_id, attempt: row.attempt,
    action_generation: row.action_generation, plan_id: approved.planId, plan_hash: approved.contentHash, artifacts: evidence }
  return { digest: sha256Hex(canonicalJson(proof)), proof }
}
