import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../src/core/errors.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'

const dirs: string[] = []
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-mig-'))
  dirs.push(dir)
  return join(dir, 'orchestra.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ELEVEN_TABLES = ['tasks', 'runs', 'node_runs', 'events', 'node_run_events', 'inbox', 'leases', 'artifacts', 'report_registry', 'service_meta', 'workflow_versions']

const tables = (raw: { prepare: (sql: string) => { all: () => unknown[] } }): string[] =>
  (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)

const appliedRows = (raw: { prepare: (sql: string) => { all: () => unknown[] } }): unknown[] =>
  raw.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

describe('迁移框架', () => {
  it('空库跑一次：十一张表齐、迁移记四行', () => {
    const db = openDb(dbFile())
    expect(applySteps(db, loadSteps(defaultMigrationsDir()))).toEqual([1, 2, 3, 4])
    const names = tables(db.raw)
    for (const name of ELEVEN_TABLES) expect(names).toContain(name)
    const rows = appliedRows(db.raw) as { version: number }[]
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4])
    db.raw.close()
  })

  it('再跑一次返回空数组，记账不重复', () => {
    const db = openDb(dbFile())
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps)
    expect(applySteps(db, loadSteps(defaultMigrationsDir()))).toEqual([])
    expect(appliedRows(db.raw).length).toBe(4)
    db.raw.close()
  })

  it('已执行迁移被改内容 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const db = openDb(dbFile())
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps)
    const tampered = steps.map((s) => ({ ...s, checksum: 'deadbeef' }))
    expect(codeOf(() => applySteps(db, tampered))).toBe('SCHEMA_VERSION_UNSUPPORTED')
    db.raw.close()
  })

  it('中途失败可重入：已提交步骤不重跑、不重复增长', () => {
    const db = openDb(dbFile())
    const stepA = { version: 1, name: 'a', checksum: 'sum-a', statements: ['CREATE TABLE a (id INTEGER PRIMARY KEY)'] }
    const stepBad = { version: 2, name: 'b_bad', checksum: 'sum-b1', statements: ['CREATE TABLE b (id INTEGER PRIMARY KEY, ???)'] }
    expect(() => applySteps(db, [stepA, stepBad])).toThrow()
    expect((appliedRows(db.raw) as { version: number }[]).map((r) => r.version)).toEqual([1])
    expect(tables(db.raw)).not.toContain('b')
    const stepFixed = { version: 2, name: 'b', checksum: 'sum-b2', statements: ['CREATE TABLE b (id INTEGER PRIMARY KEY)'] }
    expect(applySteps(db, [stepA, stepFixed])).toEqual([2])
    expect((appliedRows(db.raw) as { version: number }[]).map((r) => r.version)).toEqual([1, 2])
    expect(tables(db.raw)).toContain('b')
    db.raw.close()
  })

  it('文件名不合规 → 抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-migfiles-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'init.sql'), 'CREATE TABLE x (id INTEGER PRIMARY KEY);')
    expect(codeOf(() => loadSteps(dir))).toBe('SCHEMA_VERSION_UNSUPPORTED')
  })

  it('编号重复 → 抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-migfiles-'))
    dirs.push(dir)
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE x (id INTEGER PRIMARY KEY);')
    writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE y (id INTEGER PRIMARY KEY);')
    expect(codeOf(() => loadSteps(dir))).toBe('SCHEMA_VERSION_UNSUPPORTED')
  })
})
