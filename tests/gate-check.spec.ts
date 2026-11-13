import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { candidateEntries, verifyGateRecord } from '../scripts/gate-check.ts'

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

  it('前序门哈希链断了时拒绝（审计 R3-08）', () => {
    const text = tamper(readG2(), (a) => { a.previous_artifact_hash = 'b'.repeat(64) })
    expect(() => check(text)).toThrow(/重签链断了/)
  })

  it('审计轮次与审计报告对不上时拒绝（审计 R3-08）', () => {
    const text = tamper(read(), (a) => { a.audit_round = 9 })
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
