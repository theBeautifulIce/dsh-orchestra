// 生成 G5 门记录模板：必过项表、不变量表、GateArtifact、evidence-index、invariants 全部从 scripts/gate-check.ts 的固定口径抄
// 用法：node --no-warnings scripts/gen-g5-record.ts [输出路径]
// 模板里的哈希是占位符：真正的哈希由 scripts/sign-gate.ts 按 HEAD 字节重算并回填，门记录本身必须由人签。
import { existsSync, writeFileSync } from 'node:fs'
import { GATE_SPECS } from './gate-check.ts'

const gate = 'G5'
const spec = GATE_SPECS[gate]
if (!spec) throw new Error('没有这道门的校验规格: ' + gate)

const out = process.argv[2] ?? 'docs/reviews/S5-g5-record-template.md'
const zero = '0'.repeat(64)

const evidenceIds = Object.keys(spec.evidenceFiles).sort()
const entries = evidenceIds.map((id) => ({ id, file: spec.evidenceFiles[id] as string, sha256: zero }))
const items = spec.items.map((id) => ({ id, result: 'pass', evidence_ids: (spec.evidenceMap[id] ?? []).slice() }))
const invariants = Object.entries(spec.invariants)
  .map(([id, v]) => ({ id, statement: v.statement, evidence_ids: v.evidence_ids.slice().sort() }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// 口径自检：内容列里的竖线会破表；证据必须都被必过项或不变量引用
const problems: string[] = []
for (const id of spec.items) {
  const content = spec.content[id] ?? ''
  if (content.includes('|')) problems.push('必过项 ' + id + ' 的固定内容含竖线，正文表会被拆列')
  if (!content) problems.push('必过项 ' + id + ' 没有固定内容')
}
const used = new Set<string>()
for (const item of items) for (const e of item.evidence_ids) used.add(e)
for (const inv of invariants) for (const e of inv.evidence_ids) used.add(e)
for (const id of evidenceIds) if (!used.has(id)) problems.push('证据 ' + id + ' 没被任何必过项或不变量引用')
const missingEvidence = entries.filter((e) => !existsSync(e.file)).map((e) => e.file)
if (missingEvidence.length > 0) problems.push('证据文件还没产出 ' + String(missingEvidence.length) + ' 份（签门前必须提交到 HEAD）')

const itemRows = items
  .map((i) => '| ' + i.id + ' | ' + (spec.content[i.id] ?? '') + ' | pass | ' + i.evidence_ids.slice().sort().join(', ') + ' |')
  .join('\n')
const evidenceRows = entries.map((e) => '| ' + e.id + ' | `' + e.file + '` | `' + e.sha256 + '` |').join('\n')
const invariantRows = invariants.map((i) => '| ' + i.id + ' | ' + i.statement + ' | ' + i.evidence_ids.join(',') + ' |').join('\n')

const artifact = {
  gate,
  schema_version: 1,
  gate_run_id: null,
  candidate_hash: zero,
  change_scope_hash: zero,
  evidence_index_hash: zero,
  invariants_hash: zero,
  must_pass_items: items,
  failed_items: [],
  conclusion: 'pass',
  run_terminal: 'not_applicable',
  exceptions: [],
  rollback: {
    target: '回到 S4 流程发布收口点',
    action: 'git revert 本批 S5 提交，记忆四表与结算表只插不改，回滚只影响未推进的 run',
    max_seconds: 900,
    verify: '重跑 G1/G2/G3/G4 门检查与证据复现通过',
  },
  approver: 'human:啸春',
  approved_at: '2026-11-18T00:00:00.000Z',
  producer: 'human',
  previous_artifact_hash: zero,
  audit_round: 1,
  audit_report: 'docs/audits/S5-independent-audit-round1.md',
  audit_report_sha256: zero,
}

const text = [
  '> 这是 G5 门记录的**生成模板**，不是门记录：正文里的哈希全是占位符。真正的门记录由 scripts/sign-gate.ts 按 HEAD 字节重算后写进 docs/gates/G5.md，并由人签。',
  '',
  '# G5 门记录：面板与记忆（S5）',
  '',
  '- 门：G5',
  '- 候选：`' + spec.scopeBase + '..HEAD` 的代码、测试与脚本（candidate_hash / change_scope_hash 覆盖这一段，排除 docs/gates 门记录自身与 docs/audits、docs/reviews、handoff.md；证据文件仍计入候选）',
  '- 结论：**pass**（' + String(items.length) + ' 项必过全过，失败项为空，无 run）',
  '- 批准人：human:啸春',
  '- 批准时间：2026-11-18T00:00:00.000Z',
  '',
  '## 结论',
  '',
  'G5 通过。S5 把面板读模型与写命令、记忆四表与固定图、副作用结算契约落成一套可复现的装配：面板六屏全部接真实读模型，面板控制面只开六个写命令，记忆写入受审批快照与绑定校验约束，副作用结算按证据 / 人工裁决 / 已核实未发生三条互斥路径落库并留痕。',
  '',
  '## 必过项与证据',
  '',
  '| 编号 | 内容 | 结果 | 证据 |',
  '| --- | --- | --- | --- |',
  itemRows,
  '',
  '## 证据文件与哈希',
  '',
  '证据哈希按 LF 归一后的字节算；改一个字节、追加一行都会与下表不一致，门检查会点名是哪一份。',
  '',
  '| 证据 | 文件 | sha256 |',
  '| --- | --- | --- |',
  evidenceRows,
  '',
  '## 失败项',
  '',
  '无。',
  '',
  '## 例外',
  '',
  '无。',
  '',
  '## 回滚',
  '',
  '回滚 G5 需要按 G5→G4→G3→G2→G1 的逆序重签：只回滚本门会让 previous_artifact_hash 链断，门检查会拒。',
  '',
  '## 不变量',
  '',
  '| 不变量 | 语句 | 证据 |',
  '| --- | --- | --- |',
  invariantRows,
  '',
  '## GateArtifact',
  '',
  '```json',
  JSON.stringify(artifact, null, 2),
  '```',
  '',
  '```json evidence-index',
  JSON.stringify(entries, null, 2),
  '```',
  '',
  '```json invariants',
  JSON.stringify(invariants, null, 2),
  '```',
  '',
  '- artifact_hash=' + zero,
  'body_hash=' + zero,
  '',
].join('\n')

writeFileSync(out, text)
console.log('模板已写：' + out + '（必过项 ' + String(items.length) + ' 项，证据 ' + String(entries.length) + ' 份，不变量 ' + String(invariants.length) + ' 条）')
if (problems.length > 0) {
  console.log('口径自检有 ' + String(problems.length) + ' 条要处理：')
  for (const p of problems) console.log(' - ' + p)
} else {
  console.log('口径自检：内容列无竖线，证据全部被引用')
}
if (missingEvidence.length > 0) {
  console.log('还没产出的证据文件（前 20 份）：')
  for (const f of missingEvidence.slice(0, 20)) console.log(' - ' + f)
}
