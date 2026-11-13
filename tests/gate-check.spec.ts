import { describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../src/core/canonical.ts'
import { verifyGateRecord } from '../scripts/gate-check.ts'

const read = () => readFileSync(join(process.cwd(), 'docs/gates/G1.md'), 'utf8')
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

describe('门记录校验', () => {
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
