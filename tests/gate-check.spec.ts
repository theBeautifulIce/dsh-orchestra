import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { auditBindingOf, auditConclusionOf, bodyConclusionOf, candidateEntries, checkBodyEvidenceTable, checkBodyInvariants, verifyGateRecord } from '../scripts/gate-check.ts'

const read = () => readFileSync(join(process.cwd(), 'docs/gates/G1.md'), 'utf8')
const readG2 = () => readFileSync(join(process.cwd(), 'docs/gates/G2.md'), 'utf8')
// 测试在开发期的脏树上跑：显式放行脏树，脏树拒绝另有一条专门的用例
const check = (text: string) => verifyGateRecord(text, { allowDirty: true })

// 改 artifact 后按规则重签锚点：这样测的是语义校验，不是锚点校验
function tamper(text: string, fn: (a: Record<string, unknown>) => void): string {
  const re = /```json\r?\n([\s\S]*?)\r?\n```/g
  for (const m of text.matchAll(re)) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(m[1] ?? '') as Record<string, unknown>
    } catch {
      continue
    }
    if (!obj || typeof obj.gate !== 'string') continue
    fn(obj)
    const next = text.slice(0, m.index) + '```json\n' + JSON.stringify(obj, null, 2) + '\n```' + text.slice((m.index ?? 0) + m[0].length)
    return next.replace(/artifact_hash=[0-9a-f]{64}/, 'artifact_hash=' + sha256Hex(canonicalJson(obj)))
  }
  throw new Error('门记录里没有 GateArtifact 块')
}

// 门检查要逐份重算 HEAD 字节：并行满负载下单个用例可到十几秒，超时放宽（审计 N4）
describe('门记录校验', { timeout: 30000 }, () => {
  it('G1 门记录通过', () => {
    const out = check(read())
    expect(out.gate).toBe('G1')
    expect(out.items).toBeGreaterThanOrEqual(13)
  })

  it('必过项改成 fail 时报哪一项', () => {
    const text = read().replace(/"id": "G-08",\s*"result": "pass"/, '"id": "G-08", "result": "fail"')
    expect(text).toContain('"id": "G-08", "result": "fail"')
    expect(() => check(text)).toThrow(/必过项没过: G-08/)
  })

  it('改 candidate_hash 但锚点不动时报哈希不符', () => {
    const text = read().replace(/"candidate_hash": "[0-9a-f]{64}"/, '"candidate_hash": "' + 'a'.repeat(64) + '"')
    expect(() => check(text)).toThrow(/artifact_hash 与正文不符/)
  })

  it('缺字段时点名缺哪个', () => {
    const text = read().replace('"producer": "human"', '"producerx": "human"')
    expect(() => check(text)).toThrow(/缺字段: producer/)
  })

  it('无 json 块时直接报找不到', () => {
    expect(() => check('# 空记录\n')).toThrow(/找不到 GateArtifact/)
  })

  it('必过项被截短时指名清单不符（审计 M4）', () => {
    const text = tamper(read(), (a) => {
      const items = a.must_pass_items as unknown[]
      a.must_pass_items = items.slice(0, 1)
    })
    expect(() => check(text)).toThrow(/必过项清单不符/)
  })

  it('证据文件的哈希对不上时指名哪一份（审计 F1）', () => {
    const text = read().replace(
      /("id": "ev-g15",\s*"file": "docs\/gates\/evidence\/G1\/G-15\.md",\s*"sha256": ")[0-9a-f]{64}(")/,
      '$1' + '0'.repeat(64) + '$2',
    )
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/证据文件 sha256 不符: ev-g15/)
  })

  it('evidence_index_hash 被改时指名证据索引不符', () => {
    const text = tamper(read(), (a) => {
      a.evidence_index_hash = 'b'.repeat(64)
    })
    expect(() => check(text)).toThrow(/evidence_index_hash 与证据索引不符/)
  })

  it('candidate_hash 改成别处的值时指名与候选文件不符', () => {
    const text = tamper(read(), (a) => {
      a.candidate_hash = 'c'.repeat(64)
    })
    expect(() => check(text)).toThrow(/candidate_hash 与候选文件不符/)
  })

  it('必过项的证据被摘空时指名哪一项缺证据', () => {
    const text = tamper(read(), (a) => {
      const items = a.must_pass_items as { id: string; evidence_ids: string[] }[]
      const target = items.find((i) => i.id === 'G1-07')
      if (target) target.evidence_ids = []
    })
    expect(() => check(text)).toThrow(/必过项缺证据: G1-07/)
  })

  it('正文必过项的内容列被改时指名不一致（审计 N-09）', () => {
    const text = read().replace('| G1-01 | 迁移空库可重复 | pass | ev-migrate |', '| G1-01 | 随便写 | pass | ev-migrate |')
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/内容与固定表不一致/)
  })

  it('approver 不是 human:<名字> 时拒绝（审计 N-09）', () => {
    const text = tamper(read(), (a) => { a.approver = 'robot' })
    expect(() => check(text)).toThrow(/approver/)
  })

  it('例外项类型不在枚举里时拒绝（审计 N-09）', () => {
    const text = tamper(read(), (a) => {
      a.exceptions = [{ code: 'X', type: 'whatever', status: 200, note: 'x' }]
    })
    expect(() => check(text)).toThrow(/type/)
  })

  it('回滚缺可执行动作时拒绝（审计 N-09）', () => {
    const text = tamper(read(), (a) => { a.rollback = { target: 'x' } })
    expect(() => check(text)).toThrow(/rollback 缺 action/)
  })

  it('producer 不是 human 时拒绝（规格 11.3 行 981；审计 R3-05）', () => {
    const text = tamper(read(), (a) => { a.producer = 'agent:七七' })
    expect(() => check(text)).toThrow(/producer 必须是 human/)
  })

  it('必过项换绑证据时拒绝（审计 R3-08）', () => {
    const text = tamper(read(), (a) => {
      const items = a.must_pass_items as { id: string; evidence_ids: string[] }[]
      const target = items.find((i) => i.id === 'G1-01')
      if (target) target.evidence_ids = ['ev-chain']
    })
    expect(() => check(text)).toThrow(/固定映射/)
  })

  it('正文证据表的哈希被改时拒绝（审计 R3-06）', () => {
    const text = read().replace(/(\| ev-g15 \| `docs\/gates\/evidence\/G1\/G-15\.md` \| `)[0-9a-f]{64}/, '$1' + '0'.repeat(64))
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/正文证据表里 ev-g15 的 sha256/)
  })

  it('正文不变量说明被改时拒绝（审计 R3-06）', () => {
    const text = read().replace('| I3 | 事务失败不留半条记录，CAS 失败无副作用 | ev-g01,ev-g02 |', '| I3 | 随便写 | ev-g01,ev-g02 |')
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/不变量/)
  })

  it('不变量语句被削短后即使重算哈希也拒绝（S1 第八轮 P1-3）', () => {
    const text = read()
    const marker = '```json invariants'
    const start = text.indexOf(marker)
    if (start < 0) throw new Error('G1 里没有 invariants 块')
    const bodyStart = text.indexOf('\n', start)
    if (bodyStart < 0) throw new Error('G1 的 invariants 块头没有换行')
    const end = text.indexOf('\n```', bodyStart)
    if (end < 0) throw new Error('G1 的 invariants 块没有闭合')
    const list = JSON.parse(text.slice(bodyStart + 1, end)) as { id: string; statement: string; evidence_ids: string[] }[]
    const first = list[0]
    if (!first) throw new Error('G1 的 invariants 块是空的')
    first.statement = 'epoch 栅栏'
    list.forEach((e) => { e.evidence_ids = [...e.evidence_ids].sort() })
    list.sort((a, b) => a.id.localeCompare(b.id))
    const next = text.slice(0, start) + '```json invariants\n' + JSON.stringify(list, null, 2) + text.slice(end)
    const sealed = tamper(next, (a) => { a.invariants_hash = sha256Hex(canonicalJson(list)) })
    expect(() => check(sealed)).toThrow(/固定口径/)
  })

  it('正文证据表删一行再复制另一行时拒绝（S1 第四轮审计 P2-1）', () => {
    const sha = 'a'.repeat(64)
    const entries = [
      { id: 'ev-a', file: 'a.md', sha256: sha },
      { id: 'ev-b', file: 'b.md', sha256: sha },
    ]
    const text = '## 证据文件与哈希\n\n| 证据 | 文件 | sha256 |\n| --- | --- | --- |\n| ev-a | a.md | ' + sha + ' |\n| ev-a | a.md | ' + sha + ' |\n'
    expect(() => checkBodyEvidenceTable(text, entries)).toThrow(/正文证据表里证据重复: ev-a/)
  })

  it('正文不变量表删一行再复制另一行时拒绝（S1 第四轮审计 P2-1）', () => {
    const list = [
      { id: 'I1', statement: '一', evidence_ids: ['ev-a'] },
      { id: 'I2', statement: '二', evidence_ids: ['ev-b'] },
    ]
    const text = '## 不变量\n\n| 不变量 | 内容 | 证据 |\n| --- | --- | --- |\n| I1 | 一 | ev-a |\n| I1 | 一 | ev-a |\n'
    expect(() => checkBodyInvariants(text, list)).toThrow(/正文不变量表里不变量重复: I1/)
  })

  it('前序门哈希链断了时拒绝（审计 R3-08）', () => {
    const text = tamper(readG2(), (a) => { a.previous_artifact_hash = 'b'.repeat(64) })
    expect(() => check(text)).toThrow(/重签链断了/)
  })

  it('证据文件与固定文件映射不一致时拒绝（S1 第二轮审计）', () => {
    const text = read().replace(/("id": "ev-g15",\s*"file": ")[^"]+/, '$1docs/gates/evidence/G1/G-01.md')
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/文件与固定映射不一致/)
  })

  it('审计报告字节哈希被改时拒绝（S1 第二轮审计）', () => {
    const text = tamper(read(), (a) => { a.audit_report_sha256 = 'd'.repeat(64) })
    expect(() => check(text)).toThrow(/审计报告 sha256 与记录不符/)
  })

  it('审计报告不在 docs/audits 下时拒绝（S1 第二轮审计）', () => {
    const text = tamper(read(), (a) => { a.audit_report = 'docs/gates/G1.md' })
    expect(() => check(text)).toThrow(/docs\/audits/)
  })

  it('审计轮次与审计报告对不上时拒绝（审计 R3-08）', () => {
    const text = tamper(read(), (a) => { a.audit_round = (a.audit_round as number) + 1 })
    expect(() => check(text)).toThrow(/audit_round/)
  })

  it('正文自锚 body_hash 被改时拒绝（审计 R3-08）', () => {
    const text = read().replace(/body_hash=[0-9a-f]{64}/, 'body_hash=' + 'c'.repeat(64))
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/body_hash/)
  })

  it('批内新增又删除的文件留在候选清单里（审计 N2）', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-cand-'))
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root })
    try {
      run('init', '-q')
      writeFileSync(join(root, 'keep.txt'), 'keep\n')
      run('add', '.')
      run('commit', '-q', '-m', 'base')
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim()
      writeFileSync(join(root, 'gone.txt'), 'gone\n')
      run('add', '.')
      run('commit', '-q', '-m', 'add gone')
      rmSync(join(root, 'gone.txt'))
      run('add', '-A')
      run('commit', '-q', '-m', 'delete gone')
      const out = candidateEntries(root, { scopeBase: base, excludes: [] })
      expect(out.paths).toContain('gone.txt')
      expect(out.files.find((f) => f.path === 'gone.txt')?.sha256).toBe(sha256Hex(Buffer.from('ADDED_THEN_DELETED\n')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('证据文件进入候选范围，门记录自身不进入（S1 第十一轮 P2）', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-evidence-cand-'))
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root })
    try {
      run('init', '-q')
      mkdirSync(join(root, 'docs/gates/evidence/G1'), { recursive: true })
      writeFileSync(join(root, 'docs/gates/G1.md'), 'gate\n')
      writeFileSync(join(root, 'docs/gates/G2.md'), 'gate2\n')
      writeFileSync(join(root, 'docs/gates/evidence/G1/e.md'), 'old\n')
      writeFileSync(join(root, 'code.txt'), 'code\n')
      run('add', '.')
      run('commit', '-q', '-m', 'base')
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim()
      writeFileSync(join(root, 'docs/gates/evidence/G1/e.md'), 'new\n')
      run('add', '-A')
      run('commit', '-q', '-m', 'change evidence')
      const out = candidateEntries(root, { scopeBase: base, excludes: ['docs/gates/G1.md', 'docs/gates/G2.md'] })
      expect(out.paths).toContain('docs/gates/evidence/G1/e.md')
      expect(out.paths).not.toContain('docs/gates/G1.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工作树有未提交改动时拒绝签门（审计 N-09）', () => {
    const scratch = join(process.cwd(), 'dirty-check-file.txt')
    writeFileSync(scratch, 'x')
    try {
      expect(() => verifyGateRecord(read())).toThrow(/未提交改动/)
    } finally {
      rmSync(scratch, { force: true })
    }
  })
})

describe('审计报告结论必须与门记录一致（第五轮审计 P0-1 / 第六轮 P0-1）', () => {
  it('只认行首唯一结论：行内引用不算，多个不同结论视为没有结论', () => {
    expect(auditConclusionOf('# 报告\n\n门记录结论：pass\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('结论：pass\n\n结论：fail')).toBeNull()
    expect(auditConclusionOf('本文引用“结论：pass”作为例子')).toBeNull()
  })

  it('读得出 pass、fail、不通过、通过；找不到就返回 null', () => {
    expect(auditConclusionOf('# 报告\n\n结论：**pass**（0 致命）')).toBe('pass')
    expect(auditConclusionOf('结论：fail —— 致命 1 / 重大 3')).toBe('fail')
    expect(auditConclusionOf('## 结论\n\n不通过')).toBe('fail')
    expect(auditConclusionOf('## 结论\n\n通过')).toBe('pass')
    expect(auditConclusionOf('建议：不通过')).toBeNull()
    expect(auditConclusionOf('# 没有结论行')).toBeNull()
  })

  it('可见正文追加常见否定式不能保留 pass（S2 第二十五轮 P0-1/P0-2/P2-1）', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计无法通过。', '本次审计不予通过。', '本报告未获批准。', '本次审计未达标。',
      '本次审计被否决。', '本次审计没能通过。', '本次审计被驳回。', '本次审计遭否决。',
      '本次审计无法予以通过。', '本次审计不获批准。', '本次审计不予批准。',
      '本次审计未通过验收。', '本次审计不通过验收。', '本次审计未达到通过标准。', '本报告未通过验收。',
      '本次审计 fаil。', '本次审计 fаіl。',
      'This review cannot pass.', 'The audit was unable to pass.',
      'The audit was not approved.', 'The auditor did not approve.',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line)).toBeNull()
    // 清零统计与历史叙述不能被当成否定结论。
    expect(auditConclusionOf(base + '本次审计不通过项为 0。')).toBe('pass')
    expect(auditConclusionOf(base + '本次审计未通过验收项为 0。')).toBe('pass')
    expect(auditConclusionOf(base + '上一轮审计判 G2 不通过，本轮已修复。')).toBe('pass')
  })

  it('门记录正文在必过项前追加否定句时不能仍读成 pass（S2 第二十五轮 P0-2）', () => {
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    expect(bodyConclusionOf(head + '本次审计无法通过。')).toBe('fail')
    expect(bodyConclusionOf(head + '本报告未获批准。')).toBe('fail')
    expect(bodyConclusionOf(head + '本次审计未通过验收。')).toBe('fail')
    expect(bodyConclusionOf(head + '本報告未通過驗收。')).toBe('fail')
    expect(bodyConclusionOf(head + "The audit doesn't pass.")).toBe('fail')
    expect(bodyConclusionOf(head + '本次审计不通过项为 0。')).toBe('pass')
    expect(bodyConclusionOf(head + '上一轮审计未通过，本轮已整改。')).toBe('pass')
  })

  it('S1 第二十一轮 P0/P1：宾语、缩写、繁體、同形字、连接词与历史叙述（S1 r21）', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本报告未通过验收。', '本次审计未通过评审。', '本報告未通過驗收。',
      "The audit doesn't pass.", "The audit won't pass.", "The audit hasn't passed.",
      'The audit was not approved.', 'The audit is not passing.',
      '本报告未获批准。', '本报告被驳回。', '本报告被否决。', '本报告没有获得通过。',
      '本报告 fаil。', '本报告未通о过。',
      '本报告的的的的的的的的的不通过。',
      'The audit was was was was was was was was was not pass.',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).not.toBe('pass')
    const safe = [
      '历史记录：上一轮审计未通过，本轮已整改。',
      'round20 审计结论为 fail，本轮已整改。',
      'The previous audit did not pass; this round is clean.',
      '本轮检查未通过项为零，所有必过项均已通过。',
    ]
    for (const line of safe) expect(auditConclusionOf(base + line), line).toBe('pass')
    // 历史句后面再跟本轮否定，不能被同一段豁免吞掉。
    expect(auditConclusionOf(base + '上一轮审计未通过，本轮已整改。本报告不通过。')).not.toBe('pass')
  })

  it('S1 第二十二轮 19 条绕过：历史豁免只抹历史否定，本轮结论与完成度否定都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      // P0-1 历史整改剥离跨度（报告正文 7 例）
      '上一轮审计未通过，本轮审计未通过验收，本轮已整改。',
      '上一轮审计未通过，\n本轮审计未通过验收，\n本轮已整改。',
      'The previous audit failed to pass, the current audit did not approve, this round is fixed.',
      '上一轮审计未通过，本轮未整改，本轮已整改。',
      '上一轮审计未通过，本轮审计未通过验收\n\n本轮已整改。',
      '上一轮审计未通过，结论：fail，本轮已整改。',
      '上一轮审计未通过，结论：\nfail，本轮已整改。',
      // P0-3 英文进行时/名词化（3 例）
      'This audit is not approving.', "This audit isn't approving.",
      'The audit approval was not granted.',
      // P0-4 中文批准类（4 例）
      '本报告未获批。', '本报告没获批。', '本报告未准予通过。', '本报告未被批准。',
      // P1 整改完成度陈述（3 例）
      '本轮未整改。', '本报告未完成整改。',
      '上一轮审计未通过，本轮已整改，但实际上本轮未整改。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).not.toBe('pass')
    // 历史豁免本身仍要保护真正的历史叙述。
    expect(auditConclusionOf(base + '历史记录：上一轮审计未通过，本轮已整改。')).toBe('pass')
    expect(auditConclusionOf(base + 'round20 审计结论为 fail，本轮已整改。')).toBe('pass')
    // P0-2 同一剥离跨度覆盖门正文（2 例）
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    expect(bodyConclusionOf(head + '上一轮审计未通过，本轮审计未通过验收，本轮已整改。')).toBe('fail')
    expect(bodyConclusionOf(head + '上一轮审计未通过，结论：fail，本轮已整改。')).toBe('fail')
  })

  it('S2 第二十八轮 P0-1/P0-2：结论行写 pass 时同义否定仍要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计结论为未过。', '本次审计结论为否。', '本次审计结论为 faıl。',
      '本次审计结论为未通过收口。', '本次审计结论为不获认同。', '本次审计结论为 unapproved。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    expect(auditConclusionOf(base + '本次审计结论为未过项为零，全部通过。')).toBe('pass')
    const more = [
      '本次审计结论为部分通过。', '本次审计结论为有条件通过。', '本次审计结论为待整改。',
      '本次审计结论为暂缓。', '本次审计结论为未受理。', '本次审计结论为不接受。',
      'The audit conclusion was negative.', 'The audit conclusion was unapproved.',
    ]
    for (const line of more) expect(auditConclusionOf(base + line), line).not.toBe('pass')
    expect(auditConclusionOf(base + '历史记录：上一轮审计结论为未过，本轮已整改。')).toBe('pass')
  })

  it('S1 第二十三轮 P0/P1：历史通过锚、裁决宾语、副词前缀与完成度都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '上一轮审计已通过，本报告未通过验收，本轮已整改。',
      '上一轮审计结论为通过，本次审计未通过复核，本轮已修复。',
      '上一轮审计已通过，本报告被驳回，本轮已整改。',
      '上一轮审计已通过，结论：fail，本轮已整改。',
      'The previous audit was recorded as passing; this audit does not pass; this round is fixed.',
      '本报告未通过复核。', '本报告未通过最终验收。', '本次审计未通过专家评审。',
      '本报告尚未通过。', '本报告还没通过。', '本报告暂未通过。', '本报告尚未获批。',
      '本报告整改尚未完成。', '本轮整改仍未完成。',
      'This audit remediation is not complete.', 'The audit remediation is not complete.',
      'This audit has not yet passed.', 'This audit has not yet been approved.',
      '本报告未通過复核。', 'This audit does not paß.',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    for (const safe of [
      '历史记录：上一轮审计未通过，本轮已整改。',
      '上一轮审计未通过，本轮已整改。',
      'round20 审计结论为 fail，本轮已整改。',
      '本次审计结论为未过项为零，全部通过。',
      '未通过项为 0，结论：pass。',
    ]) expect(auditConclusionOf(base + safe), safe).toBe('pass')
  })

  it('S1 第二十四轮 P0：放行/clear/fit/release 同义否定也要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本报告不能放行。', '本次审计未达到放行条件。',
      'This audit does not clear the gate.', 'The gate is not fit to advance.',
      '本报告\n不能\n放行。', '上一轮审计未通过，本轮已整改。本报告不能放行。',
      '本次审计未获放行。', 'The gate cannot be released.', '本门记录不能放行。',
      '本报告不予放行。', '本报告不能晋级。', '本次审计未就绪。', '本报告未达放行标准。',
      'This audit is inconclusive.', 'The gate is not ready for release.',
      'The gate remains blocked.', 'This report is incomplete.', 'The audit was unsatisfactory.',
      '本报告未满足放行要求。', '本次审计不符合准入条件。',
      'The gate is not eligible for release.',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    expect(auditConclusionOf(base + '本轮已整改，未发现新的阻断项。')).toBe('pass')
    expect(bodyConclusionOf(head + '未发现新的阻断项。')).toBe('pass')
  })

  it('S1 第二十五轮 P0：验收/被动/副词/完成度/状态介词与放行条件的否定都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本报告验收未通过。',
      '本报告被退回。',
      '上一轮审计未通过，本轮已整改。本报告验收未通过。',
      '本报告目前未通过。',
      '本报告整改完成度不足。',
      '本报告未获准入。',
      'The gate is in a blocked state.',
      '本报告尚不具备放行条件。',
      '本门记录验收未通过。',
      '本门记录未获准入。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    for (const safe of [
      '本报告验收通过。', '本门记录验收通过。', '本报告目前通过验收。',
      '本报告验收已通过。', '整改完成度 100%。', 'The gate is in a passing state.',
    ]) expect(bodyConclusionOf(head + safe), safe).toBe('pass')
    // P2-1：不可见文本按 markdown 可见性语义不参与结论判定。
    expect(auditConclusionOf('结论：pass\n\n<!-- 本报告不能放行 -->')).toBe('pass')
    expect(auditConclusionOf('结论：pass\n\n~~~text\n结论：fail\n~~~')).toBe('pass')
  })

  it('S2 第三十轮 P0/P2：语气副词、连续谓词、准入宾语与引用定义里的隐藏否决都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计原则上不推荐通过本报告。',
      'This audit, on the whole, does not endorse the report.',
      '本次审计不予采信并退回本报告。',
      '本次审计结论为：不予准入。',
      '整改工作尚未完成。',
      'This audit does not consider the report ready.',
      '门正文：本门记录不具备准入条件。',
      '门正文：本门记录未达到准入条件。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    // 安全的同族正句不能被误伤。
    for (const safe of [
      '本次审计推荐通过本报告，本门记录具备准入条件，整改工作已完成。',
      'This audit recommends approval; the report is ready.',
      '本门记录具备准入条件。',
      '整改工作已完成。',
    ]) expect(bodyConclusionOf(head + safe), safe).toBe('pass')
    // 引用定义不渲染，但里面藏的否决不能靠另一段干净 pass 洗掉。
    for (const hidden of [
      '[1]: "本次审计结论：fail"\n\n结论：pass',
      '[1]: "结论：不通过"\n\n结论：pass',
      '[1]: "审计未通过"\n\n结论：pass',
    ]) {
      expect(auditConclusionOf(hidden), hidden).toBeNull()
      expect(bodyConclusionOf(hidden), hidden).toBe('fail')
    }
    expect(auditConclusionOf('[1]: https://example.com\n\n结论：pass')).toBe('pass')
    expect(bodyConclusionOf('[1]: https://example.com\n\n结论：pass')).toBe('pass')
  })

  it('S1 第二十六轮 P0：准入依据、post-pass 尾巴、语气副词与认为/总体而言都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本门记录尚不具备准入条件。',
      '本门记录不能作为准入依据。',
      '本次审计结论：通过，但准入条件尚未满足。',
      '本次审计原则上认为本报告已通过，但尚不具备放行条件。',
      'This audit, generally speaking, does not clear the gate.',
      '本次审计总体而言不推荐通过本报告。',
      '本次审计原则上认为本报告尚未完成整改。',
      '本次审计总体而言不予推荐本报告。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    for (const safe of [
      '本门记录具备准入条件。', '本次审计通过，准入条件已满足。',
      'This audit, generally speaking, clears the gate.',
    ]) expect(bodyConclusionOf(head + safe), safe).toBe('pass')
  })

  it('S2 第三十一轮 P0：post-pass 分句、程度否定与跨行引用定义都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计结论：通过。准入条件尚未满足。',
      '本次审计认定通过，但准入条件尚未满足。',
      '本次审计从原则上讲不推荐通过本报告。',
      '本次审计整体而言不推荐通过本报告。',
      '本次审计既不予采信，也不予推荐。',
      '整改工作未完全完成。',
      '整改工作还没有完成。',
      '[1]:\n/url\n"本次审计结论：fail"',
      '> [1]: /url\n> "本次审计结论：fail"',
      '[1]: /url "本次审计结论：&#102;ail"',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    // 门正文的 post-pass 尾巴与跨行定义也不能只看结论行。
    expect(bodyConclusionOf(head + '失败项为空，准入条件尚未满足，无 run')).toBe('fail')
    expect(bodyConclusionOf(head + '结论：pass（准入条件尚未满足）')).toBe('fail')
    expect(bodyConclusionOf(head + '[1]:\n"结论：fail"')).toBe('fail')
    for (const safe of [
      '本次审计推荐通过本报告。', '整改工作已完成。', '本次审计通过，准入条件已满足。',
    ]) expect(bodyConclusionOf(head + safe), safe).toBe('pass')
  })

  it('S2 第二十七轮 P0-1/P0-2：报告宾语与英文否决/结论行都要拒绝', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计结论为拒收本报告。', '本报告未通过本次审计。', 'This audit rejects the report.',
      'This audit denies the report.', 'The review declines the report.',
      'The report was rejected.', 'The report did not pass.', 'This report was not approved.',
      '审计组未予认可。', '报告未通过审核。', 'The review found the gate failing.',
      'This report is not acceptable.', 'Approval was refused.', 'Audit verdict: rejected.',
      '本次审计不推荐通过本报告。', '不予采信本报告。', '不建议通过本报告。',
      '结论为：不予推荐。', 'This audit does not recommend the report.', '未予推荐本报告。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).toBeNull()
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    for (const line of negatives) expect(bodyConclusionOf(head + line), line).toBe('fail')
    // 英文结论行：值必须明确；正文里不带裁决的 Conclusion 叙述不能当正式结论。
    expect(auditConclusionOf('CONCLUSION: FAIL')).toBe('fail')
    expect(auditConclusionOf('Conclusion: fail')).toBe('fail')
    expect(auditConclusionOf('Verdict: pass')).toBe('pass')
    expect(auditConclusionOf('Outcome: PASS')).toBe('pass')
    expect(auditConclusionOf('CONCLUSION — FAIL')).toBe('fail')
    expect(auditConclusionOf('Audit Conclusion: PASS')).toBe('pass')
    expect(auditConclusionOf('Result: fail')).toBe('fail')
    expect(auditConclusionOf(base + 'Conclusion: the design is sound')).toBe('pass')
    // 正文英文结论写 pass、同行尾巴再放 fail 时按 fail 收口。
    expect(bodyConclusionOf('## 必过项与证据\n\nCONCLUSION: PASS (fail)')).toBe('fail')
    expect(bodyConclusionOf('## 必过项与证据\n\nCONCLUSION: PASS')).toBe('pass')
  })

  it('S2 第二十六轮 P0-1/P0-2：裸裁决词与繁體結論不能保留 pass', () => {
    const base = '结论：pass\n\n'
    const negatives = [
      '本次审计结论为否决。', '本次审计结论为驳回。', '本次审计结论为拒绝。',
      '本次审计结论为反对。', '本次审计结论为未采纳。', '本次审计结论为拒收。',
      '本次审计结论为不接收。', '結論：fail',
      '本次審計結論為否決。', '本次審計結論為駁回。',
    ]
    for (const line of negatives) expect(auditConclusionOf(base + line), line).not.toBe('pass')
    expect(auditConclusionOf('結論：fail')).toBe('fail')
    expect(auditConclusionOf('結論：pass')).toBe('pass')
    const head = '结论：pass\n\n## 必过项与证据\n\n'
    expect(bodyConclusionOf(head + '本次审计结论为否决。')).toBe('fail')
    expect(bodyConclusionOf(head + '本報告結論為駁回。')).toBe('fail')
    expect(bodyConclusionOf(head + '本次审计否决项为 0。')).toBe('pass')
  })

  it('pass 后带重大/阻断/未收口等 caveat 不能读成 pass（S1 第六轮 P1-1）', () => {
    expect(auditConclusionOf('结论：pass — 重大 3')).toBeNull()
    expect(auditConclusionOf('结论：pass（未收口）')).toBeNull()
    expect(auditConclusionOf('结论：pass — 阻断')).toBeNull()
    expect(auditConclusionOf('结论：pass（未解决）')).toBeNull()
    expect(auditConclusionOf('结论：pass — 但还有 3 个重大问题')).toBeNull()
    expect(auditConclusionOf('结论：pass（遗留 2 个重大缺陷）')).toBeNull()
  })

  it('建议行不再当结论；正常清零写法不误杀（S2 第十轮 P2-9）', () => {
    expect(auditConclusionOf('建议：通过')).toBeNull()
    expect(auditConclusionOf('结论：pass（P0 与 P1 均为 0）')).toBe('pass')
    expect(auditConclusionOf('结论：pass（P0/P1 均无）')).toBe('pass')
    expect(auditConclusionOf('结论：pass（P0=0，P1=0，P2=10）')).toBe('pass')
    expect(auditConclusionOf('- 结论：通过')).toBe('pass')
    expect(auditConclusionOf('> 结论：不通过')).toBe('fail')
  })

  it('结论后不许带“通过率”这类未收口的后缀（第七轮审计 P1-1）', () => {
    expect(auditConclusionOf('结论：通过率 60%，未达门槛')).toBeNull()
    expect(auditConclusionOf('结论：fail 但仍有风险未排除')).toBeNull()
    expect(auditConclusionOf('结论：pass 的把握不到一半')).toBeNull()
    expect(auditConclusionOf('结论：pass。')).toBe('pass')
    expect(auditConclusionOf('结论：**fail**。')).toBe('fail')
  })

  it('未收口的结论候选行不能被静默跳过（S1 第四轮审计 P1-1）', () => {
    expect(auditConclusionOf('结论：pass\n\n结论：fail，仍有 1 个 P0 未闭合')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n结论：fail 但仍有风险未排除')).toBeNull()
  })

  it('同一行里的相反结论按歧义处理；大小写归一（S2 第八轮审计 P2-6/P2-8）', () => {
    expect(auditConclusionOf('结论：PASS（0 致命）')).toBe('pass')
    expect(auditConclusionOf('结论：FAIL（致命 1）')).toBe('fail')
    expect(auditConclusionOf('结论：pass（上一轮 fail）')).toBeNull()
  })

  it('pass 结论后的阻塞项 caveat 不能读成 pass（S1 第五轮审计 P1）', () => {
    expect(auditConclusionOf('结论：pass — 但仍有 1 个 P0 未闭合')).toBeNull()
    expect(auditConclusionOf('结论：pass（但仍有 1 个 P0 未闭合）')).toBeNull()
    expect(auditConclusionOf('结论：pass（P0 未闭合）')).toBeNull()
    expect(auditConclusionOf('结论：pass，致命 1')).toBeNull()
    expect(auditConclusionOf('结论：pass（P0=0，P1=0）')).toBe('pass')
    expect(auditConclusionOf('结论：pass（无 P0/P1）')).toBe('pass')
    expect(auditConclusionOf('结论：pass — P2 遗留 3 条')).toBe('pass')
  })

  it('围栏代码块里的示例结论不参与判定（第七轮审计 P1-1）', () => {
    expect(auditConclusionOf('正文\n\n```md\n结论：pass\n```\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('~~~\n结论：pass\n~~~')).toBeNull()
    expect(auditConclusionOf('```\n结论：fail\n```\n\n结论：pass')).toBe('pass')
    expect(auditConclusionOf('````md\n结论：fail\n```\n结论：pass\n````\n\n结论：fail')).toBe('fail')
  })

  it('强调标记与链接文字都不能藏掉可见结论（S1 第十五轮补）', () => {
    expect(auditConclusionOf('结论：pass\n\n**结论**：fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n*结论*：fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n结**论**：fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n[结论](https://example.com)：fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n[结论][r]：fail\n\n[r]: https://example.com')).toBeNull()
    // 普通含链接的说明段里出现“结论”二字，不应被误毒化。
    expect(auditConclusionOf('结论：pass\n\n见[证据](https://example.com)，这里讨论结论。')).toBe('pass')
  })

  it('HTML 实体渲染后的可见结论也要参与判定（S1 第十五轮补）', () => {
    expect(auditConclusionOf('结论：pass\n\n&#32467;&#35770;&#65306;fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n&#32467;&#35770;&colon;fail')).toBeNull()
  })

  it('反引号围栏的 info string 带反引号时不算围栏（S1 第十五轮补）', () => {
    expect(auditConclusionOf('结论：pass\n\n' + '\x60'.repeat(3) + 'foo\x60bar\n结论：fail\n' + '\x60'.repeat(3))).toBeNull()
  })

  it('关闭围栏必须 marker 后只有空白（S2 第十一轮 P1-1）', () => {
    expect(auditConclusionOf('正文\n\n```md\n示例：\n```js\n结论：pass\n```\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('```\n结论：fail\n```js\n结论：pass')).toBeNull()
    expect(auditConclusionOf('```\n结论：fail\n```   \n\n结论：pass')).toBe('pass')
  })

  it('第二行同向结论也按歧义处理（全文只能有一个结论）', () => {
    expect(auditConclusionOf('结论：pass\n\n结论：pass')).toBeNull()
  })

  it('代码、缩进、引用围栏里的内容不参与判定（S1 第八轮 P1-4）', () => {
    expect(auditConclusionOf('本报告结论为不通过\n\n<!--\n结论：pass\n-->')).toBeNull()
    expect(auditConclusionOf('<!-- 结论：pass -->\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('\x60\x60\x60html\n<details>\n结论：pass\n</details>\n\x60\x60\x60\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('    结论：pass\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('> \x60\x60\x60\n> 结论：pass\n> \x60\x60\x60\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('> 结论：不通过')).toBe('fail')
    // 引用标记只吃掉一个空格；`>    结论` 剩 3 个空格，仍是可见引用段落，
    // 基准 pass 后面出现可见 fail 必须拒绝（S1 第十七轮 P1-A / S2 第二十一轮 P0-1）。
    expect(auditConclusionOf('结论：pass\n\n>    结论：fail')).toBeNull()
    expect(auditConclusionOf('>    结论：pass')).toBe('pass')
    // 可见的“本报告结论为不通过”本身就足够拒绝。
    expect(auditConclusionOf('本报告结论为不通过\n\n>    结论：pass')).toBeNull()
    // 一个空格加一个 Tab 也是缩进代码。
    expect(auditConclusionOf('本报告结论为不通过\n\n \t结论：pass')).toBeNull()
  })

  it('链接引用定义的续行也不参与判定（S1 第十一轮 P1）', () => {
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]:\n结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]:\n<https://example.com>\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('[x]: https://example.com\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('[x]: https://example.com\n  "title"\n\n结论：fail')).toBe('fail')
  })

  it('转义括号、引用块、列表项与多行 title 里的引用定义都不参与判定（S1 第十二轮 P1-1、S2 第十五轮 P1-1/P1-2）', () => {
    expect(auditConclusionOf('本报告结论为不通过\n\n[a\\]]:\n结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n[a\\]b\\]]:\n结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n> [x]:\n> 结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n> [a\\]]:\n> 结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n- [x]:\n  结论：pass')).toBeNull()
    // B1：同行目标后带未闭合引号 title，pass 写在 title 续行里。
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]: https://example.com "title\n结论：pass\n"')).toBeNull()
    // B2：目标换行、引号 title 跨多行，pass 写在 title 里。
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]:\nhttps://example.com\n"title\n结论：pass\n"')).toBeNull()
    // B6：左括号 title 跨行，pass 写在 title 里。
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]: https://example.com\n(title\n结论：pass\n)')).toBeNull()
    expect(auditConclusionOf('> [x]: https://example.com\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('> [x]:\n> <https://example.com>\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('> [x]:\n> https://example.com\n> "title"\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('- [x]: https://example.com\n\n结论：fail')).toBe('fail')
  })

  it('引用定义整段（目标与多行 title）都不参与判定（S1 第十二轮 P1）', () => {
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]: https://example.com "title\n结论：pass\n"')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]:\nhttps://example.com\n"title\n结论：pass\n"')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n- [x]:\n  结论：pass')).toBeNull()
    expect(auditConclusionOf('本报告结论为不通过\n\n[x]: https://example.com\n(title\n结论：pass\n)')).toBeNull()
    expect(auditConclusionOf('[x]: https://example.com "title"\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('- [x]: https://example.com\n\n结论：fail')).toBe('fail')
  })

  it('跨行引用标签、行内链接 title 与图片 alt 都不参与判定（S1 第十三轮 P1、S2 第十六轮 P0）', () => {
    expect(auditConclusionOf('本报告可见正文的结论为不通过。\n\n[x\ny]: https://example.com\n"title\n结论：pass\n"')).toBeNull()
    expect(auditConclusionOf('本报告可见正文的结论为不通过。\n\n[a](https://example.com "title\n结论：pass\n")')).toBeNull()
    expect(auditConclusionOf('本报告可见正文的结论为不通过。\n\n![alt\n结论：pass\n](https://example.com/i.png)')).toBeNull()
    expect(auditConclusionOf('本报告可见正文的结论为不通过。\n\n![alt](https://example.com/i.png "title\n结论：pass\n")')).toBeNull()
    expect(auditConclusionOf('[a](https://example.com "t")\n\n结论：pass')).toBe('pass')
    expect(auditConclusionOf('![alt](https://example.com/i.png)\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('本报告可见正文的结论为不通过。\n\n[text] [结论：pass]\n\n[结论：pass]: https://example.com')).toBeNull()
    expect(auditConclusionOf('结论：❌ 不通过 [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('结论：待定 [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('结论：pass [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('<!-- x -->结论：不通过 [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('前缀 结论：不通过 [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('[text] [ref]\n\n[ref]: https://example.com\n\n结论：fail')).toBe('fail')
    // 段落掩码不能把同一段里可见的 fail 结论洗掉，再让另一段 pass 过门。
    expect(auditConclusionOf('结论：不通过 [x](https://example.com)\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('[x](https://example.com)\n结论：不通过\n\n结论：pass')).toBeNull()
  })

  it('段落边界按 CommonMark 口径，Unicode 空白不切断段落（S1 第十四轮 P1-1/P1-2）', () => {
    for (const ch of ['\u00A0', '\u2003', '\u3000', '\u000C', '\u000B', '\uFEFF', '\u2028']) {
      expect(auditConclusionOf(`本报告结论为不通过\n\n[a](https://example.com "title\n${ch}\n结论：pass\n")`)).toBeNull()
    }
    expect(auditConclusionOf(`本报告结论为不通过\n\n\`\n\n[a](https://example.com "\`"\n结论：pass\n")`)).toBeNull()
  })

  it('跨行内联代码不能藏掉块边界后的结论行（S1 第十五轮补）', () => {
    // 反引号跨过 ATX 标题时，渲染器会把它折成两段；若解析器仍按一个代码段处理，
    // 可见的 fail 会被藏掉，只剩另一段 pass。跨行代码段里出现结论行一律毒化。
    expect(auditConclusionOf('可见正文：本报告不通过。\n\n`开头\n# 标题\n结论：fail\n`\n结论：pass')).toBeNull()
    // 跨行代码段里没有结论行时，仍按代码隐藏，可见 pass 正常生效。
    expect(auditConclusionOf('`开头\n# 标题\n`\n结论：pass')).toBe('pass')
  })

  it('缩进代码不能藏掉列表续行里的结论（S1 第十五轮补）', () => {
    // 四空格缩进在列表项里只是续行，不是代码；藏掉可见 fail 会让 pass 过门。
    expect(auditConclusionOf('结论：pass\n\n- 列表项\n    结论：fail')).toBeNull()
    // 真正的缩进代码里没有结论时，仍按代码隐藏，不影响可见 pass。
    expect(auditConclusionOf('    普通缩进示例\n\n结论：pass')).toBe('pass')
  })

  it('行内代码不能先吃掉链接方括号，让 title 里的结论漏成顶层（S2 第十八轮 P0）', () => {
    const bt = '\x60'
    expect(auditConclusionOf(`本报告可见正文的结论为不通过。\n\n${bt}\n- [a](https://example.com "title${bt}\n结论：pass\n")\n`)).toBeNull()
    expect(auditConclusionOf(`本报告可见正文的结论为不通过。\n\n${bt}\n> [a](https://example.com "title${bt}\n> 结论：pass\n> ")\n`)).toBeNull()
  })

  it('围栏关闭与缩进续行按 CommonMark 判定（S1 第十五轮 P1-B/P1-C/P2）', () => {
    const f = '\x60'.repeat(3)
    const nb = '\u00A0'
    // NBSP 不是合法关闭后缀：围栏一直开到文末，围栏内的 fail 不可见，只剩可见 pass。
    expect(auditConclusionOf(`结论：pass\n\n${f}\n结论：pass\n${f}${nb}\n结论：fail`)).toBe('pass')
    // 列表项四空格续行是可见正文，跨行拼出的结论也要毒化。
    expect(auditConclusionOf('结论：pass\n\n- 列表项\n    结论\n    ：fail')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n- 列表项\n\n    结论：fail')).toBeNull()
    // 真正的多行缩进代码块不因第二行出现结论而误毒化。
    expect(auditConclusionOf('    其他\n    结论：pass\n\n结论：pass')).toBe('pass')
  })

  it('段落中间的定义样式是可见正文，不能整行删除（S2 第十九轮 P0）', () => {
    expect(auditConclusionOf('结论：pass\n\n正文\n   [x]: https://example.com "title 结论：fail"')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n- 列表项\n   [x]: https://example.com "title 结论：fail"')).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n> 引用\n>    [x]: https://example.com "title 结论：fail"')).toBeNull()
  })

  it('poison 在 HTML 掩码之后追加，合法 CDATA 不误毒化（S1 第十四轮 P1-3/P2-1）', () => {
    for (const tail of ['<!-- 未闭合', '<?php 未闭合', '<!DOCTYPE html']) {
      expect(auditConclusionOf(`结论：不通过 [x](https://example.com)\n\n结论：pass\n\n${tail}`)).toBeNull()
    }
    expect(auditConclusionOf('结论：不通过\n\n<![CDATA[结论：pass]]>')).toBe('fail')
    expect(auditConclusionOf('结论：不通过\n\n<![CDATA[\n结论：pass\n]]>')).toBe('fail')
    // 链接 title 里的 '<!--' 不是真的 HTML 注释，不能吞掉后面的可见 fail 再让前面的 pass 过门。
    expect(auditConclusionOf('结论：pass\n\n[x](https://example.com "title <!--")\n结论：不通过')).toBeNull()
    // 未闭合的 CDATA 不当作可剔除的隐藏段，隐藏链接段里的 fail 仍要毒化。
    expect(auditConclusionOf('结论：pass\n\n[x](https://example.com "<![CDATA[")\n结论：不通过')).toBeNull()
  })

  it('原始 HTML 一律拒绝，避免 details/summary/div hidden 的可见性绕过（S1 第十轮、S2 第十三轮 P1-1）', () => {
    expect(auditConclusionOf('<details>\n结论：pass\n</details>\n\n结论：fail')).toBeNull()
    expect(auditConclusionOf('<details open>\n结论：fail\n</details>\n\n结论：pass')).toBeNull()
    expect(auditConclusionOf('<details>\n<summary>结论：fail</summary>\n</details>\n<div hidden>结论：pass</div>')).toBeNull()
    expect(auditConclusionOf('<div hidden>\n结论：pass\n</div>')).toBeNull()
    expect(auditConclusionOf('<div style="display:none">\n结论：pass\n</div>')).toBeNull()
    expect(auditConclusionOf('<span style="visibility:hidden">\n结论：pass\n</span>')).toBeNull()
    // 纯 Markdown 报告里出现标签占位符也按原始 HTML 拒绝；占位符应写成反引号。
    expect(auditConclusionOf('<ID>占位符在正文里，报告同样拒绝')).toBeNull()
  })

  it('HTML 特殊块里的结论不参与判定（S1 第十轮 P1-2）', () => {
    expect(auditConclusionOf('<?php\n结论：pass\n?>\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('<!DOCTYPE html>\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('<![CDATA[\n结论：pass\n]]>\n\n结论：fail')).toBe('fail')
    expect(auditConclusionOf('<?php\n\n结论：pass')).toBeNull()
  })

  it('正常清零写法不再误杀（S1 第八轮 P2-5）', () => {
    expect(auditConclusionOf('结论：pass（重大 0）')).toBe('pass')
    expect(auditConclusionOf('结论：pass（P0 已清零，P1 已清零）')).toBe('pass')
    expect(auditConclusionOf('结论：pass（0 个阻断）')).toBe('pass')
  })

  it('S2 第二十轮 13 条载荷都不能把可见 fail 藏进 pass（S2 第二十轮 P0）', () => {
    const payloads: Array<[string, string]> = [
      ['def-trailing', '结论：pass\n\n[x]: https://example.com "t" 结论：fail'],
      ['def-invalid-dest', '结论：pass\n\n[x]: not a url "结论：fail"'],
      ['def-then-indent', '结论：pass\n\n[x]: https://example.com\n 结论：fail'],
      ['fake-link-spaces', '结论：pass\n\n[a](not a url "结论：fail")'],
      ['fake-link-bare-title', '结论：pass\n\n[a](https://e.com 结论：fail)'],
      ['fake-ref-undefined', '结论：pass\n\n[a][结论：fail]'],
      ['image-fake-dest', '结论：pass\n\n![a](not a url "结论：fail")'],
      ['entity-link-para', '结论：pass\n\n见[证据](https://e.com)，结论&#65306;fail'],
      ['entity-heading-after-link', '结论：pass\n\n[x](https://e.com)\n# 结论&#65306;fail'],
      ['entity-list-after-link', '结论：pass\n\n[x](https://e.com)\n- 结论&#65306;fail'],
      ['entity-indented-list', '结论：pass\n\n- 列表项\n    结论&#65306;fail'],
      ['setext-entity', '结论：pass\n\n[x](https://e.com)\n结论&#65306;fail\n---'],
      ['zwsp-colon', '结论：pass\n\n见下段：结论\u200B：fail'],
    ]
    for (const [name, payload] of payloads) {
      expect(auditConclusionOf(payload), name).toBeNull()
    }
    expect(auditConclusionOf('门：G2\n候选提交：' + 'a'.repeat(40) + '\n\n结论：pass')).toBe('pass')
    expect(auditConclusionOf('门：G2\n候选提交：' + 'a'.repeat(40) + '\n\n结论：fail')).toBe('fail')
  })

  it('S1 第十七轮载荷：可见 fail 不能藏在引用续行、行内代码、不可见字符和换行里（S1 第十七轮 P1）', () => {
    const payloads: Array<[string, string]> = [
      ['bq-4sp', '结论：pass\n\n> 引用\n>    结论：fail'],
      ['bq-5sp', '结论：pass\n\n> 引用\n>     结论：fail'],
      ['li-4sp', '结论：pass\n\n> - 项\n>    结论：fail'],
      ['li-5sp', '结论：pass\n\n> - 项\n>     结论：fail'],
      ['li-6sp', '结论：pass\n\n> - 项\n>      结论：fail'],
      ['code-colon', '结论：pass\n\n结论`:`fail'],
      ['code-fullcolon', '结论：pass\n\n结论`：`fail'],
      ['code-split-word', '结论：pass\n\n结`论`：fail'],
      ['cgj-word', '结论：pass\n\n结\u034F论：fail'],
      ['cgj-entity', '结论：pass\n\n结&#847;论：fail'],
      ['cgj-before-colon', '结论：pass\n\n结论\u034F：fail'],
      ['vs16', '结论：pass\n\n结\uFE0F论：fail'],
      ['hangul-filler', '结论：pass\n\n结\u3164论：fail'],
      ['choseong-filler', '结论：pass\n\n结\u115F论：fail'],
      ['halfwidth-filler', '结论：pass\n\n结\uFFA0论：fail'],
      ['small-colon', '结论：pass\n\n结论\uFE55fail'],
      ['softbreak-split', '结论：pass\n\n结\n论：fail'],
      ['entity-newline-split', '结论：pass\n\n结&#10;论：fail'],
      ['image-alt', '结论：pass\n\n![结论：fail](https://example.invalid/i.png)'],
      ['prose-fail', '结论：pass\n\n本报告不通过'],
      ['prose-fail-2', '结论：pass\n\n本报告结论为 fail'],
      ['prose-fail-3', '结论：pass\n\n结论为不通过'],
      ['prose-fail-4', '结论：pass\n\n最终判定为不通过'],
      ['prose-fail-5', '结论：pass\n\n审计结果：不通过'],
      ['prose-fail-6', '结论：pass\n\n复核结论为 fail'],
      ['task-list', '结论：pass\n\n- [ ] 本报告不通过'],
      ['heading', '结论：pass\n\n## 本报告不通过'],
      ['emphasis', '结论：pass\n\n**本报告不通过**'],
      ['link', '结论：pass\n\n[本报告不通过](https://example.invalid)'],
      ['inline-code', '结论：pass\n\n本报告结论为 `fail`'],
      ['crossline-1', '结论：pass\n\n本报告结论\n为不通过'],
      ['crossline-2', '结论：pass\n\n本次审计\n结论：不通过'],
      ['crossline-3', '结论：pass\n\n本报告结论为\nfail'],
      ['table-cell', '结论：pass\n\n| 项 | 结果 |\n| --- | --- |\n| 审计 | 不通过 |'],
    ]
    for (const [name, payload] of payloads) {
      expect(auditConclusionOf(payload), name).toBeNull()
    }
    // 单边的可见 fail 结论要被采信，而不是丢掉后返回 null（P1-B-5）。
    expect(auditConclusionOf('结论`:`fail')).toBe('fail')
    // 反向控制：可见 pass 也不能被藏起来（P2-2）。
    expect(auditConclusionOf('结论：fail\n\n>    结论：pass')).toBeNull()
    expect(auditConclusionOf('结论：fail\n\n结论`:`pass')).toBeNull()
    // 普通叙述里出现“不通过”但不是结论时不能误杀。
    const safe = [
      '本报告不通过项已全部修复',
      '本次审计不通过原因如下',
      '本报告不合格品率为 0',
      '本报告不通过项统计见附表',
      '本次审计不通过项为 0',
      '本报告通过',
      '本报告结论为 pass',
      '攻击结果：fail',
      '本次审计结论：pass',
    ]
    for (const line of safe) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBe('pass')
  })

  it('S1 第十八轮 P0：可见中文否定句必须拒绝（S1 第十八轮 P0）', () => {
    const payloads = [
      '本报告不通过（P0 1 条）',
      '本报告不通过(P0 1)',
      '本报告不通过……',
      '复核意见 本报告不通过',
      '本人认为本报告不通过',
      '结论为不通过（P0 1 条）',
      '结论为 fail（P0 1 条）',
      '审计结果：不通过（P0 1 条）',
      '最终判定为不通过（P0 1 条）',
      '本报告不通过【P0 1】',
      '本报告不通过/不合格',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
    const safe = ['本报告不通过项已全部修复', '本次审计不通过原因如下', '本报告不合格品率为 0', '本报告不通过项统计见附表', '本次审计不通过项为 0']
    for (const line of safe) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBe('pass')
  })

  it('S1 第十八轮 P1：空白、实体、U+2236 与词内 FE55 拆字都要拒绝（S1 第十八轮 P1）', () => {
    const payloads = [
      '结 论：fail',
      '结  论：fail',
      '结\u00A0论：fail',
      '结\u3000论：fail',
      '结\t论：fail',
      '结&#13;论：fail',
      '结&#9;论：fail',
      '结&#160;论：fail',
      '结&#8194;论：fail',
      '结&#8239;论：fail',
      '结\u2028论：fail',
      '结\u2029论：fail',
      '结论\u2236fail',
      '结\uFE55论：fail',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
  })

  it('S1 第十八轮 P1-1：包裹型与收尾标点否定行必须拒绝', () => {
    const payloads = [
      '【结论：fail】',
      '「结论：fail」',
      '“结论：fail”',
      '《结论：fail》',
      '（结论：fail）',
      '［结论：fail］',
      '<结论：fail>',
      '**「结论：fail」**',
      '本报告不通过」',
      '本报告不通过……',
      '本报告不通过》',
      '本报告不通过>',
      '本报告不通过』',
      '本报告不通过〕',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
  })

  it('S1 第十八轮 P2-3：其余形似冒号也要拒绝', () => {
    const payloads = ['结论∶fail', '结论ːfail', '结论꞉fail', '结﹕论：fail']
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
  })

  it('S2 第二十三轮 P0-1：裸审计主语、连接号与英文否定句都要拒绝', () => {
    const payloads = [
      '审计未通过',
      '结论 - fail',
      '结论—fail',
      'The audit failed.',
      'The review did not pass.',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
    // 叙述性“未通过项”仍然不误杀。
    expect(auditConclusionOf('结论：pass\n\n审计未通过项为 0')).toBe('pass')
  })

  it('S1 第十九轮 P0-1/P0-2/P0-3：三行拆词、引号包裹与图片 alt 的否定句都要拒绝', () => {
    const payloads = [
      '本报告不\n通\n过',
      '"本报告不通过"',
      "'本报告不通过'",
      '‘本报告不通过’',
      '＂本报告不通过＂',
      '«本报告不通过»',
      '"结论：fail"',
      '![本报告不通过&#xFF08;P0 1 条&#xFF09;](x.png)',
      '![本报告不&nbsp;通过](x.png)',
      '![结论&colon;fail](x.png)',
      '![&#26412;&#25253;&#21578;&#19981;&#36890;&#36807;](x.png)',
      '!["本报告不通过"](x.png)',
      "!['本报告不通过'](x.png)",
      '![‘本报告不通过’](x.png)',
      '![&quot;本报告不通过&quot;](x.png)',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
  })

  it('S1 第二十轮 P0/P1：五行拆词、alt 不可见字符、收尾符号与同义否定都要拒绝', () => {
    const payloads = [
      '本\n报\n告不\n通\n过',
      '本 \n报 \n告不 \n通 \n过',
      '审计报告不通过',
      '本报告没有通过',
      '本报告并未通过',
      '本报告未获通过',
      '本报告不通過',
      '本报告结论为ｆａｉｌ',
      '本报告不（通过）',
      '„本报告不通过“',
      '〝本报告不通过〞',
      '｢本报告不通过｣',
      '本报告不通过🚫',
      '![本报告不&#8203;通过](x.png)',
      '![本报告不\u200b通过](x.png)',
      '![本报告不\u0301通过](x.png)',
      '![本报告不&ZeroWidthSpace;通过](x.png)',
      '![本报告不<wbr>通过](x.png)',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
    const safe = ['本报告不通过项已全部修复', '本次审计不通过项为 0', '审计未通过项为 0']
    for (const line of safe) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBe('pass')
  })

  it('S2 第二十四轮 P0-1：引号/括号/逗号/省略号/同义否定/连接号/英文变体都要拒绝', () => {
    const payloads = [
      '本次审计“未通过”', '本次审计结论为“不通过”', '本次审计"未通过"',
      '![本次审计“未通过”](x.png)', '本次审计（未通过）', '本次审计，未通过。', '本次审计...未通过',
      '审计没通过', '审计未获通过', '审计未能通过', '审计没有通过', '审核未通过', '复核未通过',
      '总的审计意见：未通过', '本次审计‑未通过', '本次审计﹣未通过', '本次审计－未通过',
      '本次审计‐未通过', '本次审计⁃未通过', '本次审计失败。', '本次审计未予通过。',
      '本次审计未得到通过。', '本次审计未过关。', '本次审计没过。', '本次审计通不过。',
      '本次审计不能通过。', '本次审计不是通过。', '审计ｆａｉｌ',
      'Audit: fail.', 'The audit fails.', 'The audit was unsuccessful.', "The audit didn't pass.",
      'The audit did fail.', 'Audit result: fail.', 'The audit is a failure.',
      'The audit was not successful.', 'The audit did not succeed.',
    ]
    for (const line of payloads) expect(auditConclusionOf('结论：pass\n\n' + line), line).toBeNull()
    expect(auditConclusionOf('结论：pass\n\n审计未通过项为 0')).toBe('pass')
    expect(auditConclusionOf('结论：pass\n\n本报告不通过项已全部修复')).toBe('pass')
  })

  it('门记录正文的三行拆词、引号包裹与图片 alt 否定句也要拒绝（S1 第十九轮 P0-4）', () => {
    const payloads = [
      '本报告不\n通\n过',
      '"本报告不通过"',
      '![本报告不通过&#xFF08;P0 1 条&#xFF09;](x.png)',
    ]
    for (const line of payloads) {
      const text = read().replace('\n## 必过项与证据', '\n' + line + '\n\n## 必过项与证据')
      expect(text, line).not.toBe(read())
      expect(() => check(text), line).toThrow(/正文结论/)
    }
  })

  it('门记录正文里的可见否定句也要拒绝（S1 第十八轮 P2-1）', () => {
    const text = read().replace('\n## 必过项与证据', '\n本报告不通过（P0 1 条）\n\n## 必过项与证据')
    expect(text).not.toBe(read())
    expect(() => check(text)).toThrow(/正文结论与 GateArtifact 不符/)
  })

  it('门记录正文的长行与偏移否定句也要拒绝（S1 第二十轮 P0-4）', () => {
    const payloads = [
      '复核补充：本报告不通过，详见附录。' + '注'.repeat(160),
      '复核补充：' + '前'.repeat(25) + '本报告不通过',
      '本\n报\n告不\n通\n过',
      '„本报告不通过“',
      '本报告不通过🚫',
      '![本报告不\u200b通过](x.png)',
    ]
    for (const payload of payloads) {
      const text = read().replace('\n## 必过项与证据', '\n' + payload + '\n\n## 必过项与证据')
      expect(text, payload).not.toBe(read())
      expect(() => check(text), payload).toThrow(/正文结论/)
    }
  })

  it('门记录正文顶部的结论必须与 GateArtifact 一致（S1 第十七轮 P2-1）', () => {
    const text = read().replace('- 结论：**pass**', '- 结论：**fail**')
    expect(() => check(text)).toThrow(/正文结论与 GateArtifact 不符/)
  })

  it('审计报告必须带唯一的门与候选提交绑定（S1 第八轮 P1-2）', () => {
    const commit = 'a'.repeat(40)
    expect(auditBindingOf('门：G1\n候选提交：' + commit)).toEqual({ gate: 'G1', commit })
    expect(auditBindingOf('Gate: G2\nCandidate: ' + 'b'.repeat(40))).toEqual({ gate: 'G2', commit: 'b'.repeat(40) })
    expect(auditBindingOf('门：G1')).toBeNull()
    expect(auditBindingOf('门：G1\n门：G2\n候选提交：' + commit)).toBeNull()
    expect(auditBindingOf('<!-- 门：G1\n候选提交：' + commit + ' -->')).toBeNull()
    expect(auditBindingOf('门：G1\n候选提交：abc')).toBeNull()
  })
})