#!/usr/bin/env node
// 测试文件放置与分类规范检查（docs/agents/testing-conventions.md 的强制实现）
// 规则：
//   1. tests/ 下所有 *.spec.ts 必须位于 tests/<category>/ 内，category ∈ {unit,integration,contract,e2e,gate}
//   2. tests/ 根目录只允许放 README.md、fixtures/、helpers/，不得直接放 *.spec.ts
//   3. 仓库根目录与 tests/ 下不得出现 tmp-* / probe-* / scratch-* / *.tmp.* 之类的临时文件
//   4. 临时探针文件名不得以 .spec.ts 结尾（避免被 vitest include 命中并污染用例计数）
//   5. 共享夹具只放 tests/fixtures/，文件名不得以 .spec.ts 结尾
//   6. spec 文件名只允许小写 kebab-case（字母、数字、连字符）
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1').replace(/\\/g, '/')
const TESTS = join(ROOT, 'tests')
const CATEGORIES = new Set(['unit', 'integration', 'contract', 'e2e', 'gate'])
const ALLOWED_ROOT_ENTRIES = new Set(['README.md', 'fixtures', 'helpers'])
const TMP_PREFIX = /^(tmp[-_.]|probe[-_.]|scratch[-_.]|debug[-_.]|probe-|tmp-)/i
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.spec\.(ts|tsx)$/

const violations = []
const note = (file, msg) => violations.push(relative(ROOT, file).split(sep).join('/') + ': ' + msg)

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// 规则 3：仓库根与 tests/ 下的临时文件
for (const p of [join(ROOT, ...readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isFile())), ...walk(TESTS, [])]) {
  const base = p.slice(p.lastIndexOf(sep) + 1)
  const rel = relative(ROOT, p).split(sep).join('/')
  if (TMP_PREFIX.test(base) && !base.endsWith('.md')) {
    if (rel.startsWith('tmp/') || rel.startsWith('.tmp/')) continue
    note(p, '临时文件放在仓库根或 tests/ 下：临时探针统一放 tmp/ 或 .tmp/（两者都已在 .gitignore 中）')
  }
}

// 规则 1、2、4、5、6
const rootEntries = readdirSync(TESTS)
for (const name of rootEntries) {
  const p = join(TESTS, name)
  if (statSync(p).isDirectory()) {
    if (name === 'fixtures' || name === 'helpers') continue
    if (!CATEGORIES.has(name)) note(p, '未知分类目录：只允许 unit / integration / contract / e2e / gate')
    continue
  }
  if (name === 'README.md') continue
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) {
    note(p, 'spec 文件必须放在 tests/<分类>/ 目录下，不能留在 tests/ 根')
  } else {
    note(p, 'tests/ 根目录只允许 README.md、fixtures/、helpers/')
  }
}

for (const p of walk(TESTS, [])) {
  const rel = relative(ROOT, p).split(sep).join('/')
  const base = p.slice(p.lastIndexOf(sep) + 1)
  const parts = rel.split('/')
  const inFixtures = parts[1] === 'fixtures'
  const inHelpers = parts[1] === 'helpers'
  if (inFixtures || inHelpers) {
    if (base.endsWith('.spec.ts') || base.endsWith('.spec.tsx')) {
      note(p, '夹具与辅助模块不得命名为 .spec.ts（会被 vitest 当成用例收集）')
    }
    continue
  }
  if (!base.endsWith('.spec.ts') && !base.endsWith('.spec.tsx')) continue
  if (parts.length !== 3) {
    note(p, 'spec 文件必须位于 tests/<分类>/<name>.spec.ts')
    continue
  }
  if (!CATEGORIES.has(parts[1])) note(p, '未知分类目录：只允许 unit / integration / contract / e2e / gate')
  if (!NAME_RE.test(base)) note(p, 'spec 文件名必须是 kebab-case：' + NAME_RE.source)
}

// 规则 4：临时探针不得使用 .spec.ts 后缀
for (const p of walk(TESTS, [])) {
  const base = p.slice(p.lastIndexOf(sep) + 1)
  if ((base.endsWith('.spec.ts') || base.endsWith('.spec.tsx')) && TMP_PREFIX.test(base)) {
    note(p, '临时探针不得命名为 .spec.ts（会被 vitest include 命中并污染用例计数）')
  }
}

if (violations.length > 0) {
  console.error('测试布局检查失败（见 docs/agents/testing-conventions.md）：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log('测试布局检查通过：spec 文件均在 tests/<分类>/ 下，无临时文件混入。')
