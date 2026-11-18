// G5 门证据生成器：把「G5 必过项就绪矩阵」变成门证据文件
//
// 用法：node --no-warnings scripts/gen-g5-evidence.ts [--matrix <path>] [--out-root <dir>] [--timeout <ms>]
//   --matrix    就绪矩阵路径，默认 docs/reviews/S5-g5-item-map.md
//   --out-root  证据落盘的根目录，默认仓库根；写出的相对路径逐字等于固定口径里的路径
//   --timeout   单条命令超时毫秒，默认 600000（10 分钟）
//
// 路径口径（不自己拼）：item id → GATE_SPECS.G5.evidenceMap[id][0] → GATE_SPECS.G5.evidenceFiles[evidenceId]
// 证据正文口径：标题行（编号 + 判定语）、证明用例原文、复现命令、结果与退出码、## 输出摘录
// 纪律：只为「状态=proved 且证明用例非空」的条目写文件；命令跑不通（退出码非 0 / 超时）不写文件，进失败清单；
//       partial / gap / 空证明用例不写文件，进缺口清单。跑不出来就不写「通过」，输出也不编。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_SPECS, type GateSpec } from './gate-check.ts'

export const MATRIX_DEFAULT = 'docs/reviews/S5-g5-item-map.md'
export const OUTPUT_LIMIT = 4000
export const TIMEOUT_DEFAULT = 600_000
export const GATE = 'G5'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export type MatrixRow = {
  id: string
  verdict: string
  proof: string
  status: string
  gap: string
}

export type ProofPlan = {
  id: string
  verdict: string
  proof: string
  evidenceId: string
  file: string
}

export type GapEntry = { id: string; reason: string }

export type CommandResult = {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  output: string
}

export type EvidenceFileInput = {
  id: string
  verdict: string
  proof: string
  command: string
  exitCode: number | null
  timedOut: boolean
  output: string
  matrixPath?: string
}

// ---------------------------------------------------------------- 纯函数

// 单元格清洗：去反引号、去 markdown 强调标记、去掉首尾空白（证明用例的原文要保留）
function cleanCell(cell: string): string {
  let s = cell.trim()
  s = s.replace(/^\`+/, '').replace(/\`+$/, '').trim()
  s = s.replace(/^\*\*+/, '').replace(/\*\*+$/, '').trim()
  s = s.replace(/^\*+/, '').replace(/\*+$/, '').trim()
  return s
}

// 折叠空白：编号、判定语、状态、缺口这些列只读内容，不需要保留原始排版
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function splitRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  const body = trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed.slice(1)
  return body.split('|').map((c) => cleanCell(c))
}

// 分隔行：| --- | --- | 或 |---|---|
function isSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  const cells = splitRow(trimmed)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

function findColumn(headers: string[], test: (h: string) => boolean): number {
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] ?? '').toLowerCase()
    if (test(h)) return i
  }
  return -1
}

function cellAt(cells: string[], index: number): string {
  if (index < 0) return ''
  return collapse(cells[index] ?? '')
}

export function normalizeStatus(raw: string): string {
  const s = collapse(raw).toLowerCase()
  if (s === 'proved' || s === 'partial' || s === 'gap') return s
  return 'unknown'
}

/**
 * 解析就绪矩阵：按表头关键词定位列，不写死列序。
 * 只有「表头行 + 紧随其后的分隔行」才算表头；缺编号/状态/证明列的表跳过继续找下一张表。
 */
export function parseMatrix(text: string): MatrixRow[] {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i] ?? ''
    if (!headerLine.includes('|')) continue
    if (!isSeparator(lines[i + 1] ?? '')) continue
    const headers = splitRow(headerLine)
    const idCol = findColumn(headers, (h) => h.includes('编号') || h.includes('id'))
    const statusCol = findColumn(headers, (h) => h.includes('状态'))
    const proofCol = findColumn(headers, (h) => h.includes('证明'))
    if (idCol < 0 || statusCol < 0 || proofCol < 0) continue
    let verdictCol = findColumn(headers, (h) => h.includes('判定') || h.includes('内容') || h.includes('描述') || h.includes('结论'))
    if (verdictCol < 0) {
      const fallback = idCol + 1
      if (fallback !== statusCol && fallback !== proofCol && fallback < headers.length) verdictCol = fallback
    }
    const gapCol = findColumn(headers, (h) => h.includes('缺口') || h.includes('建议'))
    const rows: MatrixRow[] = []
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (!line.includes('|')) break
      if (isSeparator(line)) continue
      const cells = splitRow(line)
      const id = cellAt(cells, idCol)
      if (!id) continue
      rows.push({
        id,
        verdict: cellAt(cells, verdictCol),
        proof: cleanCell(cells[proofCol] ?? ''),
        status: normalizeStatus(cellAt(cells, statusCol)),
        gap: cellAt(cells, gapCol),
      })
    }
    if (rows.length > 0) return rows
  }
  return []
}

/**
 * 把「证明用例」单元格翻成可直接执行的命令：
 *   tests/x.spec.ts::用例名  →  pnpm vitest run "tests/x.spec.ts" -t "用例名"
 *   一条现成命令             →  原样执行
 */
export function toCommand(proof: string): string {
  const raw = cleanCell(proof)
  const at = raw.indexOf('::')
  if (at > 0) {
    const file = raw.slice(0, at).trim()
    const name = raw.slice(at + 2).trim().replace(/"/g, '').trim()
    if (file) {
      if (name) return 'pnpm vitest run "' + file + '" -t "' + name + '"'
      return 'pnpm vitest run "' + file + '"'
    }
  }
  return raw
}

/**
 * 分流：只有「状态=proved 且证明用例非空 且固定口径里有证据映射」的条目可跑，
 * 其余全部进缺口清单，不写文件。
 */
export function planRows(rows: MatrixRow[], spec: GateSpec): { plans: ProofPlan[]; gaps: GapEntry[] } {
  const plans: ProofPlan[] = []
  const gaps: GapEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.id) {
      gaps.push({ id: '(空编号)', reason: '这一行没有编号' })
      continue
    }
    if (seen.has(row.id)) {
      gaps.push({ id: row.id, reason: '编号在矩阵里重复' })
      continue
    }
    seen.add(row.id)
    if (row.status !== 'proved') {
      gaps.push({ id: row.id, reason: '状态不是 proved（当前 ' + (row.status === 'unknown' ? '不可识别' : row.status) + '）' })
      continue
    }
    if (!row.proof) {
      gaps.push({ id: row.id, reason: '证明用例为空' })
      continue
    }
    const evidenceId = spec.evidenceMap[row.id]?.[0]
    if (!evidenceId) {
      gaps.push({ id: row.id, reason: '固定口径里没有这一项的证据映射' })
      continue
    }
    const file = spec.evidenceFiles[evidenceId]
    if (!file) {
      gaps.push({ id: row.id, reason: '固定口径里没有证据 ' + evidenceId + ' 的文件路径' })
      continue
    }
    plans.push({ id: row.id, verdict: row.verdict, proof: row.proof, evidenceId, file })
  }
  return { plans, gaps }
}

/** 输出摘录：stdout + stderr 合并后截断到 limit 个字符以内 */
export function excerptOutput(text: string, limit: number = OUTPUT_LIMIT): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.length <= limit) return normalized
  const marker = '\n…（输出已截断）'
  return normalized.slice(0, Math.max(0, limit - marker.length)) + marker
}

/**
 * 证据正文：标题行（编号 + 判定语）、证明用例原文、复现命令、结果与退出码、## 输出摘录。
 * 命令没通过就抛错：证据文件只允许写「真跑通了」的条目。
 */
export function buildEvidenceFile(input: EvidenceFileInput): string {
  if (input.timedOut) throw new Error('证据 ' + input.id + ' 的命令超时，不写通过证据')
  if (input.exitCode !== 0) {
    throw new Error('证据 ' + input.id + ' 的命令退出码是 ' + String(input.exitCode) + '，不写通过证据')
  }
  if (missingVitestProof(input.command, input.output)) {
    throw new Error('证据 ' + input.id + ' 的 Vitest 命令没有通过的用例')
  }
  const excerpt = excerptOutput(input.output)
  const fence = excerpt.includes('```') ? '````' : '```'
  const lines = [
    '# G5 门证据：' + input.id + (input.verdict ? ' — ' + input.verdict : ''),
    '',
    '- 编号：' + input.id,
    '- 判定语：' + (input.verdict || '（就绪矩阵未给判定语）'),
    '- 证明用例：' + input.proof,
    '- 复现命令：' + input.command,
    '- 结果：通过（退出码 0）',
    '- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 ' + (input.matrixPath ?? MATRIX_DEFAULT) + '）',
    '',
    '## 输出摘录',
    '',
    fence + 'text',
    excerpt,
    fence,
    '',
  ]
  return lines.join('\n')
}

function missingVitestProof(command: string, output: string): boolean {
  if (!/\bvitest\s+run\b/.test(command)) return false
  const plain = output.replace(/\x1B\[[0-9;]*m/g, '')
  return !/^\s*Tests\s+[1-9]\d* passed\b/m.test(plain)
}

// ---------------------------------------------------------------- 命令执行

// Windows 下 cmd.exe 在很长的 PATH 尾部找不到 pnpm（npm 全局目录常常排在最后），
// 于是把全局 shim 目录拼到子进程 PATH 最前面；命令字符串本身保持原样，证据里的「复现命令」
// 仍然与就绪矩阵原文一致。
let cachedShimDirs: string[] | null = null

function shimDirs(): string[] {
  if (cachedShimDirs) return cachedShimDirs
  const dirs: string[] = []
  const push = (dir: string): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      const dir = join(appData, 'npm')
      if (existsSync(join(dir, 'pnpm.cmd')) || existsSync(join(dir, 'npm.cmd'))) push(dir)
    }
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      const dir = join(localAppData, 'pnpm')
      if (existsSync(join(dir, 'pnpm.cmd'))) push(dir)
    }
    for (const name of ['pnpm', 'pnpm.cmd', 'npm', 'npx']) {
      const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      if (found.status !== 0) continue
      const stdout = typeof found.stdout === 'string' ? found.stdout : ''
      for (const line of stdout.split(/\r?\n/)) {
        const hit = line.trim()
        if (hit) push(dirname(hit))
      }
    }
  }
  cachedShimDirs = dirs
  return dirs
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const currentPath = process.env.PATH ?? process.env.Path ?? ''
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue
    if (value !== undefined) env[key] = value
  }
  env.PATH = [...shimDirs(), currentPath].filter(Boolean).join(delimiter)
  return env
}

export function runCommand(command: string, cwd: string, timeoutMs: number): CommandResult {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: childEnv(),
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const err = result.error as NodeJS.ErrnoException | undefined
  const timedOut = err?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
  const exitCode = typeof result.status === 'number' ? result.status : null
  const parts: string[] = []
  const out = stdout.trimEnd()
  const errText = stderr.trimEnd()
  if (out) parts.push(out)
  if (errText) parts.push('--- stderr ---\n' + errText)
  return { ok: !timedOut && exitCode === 0, exitCode, timedOut, output: parts.join('\n') }
}

// ---------------------------------------------------------------- 主流程

type Options = { matrix: string; outRoot: string; timeoutMs: number }

function parseArgs(argv: string[]): Options {
  const opts: Options = { matrix: MATRIX_DEFAULT, outRoot: ROOT, timeoutMs: TIMEOUT_DEFAULT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const take = (): string => {
      const eq = arg.indexOf('=')
      if (eq > 0) return arg.slice(eq + 1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        i += 1
        return next
      }
      return ''
    }
    if (arg === '--matrix' || arg.startsWith('--matrix=')) opts.matrix = take() || opts.matrix
    else if (arg === '--out-root' || arg.startsWith('--out-root=')) opts.outRoot = take() || opts.outRoot
    else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const value = Number(take())
      if (Number.isFinite(value) && value > 0) opts.timeoutMs = value
    } else {
      throw new Error('不认识的参数：' + arg)
    }
  }
  return opts
}

function main(argv: string[]): number {
  const opts = parseArgs(argv)
  const spec = GATE_SPECS[GATE]
  if (!spec) {
    console.error('没有这道门的固定口径：' + GATE)
    return 1
  }
  const matrixPath = resolve(ROOT, opts.matrix)
  const outRoot = resolve(ROOT, opts.outRoot)
  let text: string
  try {
    text = readFileSync(matrixPath, 'utf8')
  } catch (err) {
    console.error('读不到就绪矩阵 ' + matrixPath + '：' + (err instanceof Error ? err.message : String(err)))
    return 1
  }
  const rows = parseMatrix(text)
  if (rows.length === 0) {
    console.error('就绪矩阵里没找到含编号/状态/证明列的表格：' + matrixPath)
    return 1
  }
  const { plans, gaps } = planRows(rows, spec)
  console.log('就绪矩阵：' + matrixPath)
  console.log('矩阵条目 ' + String(rows.length) + ' 项，固定必过项 ' + String(spec.items.length) + ' 项')
  console.log('可跑 ' + String(plans.length) + ' 条，缺口 ' + String(gaps.length) + ' 条')

  const failures: { id: string; reason: string }[] = []
  const written: { id: string; file: string }[] = []
  let index = 0
  for (const plan of plans) {
    index += 1
    const command = toCommand(plan.proof)
    process.stdout.write('[' + String(index) + '/' + String(plans.length) + '] ' + plan.id + ' … ')
    const result = runCommand(command, ROOT, opts.timeoutMs)
    const noTestsPassed = missingVitestProof(command, result.output)
    if (!result.ok || noTestsPassed) {
      const reason = result.timedOut
        ? '命令超时（超过 ' + String(opts.timeoutMs) + 'ms）'
        : result.ok ? 'Vitest 命令没有通过的用例' : '退出码 ' + String(result.exitCode)
      failures.push({ id: plan.id, reason })
      console.log('失败：' + reason)
      continue
    }
    const body = buildEvidenceFile({
      id: plan.id,
      verdict: plan.verdict,
      proof: plan.proof,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.output,
      matrixPath: opts.matrix,
    })
    const target = join(outRoot, plan.file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
    written.push({ id: plan.id, file: plan.file })
    console.log('通过 → ' + plan.file)
  }

  console.log('')
  console.log('已写 ' + String(written.length) + ' 份 / 失败 ' + String(failures.length) + ' 条 / 缺口 ' + String(gaps.length) + ' 条')
  if (written.length > 0) {
    console.log('写出的证据文件：')
    for (const w of written) console.log(' - ' + w.id + ' → ' + w.file)
  }
  if (failures.length > 0) {
    console.log('失败清单：')
    for (const f of failures) console.log(' - ' + f.id + '：' + f.reason)
  }
  if (gaps.length > 0) {
    console.log('缺口清单：')
    for (const g of gaps) console.log(' - ' + g.id + '：' + g.reason)
  }
  return failures.length > 0 || gaps.length > 0 ? 1 : 0
}

if (process.argv[1] && /gen-g5-evidence\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  process.exitCode = main(process.argv.slice(2))
}
