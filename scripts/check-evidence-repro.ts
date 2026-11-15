// 逐案例字节复现守卫（S2 第三十五轮 P1-1）：
// 门记录正文与证据都承诺「重跑出同样的字节」，可 gate-check 只比对已存字节，
// 看不到生成器漂移（夹具改了、schema 收紧、迁移加表都会让证据悄悄失真）。
// 这个脚本把每份证据重跑两遍：一遍对 HEAD 里的字节，一遍对本次的上一遍。
// 任何一处不一致就 exit 1 并逐条点名，重签前必须全绿。
//
// G3 的注入证据是「人工叙述 + 机器摘要」两段：叙述保留给人看，
// 生成结果用 `<!-- repro-sha256: ... -->` 摘要行钉住，脚本每次重算摘要比对。
// 这样 G3 也进了自动复现，而不是只有 G1/G2 绿。
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const CASES: Record<'G1' | 'G2', string[]> = {
  G1: ['G-01', 'G-02', 'G-08', 'G-09', 'G-14', 'G-15'],
  G2: ['G-03', 'G-04', 'G-05', 'G-07', 'ev-g2-01', 'ev-g2-02', 'ev-g2-03', 'ev-g2-04', 'ev-g2-05',
    'ev-g2-06', 'ev-g2-07', 'ev-g2-08', 'ev-g2-09', 'ev-g2-10', 'ev-g2-11', 'ev-g2-12', 'ev-g2-13', 'ev-g2-14', 'ev-g2-15'],
}

// G3 注入：生成器落在 G1/G2 子目录下，证据正文在 G3 目录，用摘要行绑定
const G3_DIGEST_CASES: { name: string; source: 'G1' | 'G2' }[] = [
  { name: 'G-06', source: 'G1' },
  { name: 'G-12', source: 'G1' },
  { name: 'G-16', source: 'G1' },
]

// G3 的另外三份注入证据不是副本，直接引用 G1/G2 的文件（见 docs/gates/G3.md 的 evidenceMap）。
// 这里做静态一致性：引用的文件必须真的在逐字节复现清单里，否则 G3 会借一份没人校验的文件过关。
const G3_REFERENCED: { gate: 'G1' | 'G2'; name: string }[] = [
  { gate: 'G1', name: 'G-01' },
  { gate: 'G1', name: 'G-02' },
  { gate: 'G2', name: 'G-04' },
]

const DIGEST_RE = /<!-- repro-sha256: ([0-9a-f]{64}) -->/

const normalize = (text: string): string => text.replace(/\r\n/g, '\n')

// 注入结果里带 uuidv7 生成的执行号（tex_…），每次跑都不同；
// 摘要只钉“事实”，不钉随机 id，其余字节仍然逐字比对。
const stabilize = (text: string): string => normalize(text).replace(/\b[a-z]{2,6}_[0-9a-f]{26,32}\b/g, '<id>')

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
  // 先证明 G3 引用的 G1/G2 证据确实在逐字节清单里（防止以后把引用改成没人校验的副本）
  for (const ref of G3_REFERENCED) {
    const name = ref.gate + '/' + ref.name
    const covered = Object.entries(CASES).some(([gate, names]) => gate === ref.gate && names.includes(ref.name))
    if (!covered) problems.push('docs/gates/evidence/' + name + '.md：G3 引用了这份证据，但它不在逐字节复现清单里')
  }
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

  for (const item of G3_DIGEST_CASES) {
    runCase(item.name, first)
    runCase(item.name, second)
    const file = 'docs/gates/evidence/G3/' + item.name + '.md'
    const committed = normalize(execFileSync('git', ['show', 'HEAD:' + file], { cwd: ROOT, encoding: 'utf8' }))
    const a = stabilize(readFileSync(join(first, item.source, item.name + '.md'), 'utf8'))
    const b = stabilize(readFileSync(join(second, item.source, item.name + '.md'), 'utf8'))
    const digest = createHash('sha256').update(a).digest('hex')
    const pinned = DIGEST_RE.exec(committed)?.[1] ?? null
    checked += 1
    if (a !== b) problems.push(file + '：同一次生成两遍字节不同，生成器不确定')
    else if (pinned === null) problems.push(file + '：缺少 <!-- repro-sha256: ... --> 摘要行，G3 证据没有进自动复现')
    else if (pinned !== digest) problems.push(file + '：注入结果摘要与 HEAD 记录不一致（当前 ' + digest.slice(0, 12) + '…），证据已漂移')
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
  console.log('证据复现成立：' + String(checked) + ' 份，每份重跑两遍都与 HEAD 字节一致（含 G3 注入摘要）')
}
