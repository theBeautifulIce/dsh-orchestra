// WP-A：Q-22 面板不许有 sqlite 直连 —— 跑静态检查脚本并断言结果。
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-panel-no-sqlite.mjs')

function runScript(target?: string) {
  return spawnSync(process.execPath, target ? [SCRIPT, target] : [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
}

describe('Q-22 面板静态检查没有 sqlite 直连', () => {
  it('Q-22 面板无 orchestra.db 写权限也能工作，静态检查无 sqlite 直连', () => {
    const result = runScript()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('没有 sqlite 直连痕迹')
    expect(result.stderr).toBe('')
  })

  it('Q-22 检查脚本本身会抓出 sqlite 直连（不是空壳断言）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-sqlite-'))
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'bad.ts'), 'const db = new Database("orchestra.db")\n', 'utf8')
    const result = runScript(dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('orchestra.db')
    expect(result.stdout).toMatch(/bad\.ts:1/)
  })
})
