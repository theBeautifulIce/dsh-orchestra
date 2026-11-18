// G5 证据生成器的纯函数测试：矩阵解析、分流、命令翻写、证据正文拼装。
// 只测纯函数：不在单测里真的跑 vitest，也不往仓库里落临时文件（合成矩阵放 os.tmpdir()）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_SPECS } from '../../scripts/gate-check.ts'
import { buildEvidenceFile, excerptOutput, parseMatrix, planRows, toCommand } from '../../scripts/gen-g5-evidence.ts'

const SPEC = GATE_SPECS.G5
if (!SPEC) throw new Error('固定口径里没有 G5 这道门')

// 合成就绪矩阵：1 个 proved（带证明用例）+ 1 个 gap + 1 个 proved 但证明用例为空
const SYNTHETIC_MATRIX = [
  '| 编号 | 判定语 | 证明用例 | 状态 | 缺口与建议 |',
  '| --- | --- | --- | --- | --- |',
  '| Q-01 | list_tasks 按 attention 排序 | tests/unit/g5-evidence-generator.spec.ts::按表头关键词定位列 | proved | 无 |',
  '| Q-02 | 面板在 1366×900 视口无横向溢出 | node scripts/visual-check.mjs | gap | 视觉回归还没接 |',
  '| Q-03 | 记忆批次部分写入能对账 |  | proved | 证明用例还没写 |',
].join('\n')

describe('parseMatrix', () => {
  it('按表头关键词定位列，列序与契约不同也能解析', () => {
    const text = [
      '| 状态 | 证明用例 | 编号 | 判定语 | 缺口与建议 |',
      '| --- | --- | --- | --- | --- |',
      '| proved | tests/x.spec.ts::用例 | Q-01 | 排序口径 | 无 |',
    ].join('\n')
    const rows = parseMatrix(text)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('Q-01')
    expect(rows[0]?.status).toBe('proved')
    expect(rows[0]?.proof).toBe('tests/x.spec.ts::用例')
    expect(rows[0]?.verdict).toBe('排序口径')
  })

  it('表头后面没有分隔行就不算表：解析不出条目', () => {
    const text = ['| 编号 | 状态 | 证明用例 |', '| Q-01 | proved | tests/x.spec.ts |'].join('\n')
    expect(parseMatrix(text)).toEqual([])
  })

  it('状态取值归一化：大小写不敏感，不可识别的不算 proved', () => {
    const text = [
      '| 编号 | 状态 | 证明用例 |',
      '| --- | --- | --- |',
      '| Q-01 | PROVED | tests/x.spec.ts |',
      '| Q-02 | Partial | tests/x.spec.ts |',
      '| Q-03 | 说不清 | tests/x.spec.ts |',
    ].join('\n')
    const rows = parseMatrix(text)
    expect(rows.map((r) => r.status)).toEqual(['proved', 'partial', 'unknown'])
  })

  it('合成矩阵放在临时目录里读回来也解析得到三行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5-matrix-'))
    try {
      const file = join(dir, 'S5-g5-item-map.md')
      writeFileSync(file, SYNTHETIC_MATRIX, 'utf8')
      const rows = parseMatrix(readFileSync(file, 'utf8'))
      expect(rows.map((r) => r.id)).toEqual(['Q-01', 'Q-02', 'Q-03'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('planRows', () => {
  it('只有 proved 且有证明用例的条目可跑，其余进缺口清单', () => {
    const { plans, gaps } = planRows(parseMatrix(SYNTHETIC_MATRIX), SPEC)
    expect(plans.map((p) => p.id)).toEqual(['Q-01'])
    expect(gaps.map((g) => g.id)).toEqual(['Q-02', 'Q-03'])
    expect(gaps[1]?.reason).toMatch(/证明用例为空/)
  })

  it('证据路径逐字取自固定口径，不自己拼', () => {
    const { plans } = planRows(parseMatrix(SYNTHETIC_MATRIX), SPEC)
    expect(plans[0]?.evidenceId).toBe('ev-g5-q-01')
    expect(plans[0]?.file).toBe('docs/gates/evidence/G5/Q-01.md')
  })

  it('固定口径里没有的编号不写文件，进缺口清单', () => {
    const { plans, gaps } = planRows(parseMatrix([
      '| 编号 | 状态 | 证明用例 |',
      '| --- | --- | --- |',
      '| Q-99 | proved | tests/x.spec.ts |',
    ].join('\n')), SPEC)
    expect(plans).toEqual([])
    expect(gaps[0]?.reason).toMatch(/证据映射/)
  })
})

describe('toCommand', () => {
  it('file::用例名 翻成 vitest 命令', () => {
    expect(toCommand('tests/x.spec.ts::用例名')).toBe('pnpm vitest run "tests/x.spec.ts" -t "用例名"')
  })

  it('现成命令原样透传，反引号被清掉', () => {
    expect(toCommand('`node scripts/visual-check.mjs`')).toBe('node scripts/visual-check.mjs')
  })
})

describe('buildEvidenceFile', () => {
  const base = {
    id: 'Q-01',
    verdict: 'list_tasks 按 attention 排序',
    proof: 'tests/x.spec.ts::用例名',
    command: 'pnpm vitest run "tests/x.spec.ts" -t "用例名"',
    exitCode: 0,
    timedOut: false,
    output: '      Tests  1 passed (1)',
  }

  it('正文含标题、判定语、证明用例、复现命令、退出码与输出摘录', () => {
    const body = buildEvidenceFile(base)
    expect(body.startsWith('# G5 门证据：Q-01 — list_tasks 按 attention 排序')).toBe(true)
    expect(body).toContain('- 判定语：list_tasks 按 attention 排序')
    expect(body).toContain('- 证明用例：tests/x.spec.ts::用例名')
    expect(body).toContain('- 复现命令：pnpm vitest run "tests/x.spec.ts" -t "用例名"')
    expect(body).toContain('- 结果：通过（退出码 0）')
    expect(body).toContain('## 输出摘录')
    expect(body).toContain('1 passed')
  })

  it('命令没通过就抛错，不产出通过证据', () => {
    expect(() => buildEvidenceFile({ ...base, exitCode: 1 })).toThrow(/退出码/)
    expect(() => buildEvidenceFile({ ...base, timedOut: true })).toThrow(/超时/)
  })

  it('输出摘录截断到 4000 字符以内', () => {
    const excerpt = excerptOutput('x'.repeat(9000))
    expect(excerpt.length).toBeLessThanOrEqual(4000)
    expect(excerpt).toMatch(/输出已截断/)
    expect(buildEvidenceFile({ ...base, output: 'x'.repeat(9000) + '\n' + base.output })).toContain('输出已截断')
  })

  it('Vitest 全跳过即使退出码为 0 也不能生成通过证据', () => {
    expect(() => buildEvidenceFile({ ...base, output: '      Tests  1 skipped (1)' })).toThrow(/没有通过的用例/)
    expect(buildEvidenceFile({ ...base, output: '      Tests  1 passed | 4 skipped (5)' })).toContain('通过（退出码 0）')
  })
})
