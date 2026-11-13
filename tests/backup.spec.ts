import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../src/core/errors.ts'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { appendNodeRunEvent, appendEvent } from '../src/infra/db/ledger.ts'
import { backup, restore, sha256File, verifyBackup, type BackupManifest } from '../src/infra/backup.ts'

const dirs: string[] = []
const closers: { close: () => void }[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-bak-'))
  dirs.push(dir)
  return dir
}
function seededDb() {
  const file = join(tmp(), 'orchestra.db')
  const db = openDb(file)
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '任务一', 'running', 1, 'now', 'now')")
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, 'now', 'now')")
    appendNodeRunEvent(tx, 'secret', 'n1', 'started', { a: 1 })
    appendEvent(tx, { type: 'run.started', runId: 'r1', payload: { k: 1 } })
  })
  return { file, db }
}
afterEach(() => {
  for (const db of closers.splice(0)) { try { db.close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

const codeOf = (fn: () => unknown): { code: string; table?: unknown } => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return { code: err.code, table: err.details.table }
    throw err
  }
  throw new Error('本应抛错却通过了')
}

describe('备份与恢复', () => {
  it('备份目录里有库与清单，每张表行数哈希与线上一致', () => {
    const { file, db } = seededDb()
    const dest = join(tmp(), 'backup-1')
    const manifest = backup(file, dest)
    expect(existsSync(join(dest, 'orchestra.db'))).toBe(true)
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
    expect(manifest.tables.map((t) => t.name)).toEqual(['service_meta', 'tasks', 'runs', 'node_runs', 'events', 'node_run_events', 'inbox', 'leases', 'artifacts', 'report_registry'])
    const tasks = manifest.tables.find((t) => t.name === 'tasks')!
    expect(tasks.rows).toBe(1)
    const liveCount = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n)
    expect(tasks.rows).toBe(liveCount)
    expect(manifest.db_sha256).toBe(sha256File(join(dest, 'orchestra.db')))
  })

  it('刚做的备份 verifyBackup 通过', () => {
    const { file } = seededDb()
    const dest = join(tmp(), 'backup-2')
    const made = backup(file, dest)
    const got = verifyBackup(dest)
    expect(got.db_sha256).toBe(made.db_sha256)
  })

  it('截断备份库 → 报 db_file 损坏', () => {
    const { file } = seededDb()
    const dest = join(tmp(), 'backup-3')
    backup(file, dest)
    const copy = join(dest, 'orchestra.db')
    truncateSync(copy, Math.floor(statSync(copy).size / 2))
    expect(codeOf(() => verifyBackup(dest))).toEqual({ code: 'SERVICE_UNAVAILABLE', table: '(db_file)' })
  })

  it('改清单里某张表的 rows → 报那张表', () => {
    const { file } = seededDb()
    const dest = join(tmp(), 'backup-4')
    backup(file, dest)
    const mpath = join(dest, 'manifest.json')
    const manifest = JSON.parse(readFileSync(mpath, 'utf8')) as BackupManifest
    const target = manifest.tables.find((t) => t.name === 'tasks')!
    target.rows = 99
    writeFileSync(mpath, JSON.stringify(manifest, null, 2), 'utf8')
    expect(codeOf(() => verifyBackup(dest))).toEqual({ code: 'SERVICE_UNAVAILABLE', table: 'tasks' })
  })

  it('恢复到新文件：内容一致，线上库字节与哈希不变', () => {
    const { file, db } = seededDb()
    const dest = join(tmp(), 'backup-5')
    backup(file, dest)
    const before = { size: statSync(file).size, sha: sha256File(file) }
    const target = join(tmp(), 'restored', 'orchestra.db')
    restore(dest, target)
    expect(sha256File(target)).toBe(sha256File(join(dest, 'orchestra.db')))
    expect({ size: statSync(file).size, sha: sha256File(file) }).toEqual(before)
    const restored = openDb(target, { readonly: true })
    try {
      expect(Number((restored.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n)).toBe(1)
      expect(Number((restored.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)).toBe(1)
    } finally {
      restored.raw.close()
    }
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n)).toBe(1)
  })

  it('缺清单 → SERVICE_UNAVAILABLE 并指出 manifest', () => {
    const { file } = seededDb()
    const dest = join(tmp(), 'backup-6')
    backup(file, dest)
    rmSync(join(dest, 'manifest.json'))
    expect(codeOf(() => verifyBackup(dest))).toEqual({ code: 'SERVICE_UNAVAILABLE', table: '(manifest)' })
  })
})
