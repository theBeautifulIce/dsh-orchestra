import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyGateRecord } from '../scripts/gate-check.ts'

const read = () => readFileSync(join(process.cwd(), 'docs/gates/G1.md'), 'utf8')

describe('门记录校验', () => {
  it('G1 门记录通过', () => {
    const out = verifyGateRecord(read())
    expect(out.gate).toBe('G1')
    expect(out.items).toBeGreaterThanOrEqual(13)
  })

  it('必过项改成 fail 时报哪一项', () => {
    const text = read().replace(/"id": "G-08",\s*"result": "pass"/, '"id": "G-08", "result": "fail"')
    expect(text).toContain('"id": "G-08", "result": "fail"')
    expect(() => verifyGateRecord(text)).toThrow(/必过项没过: G-08/)
  })

  it('改 candidate_hash 但锚点不动时报哈希不符', () => {
    const text = read().replace(/"candidate_hash": "[0-9a-f]{64}"/, '"candidate_hash": "' + 'a'.repeat(64) + '"')
    expect(() => verifyGateRecord(text)).toThrow(/artifact_hash 与正文不符/)
  })

  it('缺字段时点名缺哪个', () => {
    const text = read().replace('"producer": "human"', '"producerx": "human"')
    expect(() => verifyGateRecord(text)).toThrow(/缺字段: producer/)
  })

  it('无 json 块时直接报找不到', () => {
    expect(() => verifyGateRecord('# 空记录\n')).toThrow(/找不到 GateArtifact/)
  })
})
