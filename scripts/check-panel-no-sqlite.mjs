#!/usr/bin/env node
// 面板侧不许有 sqlite 直连：面板只走 HTTP/SSE，orchestra.db 的写权限与它无关。
// 命中就打印文件行号并 exit 1；干净则 exit 0。
// 用法：node scripts/check-panel-no-sqlite.mjs [扫描目录]（默认 src/client）
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src', 'client')
const PATTERNS = ['sqlite', 'orchestra.db', 'node:sqlite', 'better-sqlite3', ':memory:']

function collectFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...collectFiles(full))
    else found.push(full)
  }
  return found
}

const files = collectFiles(target)
const hits = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const lower = line.toLowerCase()
    for (const pattern of PATTERNS) {
      if (lower.includes(pattern)) {
        hits.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: index + 1, pattern, text: line.trim() })
      }
    }
  })
}

if (hits.length > 0) {
  for (const hit of hits) {
    console.log(`${hit.file}:${hit.line} 命中「${hit.pattern}」: ${hit.text}`)
  }
  console.error(`面板源码有 ${hits.length} 处 sqlite 直连痕迹`)
  process.exit(1)
}

console.log(`面板源码没有 sqlite 直连痕迹：已扫描 ${files.length} 个文件（${relative(ROOT, target).replace(/\\/g, '/')}）`)
process.exit(0)
