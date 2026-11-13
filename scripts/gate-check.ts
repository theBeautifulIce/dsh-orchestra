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
import MarkdownIt from 'markdown-it'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'

export const GATE_FIELDS = [
  'gate', 'schema_version', 'gate_run_id', 'candidate_hash', 'change_scope_hash',
  'evidence_index_hash', 'invariants_hash', 'must_pass_items', 'failed_items', 'conclusion',
  'run_terminal', 'exceptions', 'rollback', 'approver', 'approved_at', 'producer',
  'previous_artifact_hash', 'audit_round', 'audit_report', 'audit_report_sha256',
] as const

export type InvariantSpec = { statement: string; evidence_ids: string[] }

export type GateSpec = {
  items: string[]
  content: Record<string, string>
  invariants: Record<string, InvariantSpec>
  // 每道门固定一张必过项清单：少了、多了、改名都算没过（审计 M4）；正文表的内容列也按这张表核对（审计 N-09）
  evidenceMap: Record<string, string[]>
  // 证据 id 与文件路径也是固定映射：只固定 id 还能把文件换绑后重签（S1 第二轮审计）
  evidenceFiles: Record<string, string>
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
    // 不变量语句与证据也钉死在代码里：只比对 invariants_hash 的话，改写语句后重签仍能过（S1 第八轮 P1-3）
    invariants: {
      I1: { statement: '单写者与 epoch 栅栏：同一个库只有一条写路径，越代次写被拒', evidence_ids: ['ev-epoch'] },
      I10: { statement: '无门记录不进阶：门检查固定必过项清单并重算证据哈希', evidence_ids: ['ev-gatecheck'] },
      I2: { statement: '事件只追加且哈希链能检出篡改', evidence_ids: ['ev-chain'] },
      I3: { statement: '事务失败不留半条记录，CAS 失败无副作用', evidence_ids: ['ev-g01', 'ev-g02'] },
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
    evidenceFiles: {
      'ev-auth': 'tests/auth.spec.ts',
      'ev-backup': 'tests/backup.spec.ts',
      'ev-chain': 'tests/hash-chain.spec.ts',
      'ev-epoch': 'tests/db-open.spec.ts',
      'ev-g01': 'docs/gates/evidence/G1/G-01.md',
      'ev-g02': 'docs/gates/evidence/G1/G-02.md',
      'ev-g08': 'docs/gates/evidence/G1/G-08.md',
      'ev-g09': 'docs/gates/evidence/G1/G-09.md',
      'ev-g14': 'docs/gates/evidence/G1/G-14.md',
      'ev-g15': 'docs/gates/evidence/G1/G-15.md',
      'ev-gatecheck': 'tests/gate-check.spec.ts',
      'ev-migrate': 'tests/migrate.spec.ts',
      'ev-phase': 'tests/config.spec.ts',
    },
    scopeBase: '623939d4c0a7123835b525287035588ee291ccbe',
    // handoff 是活文档，每次收尾都会改；它进候选范围会让门哈希随一次文档更新失效（审计 F-02）
    excludes: ['docs/gates/G1.md', 'docs/gates/G2.md', 'docs/audits', 'docs/reviews', 'handoff.md'],
    prevGate: null,
    gateFile: 'docs/gates/G1.md',
  },
  G2: {
    items: ['G2-01', 'G2-02', 'G2-03', 'G2-04', 'G2-05', 'G2-06', 'G2-07', 'G-03', 'G-04', 'G-05', 'G-07', 'G2-08', 'G2-09', 'G2-10', 'G2-11', 'G2-12', 'G2-13', 'G2-14', 'G2-15'],
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
      'G2-15': '同一工作流版本跨重启不可改写，在飞 run 的判定条件不跟着变',
    },
    invariants: {
      I1: { statement: '一个 node_run 最多一个终态：所有迁移带 CAS，终态不再接受普通出口', evidence_ids: ['ev-g2-01', 'ev-g2-02', 'ev-g2-04', 'ev-g2-05'] },
      I2: { statement: '账本只追加：已提交事件不改写，节点迁移都留事件', evidence_ids: ['ev-g2-04', 'ev-g2-g05'] },
      I3: { statement: '所有迁移带 CAS，CAS 失败不产生副作用', evidence_ids: ['ev-g2-03', 'ev-g2-g04'] },
      I4: { statement: '每个终态有对应证据，证据不足不入完成账', evidence_ids: ['ev-g2-05', 'ev-g2-08', 'ev-g2-10', 'ev-g2-g07'] },
      I5: { statement: '卡住必须挂裁决卡；没有决策卡就不许阻塞', evidence_ids: ['ev-g2-06'] },
      I6: { statement: '判定时限只认 boot_id 与单调纳秒：墙钟跳变、跨 boot、没有锚点都判不确定，不自动判超时', evidence_ids: ['ev-g2-09'] },
      I7: { statement: '同一 report_id 的同类事件只留一条：重试不许把账本刷膨胀', evidence_ids: ['ev-g2-11'] },
      I8: { statement: '工具授权只认 workflow 定义：请求体带来的策略不参与判定，越权与未注册在租约前被拒', evidence_ids: ['ev-g2-12'] },
      I9: { statement: '单写者锁与 epoch 围栏：第二写者拿不到锁，旧 epoch 的连接写不进', evidence_ids: ['ev-g2-13'] },
      I10: { statement: '长动作靠心跳续租：租约 2 秒、动作 3 秒时 2.5 秒扫描不判过期', evidence_ids: ['ev-g2-14'] },
      I11: { statement: '工作流定义跨重启落库：同一版本改写被拒，在飞 run 的判定条件不跟着变', evidence_ids: ['ev-g2-15'] },
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
      'G2-15': ['ev-g2-15'],
    },
    evidenceFiles: {
      'ev-g2-01': 'docs/gates/evidence/G2/ev-g2-01.md',
      'ev-g2-02': 'docs/gates/evidence/G2/ev-g2-02.md',
      'ev-g2-03': 'docs/gates/evidence/G2/ev-g2-03.md',
      'ev-g2-04': 'docs/gates/evidence/G2/ev-g2-04.md',
      'ev-g2-05': 'docs/gates/evidence/G2/ev-g2-05.md',
      'ev-g2-06': 'docs/gates/evidence/G2/ev-g2-06.md',
      'ev-g2-07': 'docs/gates/evidence/G2/ev-g2-07.md',
      'ev-g2-g03': 'docs/gates/evidence/G2/G-03.md',
      'ev-g2-g04': 'docs/gates/evidence/G2/G-04.md',
      'ev-g2-g05': 'docs/gates/evidence/G2/G-05.md',
      'ev-g2-g07': 'docs/gates/evidence/G2/G-07.md',
      'ev-g2-08': 'docs/gates/evidence/G2/ev-g2-08.md',
      'ev-g2-09': 'docs/gates/evidence/G2/ev-g2-09.md',
      'ev-g2-10': 'docs/gates/evidence/G2/ev-g2-10.md',
      'ev-g2-11': 'docs/gates/evidence/G2/ev-g2-11.md',
      'ev-g2-12': 'docs/gates/evidence/G2/ev-g2-12.md',
      'ev-g2-13': 'docs/gates/evidence/G2/ev-g2-13.md',
      'ev-g2-14': 'docs/gates/evidence/G2/ev-g2-14.md',
      'ev-g2-15': 'docs/gates/evidence/G2/ev-g2-15.md',
    },
    scopeBase: '4f3ada7',
    excludes: ['docs/gates/G1.md', 'docs/gates/G2.md', 'docs/audits', 'docs/reviews', 'handoff.md'],
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

function checkEvidence(blocks: Block[], artifact: Record<string, unknown>, root: string, spec: GateSpec): { entries: EvidenceEntry[]; hash: string } {
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
    // id 的文件路径固定：只固定 id 的话，换一份同名文件再重签仍能过（S1 第二轮审计）
    const expectedFile = spec.evidenceFiles[e.id]
    if (!expectedFile) throw new Error('证据 id 不在固定映射里: ' + e.id)
    if (e.file !== expectedFile) throw new Error('证据 ' + e.id + ' 的文件与固定映射不一致（换绑证据不许重签）：' + e.file + ' != ' + expectedFile)
    // 证据也读 HEAD：工作树里改证据但没提交，不能拿来签门（审计 N-09）
    const head = contentAt(root, 'HEAD', e.file)
    if (!head) throw new Error('证据文件不在 HEAD 里，先提交证据再签门: ' + e.id)
    // 证据按 LF 归一的字节算哈希：仓库 checkout 的换行风格不同也得到同一个值
    const actual = sha256Hex(head.toString('utf8').replace(/\r\n/g, '\n'))
    if (actual !== e.sha256) throw new Error('证据文件 sha256 不符: ' + e.id + '（记录 ' + e.sha256.slice(0, 16) + '… 实际 ' + actual.slice(0, 16) + '…）')
    entries.push({ id: e.id, file: e.file, sha256: actual })
  }
  for (const id of Object.keys(spec.evidenceFiles).sort()) {
    if (!seen.has(id)) throw new Error('固定证据映射里的 ' + id + ' 没有出现在 evidence-index')
  }
  const sorted = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = sha256Hex(canonicalJson(sorted))
  if (artifact.evidence_index_hash !== hash) {
    throw new Error('evidence_index_hash 与证据索引不符：' + String(artifact.evidence_index_hash).slice(0, 16) + '… != ' + hash.slice(0, 16) + '…')
  }
  return { entries, hash }
}

function checkInvariants(blocks: Block[], artifact: Record<string, unknown>, entries: EvidenceEntry[], spec: GateSpec): { used: Set<string>; hash: string; list: InvariantEntry[] } {
  const raw = blockOf(blocks, 'invariants').value
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invariants 为空')
  const list: InvariantEntry[] = []
  const used = new Set<string>()
  const seen = new Set<string>()
  for (const e of raw as InvariantEntry[]) {
    if (typeof e.id !== 'string' || typeof e.statement !== 'string' || !Array.isArray(e.evidence_ids) || e.evidence_ids.length === 0) {
      throw new Error('invariants 的项要有 id / statement / evidence_ids：' + JSON.stringify(e))
    }
    if (seen.has(e.id)) throw new Error('invariants 里 id 重复: ' + e.id)
    seen.add(e.id)
    // 语句与证据按固定口径比对：只核哈希等于让改写后的清单自己证明自己（S1 第八轮 P1-3）
    const want = spec.invariants[e.id]
    if (!want) throw new Error('不变量 id 不在固定口径里: ' + e.id)
    if (e.statement !== want.statement) {
      throw new Error('不变量 ' + e.id + ' 的语句与固定口径不一致（改写或削短都要重新审计）')
    }
    const wantEvidence = want.evidence_ids.slice().sort()
    const givenEvidence = e.evidence_ids.slice().sort()
    if (givenEvidence.length !== wantEvidence.length || givenEvidence.some((id, i) => id !== wantEvidence[i])) {
      throw new Error('不变量 ' + e.id + ' 的证据与固定口径不一致')
    }
    for (const id of e.evidence_ids) {
      if (!entries.some((x) => x.id === id)) throw new Error('不变量引用了不存在的证据: ' + id)
      used.add(id)
    }
    list.push({ id: e.id, statement: e.statement, evidence_ids: givenEvidence })
  }
  const expectedIds = Object.keys(spec.invariants).sort()
  const givenIds = list.map((x) => x.id).sort()
  if (givenIds.length !== expectedIds.length || givenIds.some((id, i) => id !== expectedIds[i])) {
    throw new Error('不变量清单与固定口径不一致：要有 ' + expectedIds.join(', '))
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
export function checkBodyEvidenceTable(text: string, entries: EvidenceEntry[]): void {
  const rows = tableRows(text, '## 证据文件与哈希')
  if (rows.length === 0) {
    if (entries.length !== 0) throw new Error('正文「证据文件与哈希」表是空的，但 artifact 列了 ' + String(entries.length) + ' 份证据')
    return
  }
  if (rows.length !== entries.length) throw new Error('正文证据表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(entries.length) + ' 份证据')
  const map = new Map(entries.map((e) => [e.id, e]))
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row[0] ?? ''
    const file = row[1] ?? ''
    const sha = row[2] ?? ''
    if (seen.has(id)) throw new Error('正文证据表里证据重复: ' + id)
    seen.add(id)
    const e = map.get(id)
    if (!e) throw new Error('正文证据表里有 artifact 没有的证据: ' + id)
    if (e.file !== file) throw new Error('正文证据表里 ' + id + ' 的文件与 artifact 不一致: ' + file + ' != ' + e.file)
    if (e.sha256 !== sha) throw new Error('正文证据表里 ' + id + ' 的 sha256 与 artifact 不一致（证据被改过或表没跟着改）')
  }
  // 只查行数和“表里每行都能在 artifact 找到”还不够：删一行再复制另一行，行数不变但证据被换掉（S1 第四轮审计 P2-1）
  for (const e of entries) {
    if (!seen.has(e.id)) throw new Error('正文证据表缺 artifact 里的证据: ' + e.id)
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
export function checkBodyInvariants(text: string, list: InvariantEntry[]): void {
  const rows = tableRows(text, '## 不变量')
  if (rows.length === 0) {
    if (list.length !== 0) throw new Error('正文「不变量」表是空的，但 artifact 列了 ' + String(list.length) + ' 条')
    return
  }
  if (rows.length !== list.length) throw new Error('正文不变量表有 ' + String(rows.length) + ' 行，artifact 列了 ' + String(list.length) + ' 条')
  const map = new Map(list.map((i) => [i.id, i]))
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row[0] ?? ''
    if (seen.has(id)) throw new Error('正文不变量表里不变量重复: ' + id)
    seen.add(id)
    const item = map.get(id)
    if (!item) throw new Error('正文不变量表里有 artifact 没有的不变量: ' + id)
    if ((row[1] ?? '') !== item.statement) throw new Error('正文不变量表里 ' + id + ' 的说明与 artifact 不一致')
    const got = (row[2] ?? '').split(/[,，\s]+/).filter((s) => s.length > 0 && s !== '无').slice().sort().join(',')
    const want = item.evidence_ids.slice().sort().join(',')
    if (got !== want) throw new Error('正文不变量表里 ' + id + ' 的证据与 artifact 不一致: ' + got + ' != ' + want)
  }
  // 同上：删一行再复制另一行会骗过行数核对（S1 第四轮审计 P2-1）
  for (const item of list) {
    if (!seen.has(item.id)) throw new Error('正文不变量表缺 artifact 里的不变量: ' + item.id)
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

// 审计报告正文里的结论：只认顶层、未被隐藏的结论行，且全文只能有一个结论。
// 可见性：HTML 注释、details/pre/script/style/template、围栏代码、四空格缩进、引用围栏都不参与；
// 普通引用块里的结论仍可见（S1 第八轮 P1-4）。
// 用真实 Markdown 解析器取“渲染后可见的正文行”：链接目标/title、围栏代码、
// 缩进代码、引用定义、原始 HTML 都不进正文；实体与 Unicode 由解析器归一。
// 之前靠正则模拟 CommonMark，S2 第二十轮 13 条 P0 全是渲染差异；这里直接对齐渲染器。
const AUDIT_MARKDOWN = new MarkdownIt({ html: true, linkify: false, typographer: false })

function renderedAuditLines(text: string): string[] | null {
  const lines: string[] = []
  let buffer = ''
  let ambiguous = false
  let paragraphHasLink = false
  const flush = (): void => {
    if (buffer.trim() === '') {
      buffer = ''
      paragraphHasLink = false
      return
    }
    // 链接所在段落里出现“结论：”时，可见正文可能只剩前缀而方括号已被解析掉；
    // 这类段落按歧义处理，不能让另一段干净 pass 过门（S1 第十三轮 P1）。
    if (paragraphHasLink && /(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(buffer)) ambiguous = true
    for (const line of buffer.split('\n')) lines.push(normalizeAuditLine(line))
    buffer = ''
    paragraphHasLink = false
  }
  const invisibleHtml = (html: string): boolean | null => {
    const body = html.trimStart()
    if (body.startsWith('<!--')) {
      const end = body.indexOf('-->')
      // 注释后面同一块里若还有正文，渲染器会显示，不能整块当隐藏。
      return end < 0 ? null : body.slice(end + 3).trim() === '' ? true : null
    }
    if (body.startsWith('<?')) {
      const end = body.indexOf('?>')
      return end < 0 ? null : body.slice(end + 2).trim() === '' ? true : null
    }
    if (body.startsWith('<![CDATA[')) {
      const end = body.indexOf(']]>')
      return end < 0 ? null : body.slice(end + 3).trim() === '' ? true : null
    }
    if (/^<!DOCTYPE\b/i.test(body)) return /^<!DOCTYPE[^>]*>\s*$/i.test(body.trim()) ? true : null
    return false
  }
  // 单独一两个反引号是未闭合的行内代码，渲染器会把它当字面量，
  // 但跨块的结论行不能被它“证明可见”；按歧义拒绝（S1 第十四轮补）。
  if (/(?:^|\n)[ \t]*`{1,2}[ \t]*(?=\n[ \t]*\n)/.test(text)) return null
  // 引用块里的缩进是否可见由 markdown-it 自己判：引用标记吃掉一个空格后，
  // 剩 3 个空格仍是引用段落（可见），剩 4 个才是缩进代码。手工清行会把
  // `> 引用\n>    结论：fail` 这种续行误藏（S1 第十七轮 P1-A）。
  const source = text.replace(/\r\n/g, '\n')
  const tokens = AUDIT_MARKDOWN.parse(source, {})
  for (const token of tokens) {
    if (token.type === 'html_block') {
      const hidden = invisibleHtml(token.content)
      if (hidden === true) continue
      return null
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      flush()
      continue
    }
    if (token.type !== 'inline') {
      if (token.type.endsWith('_open') || token.type.endsWith('_close') || token.type === 'hr') flush()
      continue
    }
    for (const child of token.children ?? []) {
      if (child.type === 'html_inline') {
        const hidden = invisibleHtml(child.content)
        if (hidden === true) continue
        return null
      }
      if (child.type === 'code_inline') {
        // 行内代码在渲染里是可见文字；把内容并回可见行，
        // 不能让「结论\`:\`fail」「结\`论\`：fail」被拆开漏掉（S1 第十七轮 P1-B）。
        buffer += child.content
      } else if (child.type === 'image') {
        // 图片加载失败时浏览器会显示 alt 文本；alt 里出现 fail 结论按歧义拒绝。
        // alt 里的实体要先解码，标签（如 <wbr>）和不可见字符不能把结论拆开（S1 第二十轮 P0-2）。
        const alt = normalizeAuditLine(
          AUDIT_MARKDOWN.utils.unescapeAll(child.content).replace(/<[^>]*>/g, ''),
        )
        if (visibleFailStatement(alt)) ambiguous = true
        paragraphHasLink = true
      } else if (child.type === 'link_open' || child.type === 'link_close') {
        paragraphHasLink = true
      } else if (child.type === 'text' || child.type === 'text_special') {
        buffer += child.content
      } else if (child.type === 'softbreak') {
        // 门记录按“源码行”核对结论与绑定；软换行保留为行边界，和既有报告格式一致。
        flush()
      } else if (child.type === 'hardbreak') {
        flush()
      }
      // code_inline / image / link_open / link_close / 强调标记都不产生可见正文。
    }
  }
  flush()
  return ambiguous ? null : lines
}

// 可见正文里的“本报告不通过 / 本次审计结论为 fail”这类判断句。
// 先做 NFKC、去撇号、丢不可见字符，把空白与标点统一成 |，再让主语/连接词/
// 结论词允许任意 | 夹层；这样五行拆词、零宽、全角、连接号、引号都不能绕过。
// 结论词后只接受结尾、分隔符或「需应已的了」，所以「不通过项」「未通过验收」
// 这类叙述仍不误杀（S1 第十八至二十轮）。
const FAIL_SUBJECTS = [
  '本次独立审计', '审计意见', '审核意见', '复核意见', '评审意见',
  '审计结论', '审核结论', '复核结论', '评审结论',
  '审计结果', '审核结果', '复核结果', '评审结果',
  '最终结论', '最终判定', '审计报告', '审核报告', '复核报告', '评审报告',
  '本报告', '本次审计', '本轮审计', '本次复核', '本次评审', '该报告', '此报告', '本审计',
  // 繁體主语同样不做简繁转换（S1 第二十轮 P1-1）。
  '本報告', '本次審計', '本輪審計', '本次復核', '本次評審', '該報告', '此報告', '本審計',
  '審計報告', '審核報告', '復核報告', '評審報告', '審計意見', '審核意見', '復核意見', '評審意見',
  '審計結論', '審核結論', '復核結論', '評審結論', '審計結果', '審核結果', '復核結果', '評審結果',
  '最終結論', '最終判定',
  '审计', '审核', '复核', '评审', '结论', '判定', '審計', '審核', '復核', '評審', 'audit', 'review',
  'auditor', 'reviewer', '審計師',
].sort((a, b) => b.length - a.length)

const FAIL_VERDICTS = [
  '未得到通过', '没有得到通过', '未能通过', '没有通过', '并未通过', '未获通过', '未予通过',
  '不能通过', '不是通过', '通不过', '不通过', '未通过', '没通过',
  // 繁體否定词：NFKC 不做简繁转换，必须单独列出（S1 第二十轮 P1-1）。
  '未得到通過', '沒有得到通過', '未能通過', '沒有通過', '並未通過', '未獲通過', '未予通過',
  '不能通過', '不是通過', '通不過', '不通過', '未通過', '沒通過',
  '不合格', '未成功', '不成功', '未过关', '没过', '不批准', '未批准', '失败',
  '未過關', '沒過', '失敗',
  'not successful', 'not succeeded', 'not succeed', 'not passed', 'not pass',
  'didnt pass', 'didnt succeed', 'wasnt pass', 'isnt pass',
  'unsuccessful', 'failure', 'failed', 'fails', 'fail',
  'rejected', 'reject', 'denied', 'deny', 'no pass',
  'refused', 'refusal',
  // 无法/不予/未获批准/未达标/被否决/被驳回等常见否定式（S2 第二十五轮 P0-1/P2-1）。
  '无法予以通过', '无法通过', '不予通过', '不获通过', '未获批准', '不获批准', '不予批准',
  '未达到通过标准', '未达标', '不达标', '未通过验收', '不通过验收', '未获审批', '不获审批',
  '被否决', '遭否决', '被驳回', '遭驳回', '被拒绝', '没能通过',
  'cannot pass', 'unable to pass', 'not approved', 'not approve', 'did not approve',
  'failed to pass', 'refused to pass', 'no approval', 'denied approval',
  // S1 第二十一轮 P0：缩写否定、批准类否定与繁體带宾语写法。
  'doesnt pass', 'doesnt approve', 'wont pass', 'wont approve', 'hasnt passed',
  'hasnt approved', 'havent passed', 'isnt passing', 'isnt approved', 'wasnt approved',
  'didnt approve', 'not passing', 'not approved',
  '未通過驗收', '不通過驗收', '未通過評審', '未通過審核', '被駁回', '被否決',
].sort((a, b) => b.length - a.length)

const FAIL_CONNECTORS = [
  '审计意见', '审核意见', '复核意见', '评审意见',
  '审计结论', '审核结论', '复核结论', '评审结论',
  '审计结果', '审核结果', '复核结果', '评审结果',
  '最终结论', '最终判定', 'conclusions', 'conclusion', 'outcome',
  '结果', '结论', '判定', '意见', '经过', '审计', '审核', '复核', '评审',
  '报告', '報告', '最终', '最終', '依然', '还是', '总的', 'results', 'result', 'report', 'review',
  '審計', '審核', '復核', '評審', '結果', '意見',
  'audit', 'was', 'were', 'has', 'have', 'had', 'been', 'did', 'does', 'do',
  'is', 'are', 'to', 'the', 'a', 'an', '经', '后', '仍', '为', '是', '的',
].sort((a, b) => b.length - a.length)

function regexEscape(ch: string): string {
  return ch.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
}

// 允许任意不可见/标点夹层：每个字符之间插 \|*。
function sepPattern(token: string): string {
  return Array.from(token).filter((ch) => !/\s/u.test(ch)).map(regexEscape).join('\\|*')
}

const HOMOGLYPHS: Record<string, string> = {
  // 西里尔/希腊同形字：先把“看起来是拉丁字母”的码位折回 ASCII，
  // 否则 fаil、pаss 这类写法会绕过词表（S2 第二十五轮 P2-1）。
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l',
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'κ': 'k', 'χ': 'x', 'ι': 'i',
  'ε': 'e', 'τ': 't', 'υ': 'u', 'γ': 'y',
}

function foldHomoglyphs(text: string): string {
  return Array.from(text).map((ch) => HOMOGLYPHS[ch] ?? ch).join('')
}

function foldForVerdict(raw: string): string {
  const text = foldHomoglyphs(raw.normalize('NFKC').toLowerCase()).replace(/[\u2019\u00B4']/g, '')
  let out = ''
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!
    if (/[\p{Cf}\p{Mn}\p{Me}]/u.test(ch)) continue
    // 汉字中间夹一个同形拉丁/西里尔/希腊字母时（未通о过），按汉字词处理：
    // 不把它当成分隔符，否则一个字符就能把“未通过”拆开（S1 第二十一轮 P0-5）。
    if (/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(ch)
      && /[\u4e00-\u9fff]$/u.test(out)
      && /[\u4e00-\u9fff]/u.test(chars[i + 1] ?? '')) continue
    // 修饰字母形的冒号/连接号（U+02D0、U+A789）属于 Lm，不能当普通字母留下。
    if ('\u02D0\uA789\u2236\uFE13\uFE55\uFF1A:\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE63\uFF0D\u2043'.includes(ch)) {
      out += '|'
      continue
    }
    if (/\s/u.test(ch)) {
      out += '|'
      continue
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out += ch
      continue
    }
    out += '|'
  }
  return out.replace(/\|+/g, '|').replace(/^\|+|\|+$/g, '')
}

const FAIL_VERDICT_RE = new RegExp('^(?:' + FAIL_VERDICTS.map(sepPattern).join('|') + ')')
const FAIL_CONNECTOR_RES = FAIL_CONNECTORS.map((token) => ({ token, re: new RegExp('^' + sepPattern(token)) }))

// 结构化否定：否定词 + 可选填充词 + 通过类谓词 + 可选对象。
// 这样“未达到通过标准”“无法予以通过”“被驳回”不必逐条入表，
// 同时“未通过项为 0”仍因尾部不是句末而放行。
const FAIL_NEGATIONS = [
  'refused to', 'failed to', 'unable to', 'did not', 'didnt', 'was not', 'wasnt',
  'is not', 'isnt', 'has not', 'hasnt', 'have not', 'havent', 'does not', 'doesnt',
  'will not', 'wont', 'do not', 'dont', 'cannot', 'cant', 'never',
  '无法', '没能', '没有', '未能', '未获', '未予', '不予', '不获', '不得', '不能', '不可',
  '不是', '并非', '遭', '被', '未', '不', '没', '无', 'not', 'no',
].sort((a, b) => b.length - a.length)
const FAIL_FILLERS = [
  'be able to', 'able to', '得到', '获得', '予以', '能够', '达到', '经过',
  '获', '能', 'be', 'to', 'the', 'a',
].sort((a, b) => b.length - a.length)
const FAIL_PASS_STEMS = [
  '通过', '批准', '达标', '合格', '成功', '过关', '许可', '认可', '同意',
  '否决', '驳回', '拒绝', 'approval', 'approved', 'approve', 'passing', 'passed',
  'succeed', 'succeeded', 'success', 'accepted', 'accept', 'pass', 'meet', 'met',
  // 繁體谓词（S1 第二十一轮 P0-1）。
  '通過', '達標', '過關', '許可', '認可', '否決', '駁回', '拒絕', '獲批', '获批',
].sort((a, b) => b.length - a.length)
const FAIL_OBJECTS = ['验收', '标准', '审批', '评审', '审核', '考核', '许可', '批准', '认可',
  '驗收', '標準', '審批', '評審', '審核', '許可', '認可']
  .sort((a, b) => b.length - a.length)

function prefixRes(tokens: readonly string[]): { token: string; re: RegExp }[] {
  return tokens.map((token) => ({ token, re: new RegExp('^' + sepPattern(token)) }))
}
const FAIL_NEG_RES = prefixRes(FAIL_NEGATIONS)
const FAIL_FILLER_RES = prefixRes(FAIL_FILLERS)
const FAIL_STEM_RES = prefixRes(FAIL_PASS_STEMS)
const FAIL_OBJECT_RES = prefixRes(FAIL_OBJECTS)

function matchPrefix(rest: string, resources: { token: string; re: RegExp }[]): string | null {
  // 词与词之间允许任意 | 夹层：先跳过夹层再匹配，否则
  // “is not passing”“未|通过|验收”会在第二个词前被 | 挡住（S1 第二十一轮 P0-3）。
  const lead = /^\|*/.exec(rest)?.[0].length ?? 0
  const body = rest.slice(lead)
  for (const resource of resources) {
    const match = resource.re.exec(body)
    if (match) return rest.slice(0, lead) + match[0]
  }
  return null
}

function matchStructuralNegative(rest: string): string | null {
  const neg = matchPrefix(rest, FAIL_NEG_RES)
  if (!neg) return null
  let pos = neg.length
  for (let guard = 0; guard < 2; guard += 1) {
    const filler = matchPrefix(rest.slice(pos), FAIL_FILLER_RES)
    if (!filler) break
    pos += filler.length
  }
  const pred = matchPrefix(rest.slice(pos), FAIL_STEM_RES)
  if (!pred) return null
  pos += pred.length
  const obj = matchPrefix(rest.slice(pos), FAIL_OBJECT_RES)
  if (obj) pos += obj.length
  return rest.slice(0, pos)
}
const FAIL_SUBJECT_RE = new RegExp(FAIL_SUBJECTS.map(sepPattern).join('|'), 'g')
const FAIL_SUBJECT_NO_BARE_RE = new RegExp(
  FAIL_SUBJECTS.filter((s) => s !== '结论' && s !== '判定').map(sepPattern).join('|'),
  'g',
)

type FailScan = { bareConclusion?: 'any' | 'never' }

function scanFailStatement(folded: string, scan: FailScan): boolean {
  if (folded.length === 0) return false
  const subjectRe = scan.bareConclusion === 'never' ? FAIL_SUBJECT_NO_BARE_RE : FAIL_SUBJECT_RE
  subjectRe.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = subjectRe.exec(folded)) !== null) {
    let pos = sm.index + sm[0].length
    // 连接词不限次数：只要求每次真的前进，长度有限所以必然收敛（S1 第二十一轮 P0-6）。
    for (let guard = 0; guard <= folded.length; guard += 1) {
      while (folded[pos] === '|') pos += 1
      const rest = folded.slice(pos)
      const vm = FAIL_VERDICT_RE.exec(rest)
      if (vm) {
        const next = folded[pos + vm[0].length] ?? ''
        if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
      }
      const structural = matchStructuralNegative(rest)
      if (structural) {
        const next = folded[pos + structural.length] ?? ''
        if (next === '' || next === '|' || /[需应已的了]/.test(next)) return true
      }
      let advanced = false
      for (const connector of FAIL_CONNECTOR_RES) {
        const cm = connector.re.exec(rest)
        if (cm) {
          pos += cm[0].length
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
  }
  return false
}

// 历史叙述不是本轮意见：只剔除“上一轮/前一轮/roundN … 本轮已整改”这一小段，
// 同一行里剩余的否定句仍照常扫描（S1 第二十一轮 P1）。
const HISTORICAL_REMEDIATION_RES = [
  /(?:历史记录\s*[：:]?\s*)?(?:上一轮|前一轮|round\s*\d{1,3})\s*(?:审计|審計|检查|复核|评审)?[^。\n]{0,120}?(?:本轮已整改|本轮已修复|本轮已收口|本轮已处理|本轮修复|已整改|已修复|已收口)/gi,
  /(?:the\s+)?previous\s+audit[^.\n]{0,120}?(?:this\s+round\s+is\s+(?:clean|fixed)|remediated)/gi,
]
function stripHistoricalRemediation(text: string): string {
  let out = text
  for (const re of HISTORICAL_REMEDIATION_RES) out = out.replace(re, '')
  return out
}

function visibleFailStatement(line: string, scan: FailScan = {}): boolean {
  return scanFailStatement(foldForVerdict(stripHistoricalRemediation(line)), scan)
}

export function auditConclusionOf(text: string): 'pass' | 'fail' | null {
  const visible = renderedAuditLines(text)
  if (visible === null) return null
  let verdict: 'pass' | 'fail' | null = null
  let inlineFail = false
  const conclusionText = /(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/
  const conclusionWord = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)$/i
  // 先把所有可见行按行边界拼起来做一次全文扫描：跨越任意多行的拆词都能命中。
  if (visibleFailStatement(visible.join('|'))) inlineFail = true
  for (let visibleIndex = 0; visibleIndex < visible.length; visibleIndex += 1) {
    const line = visible[visibleIndex]!
    const strict = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(line)
    const bare = /^(?:pass|fail|通过|不通过)$/i.test(line)
    if (!strict && !bare) {
      // 全文扫描已经在循环外完成；这里只保留链接定义与“结论”/“：fail”拆行的歧义判定。
      // 链接/引用定义段落里的可见“结论：”不能靠另一段干净 pass 洗掉（S2 第二十轮 def-*）；
      // 普通正文里提到“结论：”只是行内引用，不影响后面的正式结论行。
      if (line.includes('[') && conclusionText.test(line)) return null
      // 结论词被换行拆成“结论” + “：fail”时，下一行以冒号开头，按歧义处理。
      if (conclusionWord.test(line.trim())) {
        const next = visible[visibleIndex + 1] ?? ''
        if (/^\s*[：:]/.test(next)) return null
      }
      continue
    }
    // 只允许一行结论：第二行无论同向还是反向都按歧义处理。
    if (verdict !== null) return null
    if (bare) {
      verdict = rawVerdict(line)
      continue
    }
    const m = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]\s*(?:\*\*)?\s*(pass|fail|通过|不通过)(.*)$/i.exec(line)
    if (!m) return null
    const raw = (m[1] ?? '').toLowerCase()
    const v = raw === 'pass' || raw === '通过' ? 'pass' : 'fail'
    if (!validConclusionTail(m[2] ?? '', v)) return null
    verdict = v
  }
  if (verdict === 'pass' && inlineFail) return null
  return verdict
}

// 门记录正文顶部的结论行必须与 GateArtifact 的 conclusion 一致：
// 防止 artifact 写 pass、人读正文却看到 fail（S1 第十七轮 P2-1）。
export function bodyConclusionOf(text: string): 'pass' | 'fail' | null {
  const visible = renderedAuditLines(text)
  if (visible === null) return null
  const found: Array<'pass' | 'fail'> = []
  for (const line of visible) {
    const m = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]\s*(?:\*\*)?\s*(pass|fail|通过|不通过)(?=$|[（(。．.！!？?；;，,、\s])/i.exec(line)
    if (m) found.push(rawVerdict(m[1] ?? ''))
  }
  // 正文不再按 160 字/24 字偏移截窗：长行和靠后的否定句同样能签过（S1 第二十轮 P0-4）。
  // 历史段落里“门记录拿结论为 fail”这类叙述用裸“结论”会误杀，所以全文扫描排除
  // 裸结论主语，只对以“结论/判定”开头的行补一次精确判定。
  if (visibleFailStatement(visible.join('|'), { bareConclusion: 'never' })) return 'fail'
  for (const line of visible) {
    if (/^(?:结论|判定)/.test(line) && visibleFailStatement(line)) return 'fail'
  }
  return found.length === 1 ? found[0]! : null
}

// 审计报告绑定门名与候选提交：只读顶层可见行，防止拿别轮/别门的 pass 报告复用。
// 报告必须各出现一次「门：G1」与「候选提交：<40 位 commit>」（S1 第八轮 P1-2）。
export function auditBindingOf(text: string): { gate: string; commit: string } | null {
  const visible = renderedAuditLines(text)
  if (visible === null) return null
  const gates: string[] = []
  const commits: string[] = []
  for (const line of visible) {
    const gate = /^(?:门|gate)\s*[：:]\s*(G[1-5])\s*$/i.exec(line)
    if (gate) gates.push((gate[1] ?? '').toUpperCase())
    const commit = /^(?:候选提交|候选|candidate_commit|candidate)\s*[：:]\s*([0-9a-f]{40})\s*$/i.exec(line)
    if (commit) commits.push((commit[1] ?? '').toLowerCase())
  }
  if (gates.length !== 1 || commits.length !== 1) return null
  return { gate: gates[0] as string, commit: commits[0] as string }
}

// Markdown 会把 HTML 实体渲染成字符；判定前先按渲染结果解码，否则
// '&#32467;&#35770;&#65306;fail' 这种可见结论会被漏掉（S1 第十五轮补）。
function decodeHtmlEntitiesForInspection(line: string): string {
  return line
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, hex: string, digits: string) => {
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m
      return String.fromCodePoint(code)
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|colon|newline|tab);/gi, (m, name: string) => {
      const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', colon: ':', newline: '\n', tab: '\t' }
      return map[name.toLowerCase()] ?? m
    })
}

// 只返回顶层可见行：去掉隐藏块，跳过围栏/缩进代码/引用围栏，保留普通引用与列表。
function auditTopLevelLines(text: string): string[] {
  const lines = stripHiddenAuditBlocks(text).split(/\r?\n/)
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let quoteFence: { char: string; length: number } | null = null
  for (const rawLine of lines) {
    // Markdown 缩进代码：最多 3 个空格后接 Tab，或 4 个以上空格（空格+Tab 也算）。
    if (/^(?: {0,3}\t| {4,})/.test(rawLine)) continue
    const quote = /^\s*>( ?)([\s\S]*)$/.exec(rawLine)
    if (quote) {
      const inner = quote[2] ?? ''
      // 引用块内的缩进代码同样不可见；引用标记后已吃掉一个空格，剩 3 个空格也算代码。
      if (/^(?: {0,3}\t| {3,})/.test(inner)) continue
      const qf = fenceMarkerOf(inner)
      if (qf) {
        if (!quoteFence) quoteFence = { char: qf.char, length: qf.length }
        else if (qf.char === quoteFence.char && qf.length >= quoteFence.length && qf.rest.trim() === '') quoteFence = null
        continue
      }
      if (quoteFence) continue
    } else if (quoteFence) {
      quoteFence = null
    }
    const fm = fenceMarkerOf(rawLine)
    if (fm) {
      if (!fence) fence = { char: fm.char, length: fm.length }
      else if (fm.char === fence.char && fm.length >= fence.length && fm.rest.trim() === '') fence = null
      continue
    }
    if (fence) continue
    for (const decoded of decodeHtmlEntitiesForInspection(rawLine).split('\n')) out.push(normalizeAuditLine(decoded))
  }
  return out
}

function blankPreservingLines(text: string): string {
  let n = 0
  for (const ch of text) if (ch === '\n') n += 1
  return '\u0000' + '\n'.repeat(n)
}

// CommonMark 的空行只认空格与 Tab；U+00A0、U+2003、U+3000、BOM 等都不是空行。
function isMarkdownBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

// 反引号围栏的 info string 里不能出现反引号；这种行在 CommonMark 里不是围栏。
function fenceMarkerOf(body: string): { char: string; length: number; rest: string } | null {
  const m = /^( {0,3})(\x60{3,}|~{3,})(.*)$/.exec(body)
  if (!m) return null
  const marker = m[2] ?? ''
  const rest = m[3] ?? ''
  if (marker.charAt(0) === '\x60' && rest.includes('\x60')) return null
  return { char: marker.charAt(0), length: marker.length, rest }
}

// 围栏可以开在列表项或引用块里：`- ~~~`、`1. \x60\x60\x60`、`> - ~~~` 的首行
// 去掉容器前缀后才是围栏标记。只对“开栏”去掉列表标记；关栏时不能去，
// 否则围栏内容里的 `- ~~~` 会被误当成关栏，后面的隐藏段落就会漏出来（S1 第十六轮 P1-1）。
function stripQuoteContainer(line: string): string | null {
  const q = /^ {0,3}> ?/.exec(line)
  return q ? line.slice(q[0].length) : null
}

function stripListContainer(body: string): string | null {
  const l = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(body)
  return l ? body.slice(l[0].length) : null
}

function openingFenceInContainer(line: string): { char: string; length: number; quoted: boolean } | null {
  let body = line
  let quoted = false
  const quotedBody = stripQuoteContainer(body)
  if (quotedBody !== null) {
    quoted = true
    body = quotedBody
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = stripListContainer(body)
    if (inner === null) break
    body = inner
  }
  const marker = fenceMarkerOf(body)
  return marker ? { char: marker.char, length: marker.length, quoted } : null
}

function closesFenceInContainer(
  line: string,
  fence: { char: string; length: number; quoted: boolean },
): boolean {
  let body = line
  if (fence.quoted) {
    const quotedBody = stripQuoteContainer(body)
    if (quotedBody === null) return false
    body = quotedBody
  } else if (stripQuoteContainer(body) !== null) {
    // 未加引用的围栏内容里，以 `>` 开头的行仍是内容，不是关栏。
    return false
  }
  const marker = fenceMarkerOf(body)
  // 关闭围栏的后缀只允许空格或 Tab；NBSP、U+3000、U+FEFF 都不是 CommonMark 空白。
  return marker !== null
    && marker.char === fence.char
    && marker.length >= fence.length
    && /^[ \t]*$/.test(marker.rest)
}

// 围栏代码整段不可见：里面的字面标签不能参与 HTML 配对（S1 第十轮 P1-1）。
function maskFencedAuditCode(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { char: string; length: number; quoted: boolean } | null = null
  for (const line of lines) {
    if (fence) {
      if (fence.quoted && stripQuoteContainer(line) === null) {
        fence = null
      } else {
        out.push(blankPreservingLines(line))
        if (closesFenceInContainer(line, fence)) fence = null
        continue
      }
    }
    const opening = openingFenceInContainer(line)
    if (opening) {
      fence = opening
      out.push(blankPreservingLines(line))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// 缩进代码里的标签同样只是字面文本。
// 但四空格缩进在列表项里只是续行，渲染器仍显示；段落中间的四空格也不是代码。
// 只有“空行之后、且不在列表里”的缩进块才是确定的代码块；其余缩进块里出现结论行
// 就不能静默藏掉，否则可见的 fail 会被另一段 pass 洗掉（S1 第十五轮 P1-C）。
function maskIndentedAuditCode(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const out: string[] = []
  let poisoned = false
  let inList = false
  let previousBlank = true
  let pending: string[] = []
  let pendingPoisonable = false
  const flush = (): void => {
    if (pending.length === 0) return
    if (pendingPoisonable) {
      const joined = pending.join('\n')
      if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(joined) || pending.some((l) => /^(?:pass|fail|通过|不通过)$/i.test(l))) poisoned = true
    }
    pending = []
  }
  for (const line of lines) {
    const quote = /^\s*>\s?/.exec(line)
    const body = quote ? line.slice(quote[0].length) : line
    const blank = isMarkdownBlankLine(line)
    const indented = /^(?: {0,3}\t| {4,})/.test(body)
    if (!indented) {
      flush()
      if (!blank) {
        if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(body)) {
          inList = true
        } else if (previousBlank && /^[^ \t]/.test(body)) {
          // 空行后回到顶格的普通段落/标题，列表已经结束。
          inList = false
        }
      }
      previousBlank = blank
      out.push(line)
      continue
    }
    if (pending.length === 0) pendingPoisonable = inList || !previousBlank
    pending.push(normalizeAuditLine(body))
    previousBlank = false
    out.push(blankPreservingLines(line))
  }
  flush()
  return { masked: out.join('\n'), poisoned }
}

// 行内代码会把标签转义成字面文本；先整段抹掉，避免假的闭合标签提前收掉隐藏块。
function maskInlineCodeInParagraph(text: string): { masked: string; poisoned: boolean } {
  let out = ''
  let poisoned = false
  let i = 0
  while (i < text.length) {
    if (text.charAt(i) !== '\x60') {
      out += text.charAt(i)
      i += 1
      continue
    }
    let j = i
    while (text.charAt(j) === '\x60') j += 1
    const width = j - i
    let k = j
    let close = -1
    while (k < text.length) {
      if (text.charAt(k) === '\x60') {
        let q = k
        while (text.charAt(q) === '\x60') q += 1
        if (q - k === width) {
          close = q
          break
        }
        k = q
      } else {
        k += 1
      }
    }
    if (close < 0) {
      out += text.slice(i, j)
      i = j
      continue
    }
    // 反引号跨行时，CommonMark 仍可能因块边界把两端拆开；一旦这段被判成代码，
    // 里面的结论行就会被藏掉。跨行代码段里只要出现结论行就毒化，宁可不可判定，
    // 也不让被藏起来的 fail 输给另一段可见的 pass（S1 第十五轮补）。
    const raw = text.slice(i, close)
    if (raw.includes('\n')) {
      for (const line of raw.split('\n')) {
        const normalized = normalizeAuditLine(line)
        if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(normalized) || /^(?:pass|fail|通过|不通过)$/i.test(normalized)) {
          poisoned = true
          break
        }
      }
    }
    out += blankPreservingLines(raw)
    i = close
  }
  return { masked: out, poisoned }
}

// 行内代码不能跨空行；先按 CommonMark 段落切开，再在段内配对反引号。
// 否则前段一个孤立反引号会和后段链接 title 里的反引号配对，把真实的 '[' 一起抹掉（S1 第十四轮 P1-2）。
function maskInlineAuditCode(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let poisoned = false
  const flush = (): void => {
    if (paragraph.length === 0) return
    const part = maskInlineCodeInParagraph(paragraph.join('\n'))
    out.push(...part.masked.split('\n'))
    poisoned = poisoned || part.poisoned
    paragraph = []
  }
  for (const line of lines) {
    if (isMarkdownBlankLine(line)) {
      flush()
      out.push(line)
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return { masked: out.join('\n'), poisoned }
}

// 合法 CDATA 段不参与渲染；检查隐藏段里的结论字样时先剔掉这些段，
// 否则 CDATA 里的 pass 会被误判为毒化（S1 第十四轮 P2-1）。
function stripCdataSpansForInspection(lines: string[]): string[] {
  const text = lines.join('\n')
  const lower = text.toLowerCase()
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = lower.indexOf('<![cdata[', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    const end = lower.indexOf(']]>', start + 9)
    // 未闭合的 CDATA 不剔除：保留原文，让毒化逻辑兜底，避免隐藏段里的 fail 被静默放过。
    if (end < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const hidden = text.slice(start, end + 3)
    out += '\n'.repeat((hidden.match(/\n/g) ?? []).length)
    cursor = end + 3
  }
  return out.split('\n')
}

// 链接目标、title、图片 alt 与引用定义都不参与正文渲染，里面写标签也不能生效。
// 这些结构都只能在同一个段落内跨行（CommonMark 不允许空行），所以按段落整体隐藏：
// 宁可把同段的可见文字也藏掉，也不把渲染器隐藏的结论放进来（fail-closed）。
function visibleTextOfLinkParagraph(text: string): string {
  const kept: string[] = []
  let inDefinition = false
  let atParagraphStart = true
  for (const line of text.split('\n')) {
    // CommonMark 只把段落开头的方括号定义当引用定义；段落中间同形状的行是可见正文，
    // 不能整行删掉，否则 title 里写结论的可见 fail 会被静默洗掉（S2 第十九轮 P0）。
    if (atParagraphStart && /^[ \t]*(?:>[ \t]*)*\[[^\]]+\]:/.test(line)) {
      inDefinition = true
      continue
    }
    if (inDefinition && /^[ \t]+/.test(line)) continue
    inDefinition = false
    if (line.trim() !== '') atParagraphStart = false
    kept.push(line)
  }
  return kept.join('\n')
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1')
}

function maskAuditLinkDestinations(text: string): { masked: string; poisoned: boolean } {
  const lines = text.split('\n')
  const inspectionLines = stripCdataSpansForInspection(lines)
  let start = 0
  let poisoned = false
  for (let i = 0; i <= lines.length; i += 1) {
    if (i < lines.length && !isMarkdownBlankLine(lines[i]!)) continue
    if (i > start) {
      let hide = false
      for (let k = start; k < i; k += 1) {
        // 所有链接、图片与引用定义都必须出现 ASCII 的 '['；带 '[' 的段落整体隐藏。
        // 这样跨行 label/title/alt、全引用 [text][ref]、空格分隔的引用标签也一并覆盖。
        if (lines[k]!.includes('[')) {
          hide = true
          break
        }
      }
      if (hide) {
        // 先按渲染后的可见文字重建这一段：链接只保留 label，目标/title 丢弃。
        // 这样 `[结论](url)：fail` 会还原成 `结论：fail`，而普通含链接的说明段
        // 不会因为出现“结论”二字就被误毒化。
        const visible = visibleTextOfLinkParagraph(inspectionLines.slice(start, i).join('\n'))
        for (let k = start; k < i; k += 1) lines[k] = blankPreservingLines(lines[k]!)
        for (const line of visible.split('\n')) {
          const normalized = normalizeAuditLine(line)
          const cleanPass = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]\s*(?:\*\*)?\s*(?:pass|通过)(.*)$/i.exec(normalized)
          const hasConclusionText = /(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/i.test(normalized)
          if (hasConclusionText) {
            if (cleanPass === null || !validConclusionTail(cleanPass[1] ?? '', 'pass')) poisoned = true
          } else if (/^(?:fail|不通过)$/i.test(normalized)) {
            poisoned = true
          }
        }
      }
    }
    start = i + 1
  }
  // poison 行由 stripHiddenAuditBlocks 在 HTML 掩码之后统一追加，
  // 避免未闭合的注释/处理指令/doctype 把 poison 一起吞掉（S1 第十四轮 P1-3）。
  return { masked: lines.join('\n'), poisoned }
}

function maskHtmlComments(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<!--', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf('-->', start + 4)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 3))
    cursor = end + 3
  }
  return out
}

// 处理指令、文档类型、CDATA 在 HTML 里都不渲染；未闭合一律隐藏到文末（fail-closed）。
function maskHtmlProcessingInstructions(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<?', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf('?>', start + 2)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 2))
    cursor = end + 2
  }
  return out
}

function maskHtmlCdata(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.toLowerCase().indexOf('<![cdata[', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = text.indexOf(']]>', start + 9)
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 3))
    cursor = end + 3
  }
  return out
}

// doctype 允许带内部子集，找到配对的 > 再收；找不到就隐藏到文末。
function maskHtmlDoctype(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.toLowerCase().indexOf('<!doctype', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    let quote = ''
    let brackets = 0
    let end = -1
    for (let i = start + 9; i < text.length; i += 1) {
      const ch = text.charAt(i)
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '[') {
        brackets += 1
      } else if (ch === ']') {
        brackets = Math.max(0, brackets - 1)
      } else if (ch === '>' && brackets === 0) {
        end = i
        break
      }
    }
    if (end < 0) {
      out += blankPreservingLines(text.slice(start))
      break
    }
    out += blankPreservingLines(text.slice(start, end + 1))
    cursor = end + 1
  }
  return out
}

// 审计报告只接受纯 Markdown。原始 HTML 的可见性取决于标签、属性、内联样式与宿主 CSS，
// 无法在门检查里可靠重算；一律拒绝整份报告（fail-closed），而不是猜哪些内容可见。
function stripHiddenAuditBlocks(text: string): string {
  let masked = text.replace(/\r\n/g, '\n')
  masked = maskFencedAuditCode(masked)
  const indented = maskIndentedAuditCode(masked)
  masked = indented.masked
  // 链接必须先于行内代码：行内代码若先吃掉链接的方括号，链接掩码就看不到这段，
  // title 里的结论行会漏成顶层（S2 第十八轮 P0）。链接段里的合法 CDATA 在毒化
  // 检查时剔除，避免误毒（S1 第十四轮 P2-1）。
  const links = maskAuditLinkDestinations(masked)
  masked = links.masked
  const inline = maskInlineAuditCode(masked)
  masked = inline.masked
  masked = maskHtmlComments(masked)
  masked = maskHtmlProcessingInstructions(masked)
  masked = maskHtmlCdata(masked)
  masked = maskHtmlDoctype(masked)
  // poison 必须在所有 HTML 掩码之后追加，否则会被未闭合结构吞掉（S1 第十四轮 P1-3）。
  if (links.poisoned || inline.poisoned || indented.poisoned) masked += '\n结论：'
  // 代码与链接目标已抹掉；剩下的任何标签、注释、处理指令都视为未支持的原始 HTML。
  if (/<(?=[A-Za-z/!?])/.test(masked)) return '\u0000'
  return masked
}

function normalizeAuditLine(raw: string): string {
  // 渲染不可见的字符不能把“结论”拆开：格式控制符（Cf）、组合记号（Mn/Me）
  // 以及几个无字形的 Lo 填充符都先剥掉（S1 第十七轮 P1-C）。
  let line = raw
    .replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '')
    .replace(/[\u115F\u1160\u17B4\u17B5\u180E\u2800\u3164\uFFA0]/g, '')
    .trim()
  // U+FE55 小冒号、U+FE13 竖排冒号在视觉上就是冒号，归一后再判定（S1 第十七轮 P2-3）。
  line = line.replace(/[\uFE13\uFE55]/g, ':')
  line = line.replace(/^>\s?/, '')
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
  // 任务列表的复选框不产生可见文字，判定前剥掉，避免「本报告不通过」被前缀挡住。
  line = line.replace(/^\[[ xX]\]\s+/, '')
  line = line.replace(/^#{1,6}\s*/, '')
  // 强调标记不改变可见文字；判定前一律剥掉，避免 `**结论**：fail` 被漏掉。
  line = line.replace(/(?:\*\*?|__?|~~)/g, '')
  return line.trim()
}

function rawVerdict(token: string): 'pass' | 'fail' {
  return /^(?:pass|通过)$/i.test(token) ? 'pass' : 'fail'
}

// 结论 token 后的尾巴：只接受空、标点、一个括号、一个破折号解释。
// fail 只要求尾巴里没有反向 pass（fail 不会放行门）；pass 还要把括号/解释里的
// 计数清零说明全部剥掉，剩余任何文字都视为未收口的 caveat。
function validConclusionTail(tail: string, verdict: 'pass' | 'fail'): boolean {
  let t = tail.trim().replace(/^\*\*/, '').trim()
  t = t.replace(/[。．.！!？?；;，,、\s]+$/, '')
  if (t.length === 0) return true
  let content = ''
  if (/^[—–-]/.test(t)) {
    content = t.replace(/^[—–\-\s]+/, '')
  } else if (/^[（(]/.test(t)) {
    const open = t[0]
    const close = open === '（' ? '）' : ')'
    if (!t.endsWith(close)) return false
    content = t.slice(1, -1)
  } else {
    return false
  }
  const hasPass = /(?:^|[^不])通过|\bpass\b/i.test(content)
  if (verdict === 'fail') return !hasPass
  if (hasPass || /\bfail\b/i.test(content)) return false
  return onlyCleanCounts(content)
}

function onlyCleanCounts(content: string): boolean {
  let rest = content.replace(/\s+/g, '')
  rest = rest.replace(/[。．.！!？?；;，,、：:（）()\[\]【】]/g, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*致命/gi, '')
  rest = rest.replace(/致命\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/重大\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*重大/gi, '')
  rest = rest.replace(/(?:阻断|风险)\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*(?:阻断|风险)/gi, '')
  rest = rest.replace(/P[01](?:已|均|都)?\s*(?:清零|清空|归零)/gi, '')
  rest = rest.replace(/无\s*(?:致命|重大|阻断|风险)(?:缺陷|问题)?/gi, '')
  rest = rest.replace(/无\s*P[01](?:\s*[\/、,，与和]\s*P[01])*/gi, '')
  rest = rest.replace(/P[01](?:\s*[\/、,，与和]\s*P[01])*\s*(?:均|都)?\s*(?:为|=|＝)?\s*0\s*(?:个|项|条)?/gi, '')
  rest = rest.replace(/P[01](?:\s*[\/、,，与和]\s*P[01])*\s*(?:均|都)?\s*无/gi, '')
  rest = rest.replace(/0\s*(?:个|项|条)?\s*P[01]/gi, '')
  rest = rest.replace(/P2\s*(?:=|＝|为)?\s*(?:遗留|剩余|待办|未闭合)?\s*\d+\s*(?:条|项|个)?/gi, '')
  rest = rest.replace(/[与和及均为都是项个条无均都]/g, '')
  return rest.length === 0
}

// 本轮独立审计的锚：报告在 HEAD、路径在白名单目录、轮次对得上、字节哈希固定，结论与门记录一致
// 只绑结论不绑字节，签后改报告正文不会被发现；门记录自身也不能当审计报告自指通过（S1 第二轮审计）
function checkAuditAnchor(artifact: Record<string, unknown>, spec: GateSpec, root: string): void {
  const round = artifact.audit_round
  if (!Number.isInteger(round) || (round as number) < 1) throw new Error('audit_round 必须是正整数')
  const report = String(artifact.audit_report ?? '')
  if (report.length === 0) throw new Error('audit_report 不能空')
  if (!/^docs\/audits\/[^/]+\.md$/.test(report) || report.includes('..')) {
    throw new Error('audit_report 必须是 docs/audits/ 下的 Markdown 报告: ' + report)
  }
  if (report === spec.gateFile) throw new Error('audit_report 不能指向门记录自身')
  const head = contentAt(root, 'HEAD', report)
  if (!head) throw new Error('审计报告不在 HEAD 里，先提交审计报告: ' + report)
  const m = /round(\d+)/.exec(report)
  const fileRound = m ? Number(m[1]) : 1
  if (fileRound !== round) throw new Error('audit_round 与审计报告的轮次不一致: ' + String(round) + ' != ' + String(fileRound))
  const expectedHash = String(artifact.audit_report_sha256 ?? '')
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('audit_report_sha256 必须是 64 位 sha256')
  const actualHash = sha256Hex(head.toString('utf8').replace(/\r\n/g, '\n'))
  if (actualHash !== expectedHash) {
    throw new Error('审计报告 sha256 与记录不符（报告改过就重新审计再签）：' + expectedHash.slice(0, 16) + '… != ' + actualHash.slice(0, 16) + '…')
  }
  const text = head.toString('utf8')
  const actual = auditConclusionOf(text)
  if (!actual) throw new Error('审计报告里找不到唯一结论行，不能拿它当门记录依据: ' + report)
  if (actual !== artifact.conclusion) {
    throw new Error('审计报告结论与门记录结论不符：报告=' + actual + '，门记录=' + String(artifact.conclusion))
  }
  // 报告必须自己写清门名与候选提交：只有路径和轮次时，别轮/别门的 pass 报告能直接拿来签（S1 第八轮 P1-2）
  const binding = auditBindingOf(text)
  if (!binding) {
    throw new Error('审计报告缺少唯一的「门：G1」与「候选提交：<40 位 commit>」绑定行: ' + report)
  }
  if (binding.gate !== String(artifact.gate)) {
    throw new Error('审计报告绑定的门与门记录不符：报告=' + binding.gate + '，记录=' + String(artifact.gate))
  }
  const commit = binding.commit
  try {
    git(root, ['cat-file', '-e', commit + '^{commit}'])
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'])
  } catch {
    throw new Error('审计报告的候选提交不是 HEAD 的祖先或不存在: ' + commit)
  }
  const afterArgs = ['diff', '--name-only', commit + '..HEAD', '--', '.']
  for (const dir of spec.excludes) afterArgs.push(':(exclude)' + dir)
  const after = git(root, afterArgs).toString('utf8').trim()
  if (after.length > 0) {
    throw new Error('审计报告的候选提交之后，候选文件又被改过，不能复用这份报告：' + after.split(/\r?\n/)[0])
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
  const bodyVerdict = bodyConclusionOf(text)
  if (bodyVerdict === null) throw new Error('门记录正文结论行缺失或不唯一')
  if (bodyVerdict !== artifact.conclusion) {
    throw new Error('门记录正文结论与 GateArtifact 不符：正文=' + bodyVerdict + '，artifact=' + String(artifact.conclusion))
  }
  const hasRun = artifact.gate_run_id !== null
  if (hasRun && artifact.run_terminal !== 'succeeded') {
    throw new Error('有 run 的门 run_terminal 必须是 succeeded，实际 ' + String(artifact.run_terminal))
  }
  if (!hasRun && artifact.run_terminal !== 'not_applicable') {
    throw new Error('无 run 的门 run_terminal 必须是 not_applicable，实际 ' + String(artifact.run_terminal))
  }
  checkGovernance(artifact)
  checkPreviousChain(artifact, spec, root)
  checkAuditAnchor(artifact, spec, root)

  const anchor = /artifact_hash=([0-9a-f]{64})/.exec(text)
  if (!anchor) throw new Error('门记录里找不到 artifact_hash 锚点')
  const expect = sha256Hex(canonicalJson(artifact))
  if (anchor[1] !== expect) throw new Error('artifact_hash 与正文不符：' + anchor[1] + ' != ' + expect)
  const evidence = checkEvidence(blocks, artifact, root, spec)
  const invariants = checkInvariants(blocks, artifact, evidence.entries, spec)
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