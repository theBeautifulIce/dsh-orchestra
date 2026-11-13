// 门记录校验：读 S*.md 里的 GateArtifact，核字段、结论规则与 artifact_hash 锚点（规格 11.3 行 978-984）
// 用法：node --no-warnings scripts/gate-check.ts docs/gates/G1.md
import { readFileSync } from 'node:fs'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'

export const GATE_FIELDS = [
  'gate', 'schema_version', 'gate_run_id', 'candidate_hash', 'change_scope_hash',
  'evidence_index_hash', 'invariants_hash', 'must_pass_items', 'failed_items', 'conclusion',
  'run_terminal', 'exceptions', 'rollback', 'approver', 'approved_at', 'producer',
] as const

export type GateItem = { id: string; result: string; evidence_ids?: string[] }

export type CheckResult = { gate: string; artifactHash: string; items: number }

export function verifyGateRecord(text: string): CheckResult {
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(text)
  if (!block) throw new Error('门记录里找不到 GateArtifact 的 json 块')
  let artifact: Record<string, unknown>
  try {
    artifact = JSON.parse(block[1]!) as Record<string, unknown>
  } catch (err) {
    throw new Error('GateArtifact 不是合法 JSON：' + (err instanceof Error ? err.message : String(err)))
  }
  for (const field of GATE_FIELDS) {
    if (!(field in artifact)) throw new Error('GateArtifact 缺字段: ' + field)
  }
  if (artifact.schema_version !== 1) throw new Error('schema_version 必须是 1')
  const items = artifact.must_pass_items as GateItem[]
  if (!Array.isArray(items) || items.length === 0) throw new Error('must_pass_items 为空')
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.length === 0) throw new Error('must_pass_items 里有项没有 id')
    if (item.result !== 'pass') throw new Error('必过项没过: ' + item.id)
    if (!Array.isArray(item.evidence_ids) || item.evidence_ids.length === 0) {
      throw new Error('必过项缺证据: ' + item.id)
    }
  }
  const failed = artifact.failed_items as unknown[]
  if (!Array.isArray(failed) || failed.length !== 0) throw new Error('failed_items 不为空')
  if (artifact.conclusion !== 'pass') throw new Error('conclusion 不是 pass')
  const hasRun = artifact.gate_run_id !== null
  if (hasRun && artifact.run_terminal !== 'succeeded') {
    throw new Error('有 run 的门 run_terminal 必须是 succeeded，实际 ' + String(artifact.run_terminal))
  }
  if (!hasRun && artifact.run_terminal !== 'not_applicable') {
    throw new Error('无 run 的门 run_terminal 必须是 not_applicable，实际 ' + String(artifact.run_terminal))
  }
  if (artifact.gate === 'G1' && artifact.producer !== 'human') throw new Error('G1 的 producer 必须是 human')

  const anchor = /artifact_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 artifact_hash 锚点')
  const expect = sha256Hex(canonicalJson(artifact))
  if (anchor[1] !== expect) throw new Error('artifact_hash 与正文不符：' + anchor[1] + ' != ' + expect)
  return { gate: String(artifact.gate), artifactHash: expect, items: items.length }
}

if (process.argv[1] && /gate-check\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const path = process.argv[2] ?? 'docs/gates/G1.md'
  try {
    const out = verifyGateRecord(readFileSync(path, 'utf8'))
    console.log('gate ' + out.gate + ' 通过（' + String(out.items) + ' 项必过，artifact_hash=' + out.artifactHash.slice(0, 12) + '…）')
  } catch (err) {
    console.error('门检查失败：' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  }
}
