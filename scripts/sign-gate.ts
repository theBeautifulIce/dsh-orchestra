// 重签 G1 门记录：证据文件哈希、candidate/change_scope、evidence_index_hash、invariants_hash、artifact_hash 锚点
// 用法：node --no-warnings scripts/sign-gate.ts docs/gates/G1.md
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { GATE_SPECS, type EvidenceEntry, type InvariantEntry } from './gate-check.ts'

const path = process.argv[2] ?? 'docs/gates/G1.md'
const root = resolve(process.cwd())
let text = readFileSync(path, 'utf8')
const blocks = [...text.matchAll(/```json[ \t]*([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/g)]
const artifactMatch = blocks.find((m) => { try { return JSON.parse(m[2] ?? '')?.gate === 'G1' } catch { return false } })
if (!artifactMatch) throw new Error('找不到 GateArtifact')
const artifact = JSON.parse(artifactMatch[2] ?? '') as Record<string, any>
const evidenceBlock = blocks.find((m) => (m[1] ?? '').trim() === 'evidence-index')
const invariantBlock = blocks.find((m) => (m[1] ?? '').trim() === 'invariants')
if (!evidenceBlock || !invariantBlock) throw new Error('缺少 evidence-index 或 invariants 块')

const entries = (JSON.parse(evidenceBlock[2] ?? '') as EvidenceEntry[]).map((e) => {
  const sha = sha256Hex(readFileSync(join(root, e.file), 'utf8').replace(/\r\n/g, '\n'))
  return { ...e, sha256: sha }
})
const sortedEvidence = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const evidenceHash = sha256Hex(canonicalJson(sortedEvidence))
for (const e of sortedEvidence) {
  const row = new RegExp('(\\| ' + e.id + ' \\| `' + e.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '` \\| `)[0-9a-f]{64}(` \\|)')
  text = text.replace(row, '$1' + e.sha256 + '$2')
}
artifact.evidence_index_hash = evidenceHash

const invariants = (JSON.parse(invariantBlock[2] ?? '') as InvariantEntry[]).map((i) => ({ id: i.id, statement: i.statement, evidence_ids: i.evidence_ids.slice().sort() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
artifact.invariants_hash = sha256Hex(canonicalJson(invariants))

const spec = GATE_SPECS.G1
const git = (args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const args = ['diff', '--name-only', '--diff-filter=ACMR', spec.scopeBase + '..HEAD', '--', '.']
for (const dir of spec.excludes) args.push(':(exclude)' + dir)
const paths = git(args).toString('utf8').split(/\r?\n/).filter(Boolean).sort()
const files = paths.map((p) => ({ path: p, sha256: sha256Hex(git(['show', 'HEAD:' + p])) }))
artifact.candidate_hash = sha256Hex(canonicalJson(files))
artifact.change_scope_hash = sha256Hex(canonicalJson(paths))

const newArtifactJson = JSON.stringify(artifact, null, 2)
text = text.slice(0, artifactMatch.index) + '```json\n' + newArtifactJson + '\n```' + text.slice(artifactMatch.index! + artifactMatch[0].length)
const artifactHash = sha256Hex(canonicalJson(artifact))
text = text.replace(/artifact_hash=[0-9a-f]{64}/, 'artifact_hash=' + artifactHash)
writeFileSync(path, text)
console.log('重签完成：证据 ' + String(entries.length) + ' 份，candidate=' + artifact.candidate_hash.slice(0, 12) + '…，artifact_hash=' + artifactHash.slice(0, 12) + '…，改动文件 ' + String(paths.length) + ' 个')
