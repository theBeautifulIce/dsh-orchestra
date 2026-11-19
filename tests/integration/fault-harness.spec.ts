import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCase } from '../../scripts/fault-inject.ts'

function runCli(evidenceRoot: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'scripts/fault-inject.ts', '--out', evidenceRoot, ...args],
    { encoding: 'utf8', timeout: 30_000 },
  )
}

describe('故障注入案例分发', () => {
  it('runCase 拒绝未登记案例', async () => {
    await expect(runCase('G-99')).rejects.toThrow('Unknown fault injection case ID: "G-99"')
  })

  it('CLI 拒绝未登记案例 G-99，不创建证据目录', () => {
    const temp = mkdtempSync(join(tmpdir(), 'fault-harness-'))
    try {
      const evidenceRoot = join(temp, 'evidence')
      const result = runCli(evidenceRoot, '--case', 'G-99')
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('Unknown fault injection case ID: "G-99"')
      expect(result.stdout).toBe('')
      expect(existsSync(evidenceRoot)).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 35_000)

  it('CLI 报告缺失案例 ID，不创建证据目录', () => {
    const temp = mkdtempSync(join(tmpdir(), 'fault-harness-'))
    try {
      const evidenceRoot = join(temp, 'evidence')
      const result = runCli(evidenceRoot, '--case')
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('Missing fault injection case ID after --case')
      expect(existsSync(evidenceRoot)).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 35_000)

  it.each([
    { caseId: 'G-01', gate: 'G1', args: [] },
    { caseId: 'ev-g2-13', gate: 'G2', args: ['--case', 'ev-g2-13'] },
  ])('CLI 运行已登记案例 $caseId 并写入 $gate 证据', ({ caseId, gate, args }) => {
    const temp = mkdtempSync(join(tmpdir(), 'fault-harness-'))
    try {
      const evidenceRoot = join(temp, 'evidence')
      const result = runCli(evidenceRoot, ...args)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ case: caseId })
      const evidence = readFileSync(join(evidenceRoot, gate, `${caseId}.md`), 'utf8')
      expect(evidence).toContain(`# ${caseId}\n`)
      expect(evidence).toContain('## 对账查询')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 35_000)
})
