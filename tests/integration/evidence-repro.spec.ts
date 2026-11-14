import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 证据复现守卫（S2 第三十五轮 P1-1）：门记录承诺「重跑出同样的字节」，
// 但 gate-check 只比对已存字节，生成器漂移它看不见。全量 35 份走 scripts/check-evidence-repro.ts，
// 用例里挑两条快的守底线：同一次生成两遍必须字节相同，且与 HEAD 里存的字节相同。
const CASES: [string, string][] = [
  ['G1', 'G-01'],
  ['G2', 'ev-g2-11'],
]

const normalize = (text: string): string => text.replace(/\r\n/g, '\n')

describe('注入证据可重跑出同样字节', () => {
  for (const [gate, name] of CASES) {
    it(name + ' 重跑两遍与 HEAD 字节一致', () => {
      const a = mkdtempSync(join(tmpdir(), 'evidence-repro-a-'))
      const b = mkdtempSync(join(tmpdir(), 'evidence-repro-b-'))
      try {
        for (const root of [a, b]) {
          const result = spawnSync(
            process.execPath,
            ['--experimental-strip-types', '--no-warnings', 'scripts/fault-inject.ts', '--case', name, '--out', root],
            { cwd: process.cwd(), encoding: 'utf8' },
          )
          expect(result.status, result.stderr).toBe(0)
        }
        const rel = 'docs/gates/evidence/' + gate + '/' + name + '.md'
        const committed = normalize(execFileSync('git', ['show', 'HEAD:' + rel], { cwd: process.cwd(), encoding: 'utf8' }))
        const first = normalize(readFileSync(join(a, gate, name + '.md'), 'utf8'))
        const second = normalize(readFileSync(join(b, gate, name + '.md'), 'utf8'))
        expect(first, '同一次生成两遍字节不同，生成器不确定').toBe(second)
        expect(first, rel + ' 重跑与 HEAD 字节不一致：证据已漂移，重生成后重签').toBe(committed)
      } finally {
        rmSync(a, { recursive: true, force: true })
        rmSync(b, { recursive: true, force: true })
      }
    }, 120000)
  }
})
