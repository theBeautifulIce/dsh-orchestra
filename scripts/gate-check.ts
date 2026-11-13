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
export function auditConclusionOf(text: string): 'pass' | 'fail' | null {
  let verdict: 'pass' | 'fail' | null = null
  for (const line of auditTopLevelLines(text)) {
    const strict = /^(?:审计)?(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(line)
    const bare = /^(?:pass|fail|通过|不通过)$/i.test(line)
    if (!strict && !bare) continue
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
  return verdict
}

// 审计报告绑定门名与候选提交：只读顶层可见行，防止拿别轮/别门的 pass 报告复用。
// 报告必须各出现一次「门：G1」与「候选提交：<40 位 commit>」（S1 第八轮 P1-2）。
export function auditBindingOf(text: string): { gate: string; commit: string } | null {
  const gates: string[] = []
  const commits: string[] = []
  for (const line of auditTopLevelLines(text)) {
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

// 围栏代码整段不可见：里面的字面标签不能参与 HTML 配对（S1 第十轮 P1-1）。
function maskFencedAuditCode(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { char: string; length: number; quoted: boolean } | null = null
  for (const line of lines) {
    const quote = /^\s*>\s?/.exec(line)
    const quoted = quote !== null
    const body = quote ? line.slice(quote[0].length) : line
    if (fence) {
      if (fence.quoted && !quoted) {
        fence = null
      } else {
        out.push(blankPreservingLines(line))
        const marker = fenceMarkerOf(body)
        if (marker && quoted === fence.quoted) {
          if (marker.char === fence.char && marker.length >= fence.length && marker.rest.trim() === '') fence = null
        }
        continue
      }
    }
    const marker = fenceMarkerOf(body)
    if (marker) {
      fence = { char: marker.char, length: marker.length, quoted }
      out.push(blankPreservingLines(line))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// 缩进代码里的标签同样只是字面文本。
// 但四空格缩进在列表项里只是续行，渲染器仍显示；一旦这段里出现结论行，
// 就不能静默藏掉（否则可见的 fail 会被另一段 pass 洗掉），一律毒化（S1 第十五轮补）。
function maskIndentedAuditCode(text: string): { masked: string; poisoned: boolean } {
  let poisoned = false
  let previousBlank = true
  const masked = text.split('\n').map((line) => {
    const quote = /^\s*>\s?/.exec(line)
    const body = quote ? line.slice(quote[0].length) : line
    const blank = isMarkdownBlankLine(line)
    if (!/^(?: {0,3}\t| {4,})/.test(body)) {
      previousBlank = blank
      return line
    }
    // 只有空行（或文首）之后的缩进才是确定的缩进代码；紧跟在列表项/段落后面
    // 的四空格是续行，渲染器仍可见。这种情况出现结论行就毒化（S1 第十五轮补）。
    if (!previousBlank) {
      const normalized = normalizeAuditLine(body)
      if (/(?:结论|判定|审计意见|最终判定|最终结论)\s*[：:]/.test(normalized) || /^(?:pass|fail|通过|不通过)$/i.test(normalized)) poisoned = true
    }
    previousBlank = blank
    return blankPreservingLines(line)
  }).join('\n')
  return { masked, poisoned }
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
  for (const line of text.split('\n')) {
    if (/^[ \t]*(?:>[ \t]*)*\[[^\]]+\]:/.test(line)) {
      inDefinition = true
      continue
    }
    if (inDefinition && /^[ \t]+/.test(line)) continue
    inDefinition = false
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
  let line = raw.trim()
  line = line.replace(/^>\s?/, '')
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
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