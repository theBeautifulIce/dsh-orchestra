// 门记录校验：读 S*.md 里的 GateArtifact，核字段、结论规则、必过项清单、证据文件哈希与四个哈希的原像（规格 11.3 行 978-986）
// 用法：node --no-warnings scripts/gate-check.ts docs/gates/G1.md
//
// 哈希口径（门记录里的值都能重算，不是手写数）：
//   candidate_hash      = SHA256(canonical_json([{path, sha256}]，按 path 升序))，取 HEAD 上候选范围内的文件内容
//   change_scope_hash   = SHA256(canonical_json([path ...]，按升序))，取候选范围内的改动文件清单
//   evidence_index_hash = SHA256(canonical_json([{id, file, sha256}]，按 id 升序))，sha256 是证据文件当前字节的 SHA256
//   invariants_hash     = SHA256(canonical_json([{id, statement, evidence_ids}]，按 id 升序))
//   body_hash           = SHA256(正文归一化文本)，归一化只把两个自锚点与反引号里的 64 位 sha256 换成占位符
// 候选范围 = GATE_SPECS[gate].scopeBase..HEAD 的改动，排除 docs/gates 与 docs/audits（记录本身不进候选）。
// 防重签口径（第三轮审计 R3-05…R3-09）：
//   producer 必须是 human（规格 11.3 行 981，G1 到 G5 的主 artifact 由人手工跑）
//   必过项与证据是固定映射（evidenceMap），换绑证据重签会被挡住
//   正文两张表（证据文件与哈希、例外）必须与 artifact 同源，正文改动由 body_hash 抓住
//   previous_artifact_hash 指向前序门记录的 artifact_hash，重签链断了会被挡住
//   audit_round / audit_report 指向本轮独立审计，审计报告必须已在 HEAD
//   门记录本身必须在 HEAD 里（改了没提交不算数），工作树脏文件（含 docs/gates）一律不许签
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'

export const GATE_FIELDS = [
  'gate', 'schema_version', 'gate_run_id', 'candidate_hash', 'change_scope_hash',
  'evidence_index_hash', 'invariants_hash', 'must_pass_items', 'failed_items', 'conclusion',
  'run_terminal', 'exceptions', 'rollback', 'approver', 'approved_at', 'producer',
  'previous_artifact_hash', 'audit_round', 'audit_report',
] as const

export type GateSpec = {
  items: string[]
  content: Record<string, string>
  // 每道门固定一张必过项清单：少了、多了、改名都算没过（审计 M4）；正文表的内容列也按这张表核对（审计 N-09）
  evidenceMap: Record<string, string[]>
  scopeBase: string
  excludes: string[]
  prevGate: string | null
  gateFile: string
}

export const GATE_SPECS: Record<string, GateSpec> = {
  G1: {
    items: ['G1-01', 'G1-02', 'G1-03', 'G1-04', 'G1-05', 'G1-06', 'G1-07', 'G-01', 'G-02', 'G-08', 'G-09', 'G-14', 'G-15'],
    content: {
      'G1-01': '迁移空库可重复',
      'G1-02': '迁移中途杀可重入',
      'G1-03': '进程杀不丢已提交事件',
      'G1-04': '备份独立目录行数与哈希一致',
      'G1-05': '损坏备份可检出',
      'G1-06': '认证拒匿名写',
      'G1-07': '阶段开关拒未知值',
      'G-01': '事务 COMMIT 前杀进程',
      'G-02': 'COMMIT 后未投递被杀',
      'G-08': '长事务期间读不被拖死、写报 busy、队列溢出报 503',
      'G-09': '订阅者离线重放',
      'G-14': '迁移一半杀后重跑',
      'G-15': '备份截断能检出、恢复被拒、线上库不变',
    },
    evidenceMap: {
      'G1-01': ['ev-migrate'],
      'G1-02': ['ev-g14'],
      'G1-03': ['ev-g02'],
      'G1-04': ['ev-backup'],
      'G1-05': ['ev-g15'],
      'G1-06': ['ev-auth'],
      'G1-07': ['ev-phase'],
      'G-01': ['ev-g01'],
      'G-02': ['ev-g02'],
      'G-08': ['ev-g08'],
      'G-09': ['ev-g09'],
      'G-14': ['ev-g14'],
      'G-15': ['ev-g15'],
    },
    scopeBase: '623939d4c0a7123835b525287035588ee291ccbe',
    // handoff 是活文档，每次收尾都会改；它进候选范围会让门哈希随一次文档更新失效（审计 F-02）
    excludes: ['docs/gates', 'docs/audits', 'docs/reviews', 'handoff.md'],
    prevGate: null,
    gateFile: 'docs/gates/G1.md',
  },
  G2: {
    items: ['G2-01', 'G2-02', 'G2-03', 'G2-04', 'G2-05', 'G2-06', 'G2-07', 'G-03', 'G-04', 'G-05', 'G-07', 'G2-08', 'G2-09', 'G2-10', 'G2-11', 'G2-12', 'G2-13', 'G2-14'],
    content: {
      'G2-01': '单节点 queued 到终态一条路径（走生产装配）',
      'G2-02': '重复上报只落一次',
      'G2-03': '租约过期迟到上报被拒',
      'G2-04': '取消后不产生新 attempt',
      'G2-05': '终态必带证据',
      'G2-06': '无裸 blocked（没裁决卡不许卡住）',
      'G2-07': 'S2 加载 parallel 被拒',
      'G-03': '同一 report_id 上报两次只落一次',
      'G-04': '租约到期后原执行器迟到上报被拒',
      'G-05': '工具执行中取消只立一次围栏',
      'G-07': '墙钟跳变不误判截止',
      'G2-08': '工具失败不许落完成（系统判失败并挂凭据）',
      'G2-09': '判定时限只认 boot_id 与单调纳秒（墙钟跳变不误判）',
      'G2-10': '报告入口系统级证据门（弱证据与伪造痕迹一律拒）',
      'G2-11': '反复重投同一 report_id 不许把账本刷膨胀',
      'G2-12': '工具授权只认 workflow 定义，请求体策略不参与',
      'G2-13': '单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 写不进',
      'G2-14': '长动作靠心跳续租，扫描不误判过期',
    },
    evidenceMap: {
      'G2-01': ['ev-g2-01'],
      'G2-02': ['ev-g2-02'],
      'G2-03': ['ev-g2-03'],
      'G2-04': ['ev-g2-04'],
      'G2-05': ['ev-g2-05', 'ev-g2-10'],
      'G2-06': ['ev-g2-06'],
      'G2-07': ['ev-g2-07'],
      'G-03': ['ev-g2-g03'],
      'G-04': ['ev-g2-g04'],
      'G-05': ['ev-g2-g05'],
      'G-07': ['ev-g2-g07', 'ev-g2-09'],
      'G2-08': ['ev-g2-08'],
      'G2-09': ['ev-g2-09'],
      'G2-10': ['ev-g2-10'],
      'G2-11': ['ev-g2-11'],
      'G2-12': ['ev-g2-12'],
      'G2-13': ['ev-g2-13'],
      'G2-14': ['ev-g2-14'],
    },
    scopeBase: '4f3ada7',
    excludes: ['docs/gates', 'docs/audits', 'docs/reviews', 'handoff.md'],
    prevGate: 'G1',
    gateFile: 'docs/gates/G2.md',
  },
}

export type GateItem = { id: string; result: string; evidence_ids?: string[] }
export type EvidenceEntry = { id: string; file: string; sha256: string }
export type InvariantEntry = { id: string; statement: string; evidence_ids: string[] }
export type CheckResult = { gate: string; artifactHash: string; bodyHash: string; items: number; evidence: number }

type Block = { tag: string; body: string; value: unknown }

function jsonBlocks(text: string): Block[] {
  const out: Block[] = []
  const re = /```json[ \t]*([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/g
  for (const m of text.matchAll(re)) {
    try {
      out.push({ tag: (m[1] ?? '').trim(), body: m[2] ?? '', value: JSON.parse(m[2] ?? '') })
    } catch (err) {
      throw new Error('门记录里的 json 块不是合法 JSON（' + ((m[1] ?? '').trim() || '未标注') + '）：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return out
}

function blockOf(blocks: Block[], tag: string): Block {
  const hit = blocks.find((b) => b.tag === tag)
  if (!hit) throw new Error('门记录里找不到 ' + tag + ' 的 json 块')
  return hit
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
}

function changedFiles(root: string, spec: { scopeBase: string; excludes: string[] }): string[] {
  // 删除也是候选改动：--diff-filter 不能把 D 漏掉（审计 N-09）
  const range = spec.scopeBase + '..HEAD'
  const pathspec = ['--', '.']
  for (const dir of spec.excludes) pathspec.push(':(exclude)' + dir)
  const set = new Set<string>()
  for (const line of git(root, ['diff', '--name-only', range, ...pathspec]).toString('utf8').split(/\r?\n/)) {
    if (line.length > 0) set.add(line)
  }
  // 批内新增后又删除的文件在树差异里看不见，要从提交历史里捞回来（审计 R3-09）
  for (const filter of ['A', 'D']) {
    const out = git(root, ['log', '--format=', '--name-only', '--diff-filter=' + filter, '-z', range, ...pathspec]).toString('utf8')
    for (const p of out.split('\u0000')) {
      const trimmed = p.trim()
      if (trimmed.length > 0) set.add(trimmed)
    }
  }
  return Array.from(set).sort()
}

// 门记录只能对着干净的 HEAD 签：脏文件不进 candidate_hash，却可能被当成本次候选（审计 N-09、R3-07）
// docs/gates 不在忽略清单里：门记录自己脏了就是没签完，不许继续往下走
const DIRTY_IGNORES = ['docs/audits', 'docs/reviews', 'handoff.md']

export function assertClean(root: string): void {
  const args = ['status', '--porcelain', '--', '.']
  for (const dir of DIRTY_IGNORES) args.push(':(exclude)' + dir)
  const dirty = git(root, args).toString('utf8').trim()
  if (dirty.length > 0) {
    throw new Error('工作树有未提交改动，门记录不能对着脏树签：' + dirty.split(/\r?\n/)[0])
  }
}

function contentAt(root: string, ref: string, path: string): Buffer | null {
  try {
    return git(root, ['show', ref + ':' + path])
  } catch {
    return null
  }
}

// 候选文件的哈希原像一律取 HEAD；删除的文件把「删除」和删除前内容一起并进哈希
export function candidateEntries(root: string, spec: { scopeBase: string; excludes: string[] }): { paths: string[]; files: { path: string; sha256: string }[] } {
  const paths = changedFiles(root, spec)
  const files = paths.map((path) => {
    const head = contentAt(root, 'HEAD', path)
    if (head) return { path, sha256: sha256Hex(head) }
    const base = contentAt(root, spec.scopeBase, path)
    if (base) return { path, sha256: sha256Hex(Buffer.concat([Buffer.from('DELETED\n'), base])) }
    // 批内新增又删除的文件在基准与 HEAD 都没有内容，用固定原像占位，保证它留在候选清单里（审计 R3-09）
    return { path, sha256: sha256Hex(Buffer.from('ADDED_THEN_DELETED\n')) }
  })
  return { paths, files }
}

function checkEvidence(blocks: Block[], artifact: Record<string, unknown>, root: string): { entries: EvidenceEntry[]; hash: string } {
  const raw = blockOf(blocks, 'evidence-index').value
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('evidence-index 为空')
  const entries: EvidenceEntry[] = []
  const seen = new Set<string>()
  for (const e of raw as EvidenceEntry[]) {
    if (typeof e.id !== 'string' || typeof e.file !== 'string' || !/^[0-9a-f]{64}$/.test(String(e.sha256))) {
      throw new Error('evidence-index 的项要有 id / file / 64 位 sha256：' + JSON.stringify(e))
    }
    if (seen.has(e.id)) throw new Error('evidence-index 里 id 重复: ' + e.id)
    seen.add(e.id)
    // 证据也读 HEAD：工作树里改证据但没提交，不能拿来签门（审计 N-09）
    const head = contentAt(root, 'HEAD', e.file)
    if (!head) throw new Error('证据文件不在 HEAD 里，先提交证据再签门: ' + e.id)
    // 证据按 LF 归一的字节算哈希：仓库 checkout 的换行风格不同也得到同一个值
    const actual = sha256Hex(head.toString('utf8').replace(/\r\n/g, '\n'))
    if (actual !== e.sha256) throw new Error('证据文件 sha256 不符: ' + e.id + '（记录 ' + e.sha256.slice(0, 16) + '… 实际 ' + actual.slice(0, 16) + '…）')
    entries.push({ id: e.id, file: e.file, sha256: actual })
  }
  const sorted = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = sha256Hex(canonicalJson(sorted))
  if (artifact.evidence_index_hash !== hash) {
    throw new Error('evidence_index_hash 与证据索引不符：' + String(artifact.evidence_index_hash).slice(0, 16) + '… != ' + hash.slice(0, 16) + '…')
  }
  return { entries, hash }
}

function checkInvariants(blocks: Block[], artifact: Record<string, unknown>, entries: EvidenceEntry[]): { used: Set<string>; hash: string; list: InvariantEntry[] } {
  const raw = blockOf(blocks, 'invariants').value
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invariants 为空')
  const list: InvariantEntry[] = []
  const used = new Set<string>()
  for (const e of raw as InvariantEntry[]) {
    if (typeof e.id !== 'string' || typeof e.statement !== 'string' || !Array.isArray(e.evidence_ids) || e.evidence_ids.length === 0) {
      throw new Error('invariants 的项要有 id / statement / evidence_ids：' + JSON.stringify(e))
    }
    for (const id of e.evidence_ids) {
      if (!entries.some((x) => x.id === id)) throw new Error('不变量引用了不存在的证据: ' + id)
      used.add(id)
    }
    list.push({ id: e.id, statement: e.statement, evidence_ids: e.evidence_ids.slice().sort() })
  }
  const sorted = list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = sha256Hex(canonicalJson(sorted))
  if (artifact.invariants_hash !== hash) {
    throw new Error('invariants_hash 与不变量清单不符：' + String(artifact.invariants_hash).slice(0, 16) + '… != ' + hash.slice(0, 16) + '…')
  }
  return { used, hash, list: sorted }
}

// 正文表与 GateArtifact 交叉校验（审计 F-02）：表里写的必过项、结果、证据必须和 artifact 同源
function checkBodyTable(text: string, items: GateItem[], spec: { content: Record<string, string> }): void {
  const start = text.indexOf('## 必过项与证据')
  if (start < 0) throw new Error('门记录里找不到「## 必过项与证据」表')
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const rows: { id: string; content: string; result: string; evidence: string[] }[] = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 4) continue
    const id = cells[0] ?? ''
    if (id === '编号' || /^-+$/.test(id)) continue
    rows.push({ id, content: cells[1] ?? '', result: cells[2] ?? '', evidence: (cells[3] ?? '').split(/[,，\s]+/).filter((s) => s.length > 0 && s !== '无') })
  }
  if (rows.length !== items.length) throw new Error('正文必过项表有 ' + String(rows.length) + ' 行，artifact 有 ' + String(items.length) + ' 项')
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('正文必过项表有重复编号')
  for (let i = 0; i < items.length; i += 1) {
    const row = rows[i]
    if (!row) throw new Error('正文必过项表缺第 ' + String(i + 1) + ' 行')
    const item = items[i] as GateItem
    if (row.id !== item.id) throw new Error('正文必过项第 ' + String(i + 1) + ' 行是 ' + row.id + '，artifact 是 ' + item.id)
    // 第 2 列内容按固定表核对：改字、换说法都不许悄悄过关（审计 N-09）
    const wantContent = spec.content[row.id]
    if (!wantContent) throw new Error('没有为必过项 ' + row.id + ' 定义正文固定内容')
    if (row.content !== wantContent) throw new Error('正文表里 ' + row.id + ' 的内容与固定表不一致：' + row.content + ' != ' + wantContent)
    if (row.result !== 'pass') throw new Error('正文表里 ' + row.id + ' 的结果不是 pass：' + row.result)
    const want = (item.evidence_ids ?? []).slice().sort().join(',')
    const got = row.evidence.slice().sort().join(',')
    if (want !== got) throw new Error('正文表里 ' + row.id + ' 的证据与 artifact 不一致：' + got + ' != ' + want)
  }
}

// 正文里的表统一读法：取某个二级标题下的表格行，单元格去掉反引号
function tableRows(text: string, heading: string): string[][] {
  const start = text.indexOf(heading)
  if (start < 0) throw new Error('门记录里找不到「' + heading + '」表')
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const rows: string[][] = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    if (/^-+$/.test(cells[0] ?? '')) continue
    // 表头行不算数据行：证据表头是「证据」、例外表头是「码」、不变量表头是「不变量」
    if (cells[0] === '证据' || cells[0] === '码' || cells[0] === '不变量') continue
    rows.push(cells.map((c) => c.replace(/^`([^`]*)`$/, '$1')))
  }
  return rows
}

// 正文的「证据文件与哈希」表必须与 evidence-index 同源：改了 sha256 列或改了文件都会被点名（审计 R3-06）
function checkBodyEvidenceTable(text: string, entries: EvidenceEntry[]): void {
  const rows = tableRows(text, '## 证据文件与哈希')
  if (rows.length === 0) {
    if (entries.length !== 0) throw new Error('正文「证据文件与哈希」表是空的，但 artifact 列了 ' + String(entries.length) + ' 份证据')
    return
  }
  if (rows.length !== entries.length) throw new Error('正文证据表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(entries.length) + ' 份证据')
  const map = new Map(entries.map((e) => [e.id, e]))
  for (const row of rows) {
    const id = row[0] ?? ''
    const file = row[1] ?? ''
    const sha = row[2] ?? ''
    const e = map.get(id)
    if (!e) throw new Error('正文证据表里有 artifact 没有的证据: ' + id)
    if (e.file !== file) throw new Error('正文证据表里 ' + id + ' 的文件与 artifact 不一致: ' + file + ' != ' + e.file)
    if (e.sha256 !== sha) throw new Error('正文证据表里 ' + id + ' 的 sha256 与 artifact 不一致（证据被改过或表没跟着改）')
  }
}

// 正文的「例外」表必须与 artifact.exceptions 同源：例外说明改了字也会被抓（审计 R3-06）
function checkBodyExceptions(text: string, exceptions: unknown): void {
  const list = (Array.isArray(exceptions) ? exceptions : []) as { code: string; type: string; status: number; note: string }[]
  const rows = tableRows(text, '## 例外')
  if (rows.length === 0) {
    if (list.length !== 0) throw new Error('正文「例外」表是空的，但 artifact 列了 ' + String(list.length) + ' 条例外')
    return
  }
  if (rows.length !== list.length) throw new Error('正文例外表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(list.length) + ' 条')
  for (let i = 0; i < list.length; i += 1) {
    const row = rows[i] as string[]
    const e = list[i] as { code: string; type: string; status: number; note: string }
    if ((row[0] ?? '') !== e.code) throw new Error('正文例外表第 ' + String(i + 1) + ' 行的码与 artifact 不一致: ' + (row[0] ?? '') + ' != ' + e.code)
    if ((row[1] ?? '') !== e.type) throw new Error('正文例外表里 ' + e.code + ' 的类型与 artifact 不一致: ' + (row[1] ?? '') + ' != ' + e.type)
    if (Number(row[2] ?? '') !== e.status) throw new Error('正文例外表里 ' + e.code + ' 的 HTTP 与 artifact 不一致: ' + (row[2] ?? '') + ' != ' + String(e.status))
    if ((row[3] ?? '') !== e.note) throw new Error('正文例外表里 ' + e.code + ' 的说明与 artifact 不一致')
  }
}

// 正文的「不变量」表必须与 invariants 块同源：说明改了字也会被抓（审计 R3-06）
function checkBodyInvariants(text: string, list: InvariantEntry[]): void {
  const rows = tableRows(text, '## 不变量')
  if (rows.length === 0) {
    if (list.length !== 0) throw new Error('正文「不变量」表是空的，但 artifact 列了 ' + String(list.length) + ' 条')
    return
  }
  if (rows.length !== list.length) throw new Error('正文不变量表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(list.length) + ' 条')
  const map = new Map(list.map((i) => [i.id, i]))
  for (const row of rows) {
    const id = row[0] ?? ''
    const item = map.get(id)
    if (!item) throw new Error('正文不变量表里有 artifact 没有的不变量: ' + id)
    if ((row[1] ?? '') !== item.statement) throw new Error('正文不变量表里 ' + id + ' 的说明与 artifact 不一致')
    const got = (row[2] ?? '').split(/[,，\s]+/).filter((s) => s.length > 0 && s !== '无').slice().sort().join(',')
    const want = item.evidence_ids.slice().sort().join(',')
    if (got !== want) throw new Error('正文不变量表里 ' + id + ' 的证据与 artifact 不一致: ' + got + ' != ' + want)
  }
}

// 正文自锚：除两个自锚点与反引号里的 sha256 外，正文任何改动都会改掉 body_hash（审计 R3-08）
export function bodyHashInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/artifact_hash=[0-9a-f]{64}/g, 'artifact_hash=<SELF>')
    .replace(/body_hash=[0-9a-f]{64}/g, 'body_hash=<SELF>')
    .replace(/`[0-9a-f]{64}`/g, '`<SELF>`')
}

export function bodyHash(text: string): string {
  return sha256Hex(bodyHashInput(text))
}

function checkBodyHash(text: string): string {
  const anchor = /body_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 body_hash 锚点')
  const expect = bodyHash(text)
  const got = anchor[1] ?? ''
  if (got !== expect) throw new Error('body_hash 与正文不符：' + got.slice(0, 16) + '… != ' + expect.slice(0, 16) + '…（正文改过就重签）')
  return expect
}

// 必过项与证据是固定映射：换绑证据重签会被挡住（审计 R3-08）
function checkEvidenceMap(items: GateItem[], spec: GateSpec): void {
  for (const item of items) {
    const want = spec.evidenceMap[item.id]
    if (!want) throw new Error('没有为必过项 ' + item.id + ' 定义固定证据映射')
    const got = (item.evidence_ids ?? []).slice().sort().join(',')
    const expected = want.slice().sort().join(',')
    if (got !== expected) throw new Error('必过项 ' + item.id + ' 的证据与固定映射不一致（换绑证据不许重签）：' + got + ' != ' + expected)
  }
}

// 重签链：本门要指向前序门记录在 HEAD 里的 artifact_hash（审计 R3-08）
function checkPreviousChain(artifact: Record<string, unknown>, spec: GateSpec, root: string): void {
  const prev = String(artifact.previous_artifact_hash ?? '')
  if (!/^[0-9a-f]{64}$/.test(prev)) throw new Error('previous_artifact_hash 必须是 64 位 sha256')
  if (!spec.prevGate) {
    if (prev !== '0'.repeat(64)) throw new Error('第一道门的 previous_artifact_hash 必须是 64 个 0')
    return
  }
  const prevSpec = GATE_SPECS[spec.prevGate]
  if (!prevSpec) throw new Error('没有前序门的校验规格: ' + spec.prevGate)
  const head = contentAt(root, 'HEAD', prevSpec.gateFile)
  if (!head) throw new Error('前序门记录不在 HEAD 里，先提交前序门记录: ' + prevSpec.gateFile)
  const m = /artifact_hash=([0-9a-f]{64})/.exec(head.toString('utf8'))
  if (!m) throw new Error('前序门记录里找不到 artifact_hash 锚点: ' + prevSpec.gateFile)
  if (m[1] !== prev) throw new Error('previous_artifact_hash 与前序门记录的 artifact_hash 不符（重签链断了）')
}

// 审计报告正文里的结论：pass / fail / 通过 / 不通过，统一成 pass|fail
export function auditConclusionOf(text: string): 'pass' | 'fail' | null {
  const m = /结论[^\n]{0,10}(?:[：:]\s*|\s*\n\s*)\**\s*(pass|fail|不通过|通过)/i.exec(text)
  const raw = m?.[1] ?? /建议[：:]\s*\**\s*(不通过|通过)/.exec(text)?.[1]
  if (!raw) return null
  return raw === 'pass' || raw === '通过' ? 'pass' : 'fail'
}

// 本轮独立审计的锚：报告在 HEAD、轮次对得上，而且报告结论必须与门记录结论一致（第五轮审计 P0-1）
function checkAuditAnchor(artifact: Record<string, unknown>, root: string): void {
  const round = artifact.audit_round
  if (!Number.isInteger(round) || (round as number) < 1) throw new Error('audit_round 必须是正整数')
  const report = String(artifact.audit_report ?? '')
  if (report.length === 0) throw new Error('audit_report 不能空')
  if (!contentAt(root, 'HEAD', report)) throw new Error('审计报告不在 HEAD 里，先提交审计报告: ' + report)
  const m = /round(\d+)/.exec(report)
  const fileRound = m ? Number(m[1]) : 1
  if (fileRound !== round) throw new Error('audit_round 与审计报告的轮次不一致: ' + String(round) + ' != ' + String(fileRound))
  const text = contentAt(root, 'HEAD', report)!.toString('utf8')
  const actual = auditConclusionOf(text)
  if (!actual) throw new Error('审计报告里找不到结论行，不能拿它当门记录依据: ' + report)
  if (actual !== artifact.conclusion) {
    throw new Error('审计报告结论与门记录结论不符：报告=' + actual + '，门记录=' + String(artifact.conclusion))
  }
}

function checkCandidate(artifact: Record<string, unknown>, spec: { scopeBase: string; excludes: string[] }, root: string): void {
  const { paths, files } = candidateEntries(root, spec)
  const candidate = sha256Hex(canonicalJson(files))
  const scope = sha256Hex(canonicalJson(paths))
  if (artifact.candidate_hash !== candidate) {
    throw new Error('candidate_hash 与候选文件不符：' + String(artifact.candidate_hash).slice(0, 16) + '… != ' + candidate.slice(0, 16) + '…')
  }
  if (artifact.change_scope_hash !== scope) {
    throw new Error('change_scope_hash 与改动清单不符：' + String(artifact.change_scope_hash).slice(0, 16) + '… != ' + scope.slice(0, 16) + '…')
  }
}

// 门的治理字段也要验：例外得写清码/类型/HTTP，回滚得能执行，批准人和产出者不能空（审计 N-09）
function checkGovernance(artifact: Record<string, unknown>): void {
  const exceptions = artifact.exceptions
  if (!Array.isArray(exceptions)) throw new Error('exceptions 必须是数组')
  for (const raw of exceptions) {
    const e = raw as Record<string, unknown>
    if (typeof e.code !== 'string' || e.code.length === 0) throw new Error('例外项缺 code: ' + JSON.stringify(raw))
    if (e.type !== 'proposed' && e.type !== 'accepted') throw new Error('例外项 type 只能是 proposed / accepted: ' + String(e.type))
    if (!Number.isInteger(e.status) || (e.status as number) < 400 || (e.status as number) > 599) throw new Error('例外项 status 必须是 4xx/5xx 整数: ' + String(e.status))
    if (typeof e.note !== 'string' || e.note.length === 0) throw new Error('例外项缺 note: ' + e.code)
  }
  const rollback = artifact.rollback
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)) throw new Error('rollback 必须是对象')
  const rb = rollback as Record<string, unknown>
  if (typeof rb.target !== 'string' || rb.target.length === 0) throw new Error('rollback 缺 target')
  if (typeof rb.action !== 'string' || rb.action.length === 0) throw new Error('rollback 缺 action')
  const duration = rb.duration_s ?? rb.max_seconds
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('rollback 的耗时必须是正数')
  const verification = rb.verification ?? rb.verify
  if (typeof verification !== 'string' || verification.length === 0) throw new Error('rollback 缺验证方法')
  if (typeof artifact.approver !== 'string' || !/^human:\S+$/.test(artifact.approver)) throw new Error('approver 必须是 human:<名字>')
  const approvedAt = Date.parse(String(artifact.approved_at))
  if (!Number.isFinite(approvedAt)) throw new Error('approved_at 必须是 ISO 时间: ' + String(artifact.approved_at))
  // G1 到 G5 的主 artifact 由人手工跑，产出者必须是 human（规格 11.3 行 981；审计 R3-05）
  if (artifact.producer !== 'human') throw new Error('producer 必须是 human（规格 11.3 行 981）: ' + String(artifact.producer))
}

export function verifyGateRecord(text: string, opts: { root?: string; allowDirty?: boolean; path?: string; selfCheck?: boolean } = {}): CheckResult {
  const root = resolve(opts.root ?? process.cwd())
  if (!opts.allowDirty && !opts.selfCheck) assertClean(root)
  const blocks = jsonBlocks(text)
  const artifactBlock = blocks.find((b) => b.value !== null && typeof b.value === 'object' && typeof (b.value as { gate?: unknown }).gate === 'string')
  if (!artifactBlock) throw new Error('门记录里找不到 GateArtifact 的 json 块')
  const artifact = artifactBlock.value as Record<string, unknown>
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
  const gate = String(artifact.gate)
  const spec = GATE_SPECS[gate]
  if (!spec) throw new Error('没有这道门的校验规格: ' + gate)
  const gotIds = items.map((i) => i.id)
  if (canonicalJson(gotIds) !== canonicalJson(spec.items)) {
    throw new Error('必过项清单不符：期望 ' + spec.items.join(',') + '，实际 ' + gotIds.join(','))
  }
  checkEvidenceMap(items, spec)
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
  checkGovernance(artifact)
  checkPreviousChain(artifact, spec, root)
  checkAuditAnchor(artifact, root)

  const anchor = /artifact_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 artifact_hash 锚点')
  const expect = sha256Hex(canonicalJson(artifact))
  if (anchor[1] !== expect) throw new Error('artifact_hash 与正文不符：' + anchor[1] + ' != ' + expect)
  const evidence = checkEvidence(blocks, artifact, root)
  const invariants = checkInvariants(blocks, artifact, evidence.entries)
  checkBodyEvidenceTable(text, evidence.entries)
  checkBodyExceptions(text, artifact.exceptions)
  const used = new Set<string>()
  for (const item of items) {
    for (const id of item.evidence_ids ?? []) {
      if (!evidence.entries.some((x) => x.id === id)) throw new Error('必过项 ' + item.id + ' 引用了不存在的证据: ' + id)
      used.add(id)
    }
  }
  for (const id of invariants.used) used.add(id)
  const unused = evidence.entries.map((e) => e.id).filter((id) => !used.has(id))
  if (unused.length > 0) throw new Error('有证据没被任何必过项或不变量引用: ' + unused.join(','))
  checkBodyTable(text, items, spec)
  checkBodyInvariants(text, invariants.list)
  checkCandidate(artifact, spec, root)
  // 正文自锚放在最后：语义错误先报，改过正文的兜底检查最后再兜（审计 R3-08）
  const body = checkBodyHash(text)

  // 门记录本身必须在 HEAD 里：改了没提交的门记录不算数（审计 R3-07）
  if (opts.path && !opts.selfCheck) {
    const head = contentAt(root, 'HEAD', opts.path)
    if (!head) throw new Error('门记录不在 HEAD 里，先提交门记录再校验: ' + opts.path)
    const onDisk = readFileSync(opts.path, 'utf8')
    if (onDisk !== text) throw new Error('校验的正文与磁盘上的门记录不一致: ' + opts.path)
    if (onDisk.replace(/\r\n/g, '\n') !== head.toString('utf8').replace(/\r\n/g, '\n')) {
      throw new Error('门记录与 HEAD 不一致，先提交门记录再校验: ' + opts.path)
    }
  }

  return { gate, artifactHash: expect, bodyHash: body, items: items.length, evidence: evidence.entries.length }
}

if (process.argv[1] && /gate-check\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const path = process.argv[2] ?? 'docs/gates/G1.md'
  try {
    const out = verifyGateRecord(readFileSync(path, 'utf8'), { path })
    console.log('gate ' + out.gate + ' 通过（' + String(out.items) + ' 项必过、' + String(out.evidence) + ' 份证据哈希复核，artifact_hash=' + out.artifactHash.slice(0, 12) + '… body_hash=' + out.bodyHash.slice(0, 12) + '…）')
  } catch (err) {
    console.error('门检查失败：' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  }
}
