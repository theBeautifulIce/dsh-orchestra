// 逐案例字节复现守卫（S2 第三十五轮 P1-1）：
// 门记录正文与证据都承诺「重跑出同样的字节」，可 gate-check 只比对已存字节，
// 看不到生成器漂移（夹具改了、schema 收紧、迁移加表都会让证据悄悄失真）。
// 这个脚本把每份证据重跑两遍：一遍对 HEAD 里的字节，一遍对本次的上一遍。
// 任何一处不一致就 exit 1 并逐条点名，重签前必须全绿。
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const CASES: Record<'G1' | 'G2', string[]> = {
  G1: ['G-01', 'G-02', 'G-08', 'G-09', 'G-14', 'G-15'],
  G2: ['G-03', 'G-04', 'G-05', 'G-07', 'ev-g2-01', 'ev-g2-02', 'ev-g2-03', 'ev-g2-04', 'ev-g2-05',
    'ev-g2-06', 'ev-g2-07', 'ev-g2-08', 'ev-g2-09', 'ev-g2-10', 'ev-g2-11', 'ev-g2-12', 'ev-g2-13', 'ev-g2-14', 'ev-g2-15'],
}

const normalize = (text: string): string => text.replace(/\r\n/g, '\n')

function runCase(name: string, outRoot: string): void {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/fault-inject.ts', '--case', name, '--out', outRoot], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(name + ' 跑不起来（exit ' + String(result.status) + '）：' + (result.stderr || '').split('\n').slice(0, 4).join(' | '))
  }
}

const first = mkdtempSync(join(tmpdir(), 'evidence-repro-a-'))
const second = mkdtempSync(join(tmpdir(), 'evidence-repro-b-'))
const problems: string[] = []
let checked = 0
try {
  for (const [gate, cases] of Object.entries(CASES)) {
    for (const name of cases) {
      runCase(name, first)
      runCase(name, second)
      const file = 'docs/gates/evidence/' + gate + '/' + name + '.md'
      const committed = normalize(execFileSync('git', ['show', 'HEAD:' + file], { cwd: ROOT, encoding: 'utf8' }))
      const a = normalize(readFileSync(join(first, gate, name + '.md'), 'utf8'))
      const b = normalize(readFileSync(join(second, gate, name + '.md'), 'utf8'))
      checked += 1
      if (a !== b) problems.push(file + '：同一次生成两遍字节不同，生成器不确定')
      else if (a !== committed) problems.push(file + '：重跑与 HEAD 字节不一致，证据已漂移，重生成并重签')
    }
  }
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err))
} finally {
  rmSync(first, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('证据复现不成立（' + String(problems.length) + '/' + String(checked + problems.length) + ' 份）：')
  for (const p of problems) console.error(' - ' + p)
  process.exitCode = 1
} else {
  console.log('证据复现成立：' + String(checked) + ' 份，每份重跑两遍都与 HEAD 字节一致')
}
