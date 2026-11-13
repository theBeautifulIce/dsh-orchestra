// 重签 G1 门记录：证据文件哈希、candidate/change_scope、evidence_index_hash、invariants_hash、artifact_hash 锚点
// 用法：node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { assertClean, bodyHash, candidateEntries, GATE_SPECS, verifyGateRecord, type EvidenceEntry, type InvariantEntry } from './gate-check.ts'

const path = process.argv[2] ?? 'docs/gates/G1.md'
const root = resolve(process.cwd())
// 先确认候选范围干净：脏文件不进 candidate_hash，签出来的门等于没覆盖它（审计 N-09）
assertClean(root)
let text = readFileSync(path, 'utf8')
const blocks = [...text.matchAll(/```json[ \t]*([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/g)]
const artifactMatch = blocks.find((m) => { try { return typeof JSON.parse(m[2] ?? '')?.gate === 'string' } catch { return false } })
if (!artifactMatch) throw new Error('找不到 GateArtifact')
const artifact = JSON.parse(artifactMatch[2] ?? '') as Record<string, any>
const evidenceBlock = blocks.find((m) => {
  try {
    const v = JSON.parse(m[2] ?? '')
    return Array.isArray(v) && v.length > 0 && v.every((e: any) => e && typeof e.id === 'string' && typeof e.file === 'string' && typeof e.sha256 === 'string')
  } catch { return false }
})
const invariantBlock = blocks.find((m) => (m[1] ?? '').trim() === 'invariants')
if (!evidenceBlock || !invariantBlock) throw new Error('缺少 evidence-index 或 invariants 块')

const entries = (JSON.parse(evidenceBlock[2] ?? '') as EvidenceEntry[]).map((e) => {
  // 证据以 HEAD 为准：工作树里改了没提交的证据不能拿来签
  const bytes = execFileSync('git', ['show', 'HEAD:' + e.file], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  const sha = sha256Hex(bytes.toString('utf8').replace(/\r\n/g, '\n'))
  return { ...e, sha256: sha }
})
const sortedEvidence = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const evidenceHash = sha256Hex(canonicalJson(sortedEvidence))
for (const e of sortedEvidence) {
  const row = new RegExp('(\\| ' + e.id + ' \\| `' + e.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '` \\| `)[0-9a-f]{64}(` \\|)')
  text = text.replace(row, '$1' + e.sha256 + '$2')
}
artifact.evidence_index_hash = evidenceHash
// 证据索引 json 块也换成新哈希：门检查读的是这个块，不是人读的表
text = text.slice(0, evidenceBlock.index) + '```json evidence-index\n' + JSON.stringify(sortedEvidence, null, 2) + '\n```' + text.slice(evidenceBlock.index! + evidenceBlock[0].length)

const invariants = (JSON.parse(invariantBlock[2] ?? '') as InvariantEntry[]).map((i) => ({ id: i.id, statement: i.statement, evidence_ids: i.evidence_ids.slice().sort() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
artifact.invariants_hash = sha256Hex(canonicalJson(invariants))

const gate = String(artifact.gate)
const spec = GATE_SPECS[gate]
if (!spec) throw new Error('没有这道门的校验规格: ' + gate)
const git = (args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const { paths, files } = candidateEntries(root, spec)
artifact.candidate_hash = sha256Hex(canonicalJson(files))
artifact.change_scope_hash = sha256Hex(canonicalJson(paths))
// 前序门哈希链：本门指向前序门记录在 HEAD 里的 artifact_hash，重签链断了门检查会拒（审计 R3-08）
if (spec.prevGate) {
  const prevSpec = GATE_SPECS[spec.prevGate]
  const prevText = execFileSync('git', ['show', 'HEAD:' + prevSpec.gateFile], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const prevAnchor = /artifact_hash=([0-9a-f]{64})/.exec(prevText)
  if (!prevAnchor) throw new Error('前序门记录里找不到 artifact_hash 锚点: ' + prevSpec.gateFile)
  artifact.previous_artifact_hash = prevAnchor[1] ?? ''
} else {
  artifact.previous_artifact_hash = '0'.repeat(64)
}

// 审计报告按 HEAD 字节固定：只记路径的话，签完再改报告正文门检查发现不了（S1 第二轮审计）
const auditReport = String(artifact.audit_report ?? '')
if (!auditReport) throw new Error('artifact 里没有 audit_report')
const auditBytes = git(['show', 'HEAD:' + auditReport])
artifact.audit_report_sha256 = sha256Hex(Buffer.from(auditBytes.toString('utf8').replace(/\r\n/g, '\n')))

const newArtifactJson = JSON.stringify(artifact, null, 2)
text = text.slice(0, artifactMatch.index) + '```json\n' + newArtifactJson + '\n```' + text.slice(artifactMatch.index! + artifactMatch[0].length)
const artifactHash = sha256Hex(canonicalJson(artifact))
text = text.replace(/artifact_hash=[0-9a-f]{64}/, 'artifact_hash=' + artifactHash)
// 正文自锚：除了两个自锚点与反引号里的 sha256，正文任何改动都会改掉这个值（审计 R3-08）
if (!/body_hash=[0-9a-f]{64}/.test(text)) {
  text = text.replace(/(artifact_hash=[0-9a-f]{64})/, '$1\nbody_hash=' + '0'.repeat(64))
}
const bodyValue = bodyHash(text)
text = text.replace(/body_hash=[0-9a-f]{64}/, 'body_hash=' + bodyValue)
// 写回之前先按门检查跑一遍：签出来的记录必须是能过的
verifyGateRecord(text, { root, path, selfCheck: true })
writeFileSync(path, text)
console.log('重签完成：证据 ' + String(entries.length) + ' 份，candidate=' + artifact.candidate_hash.slice(0, 12) + '…，artifact_hash=' + artifactHash.slice(0, 12) + '…，body_hash=' + bodyValue.slice(0, 12) + '…，改动文件 ' + String(paths.length) + ' 个')