// 仓库里唯一允许 import node:sqlite 的文件：对外只暴露 openDb / withTx / execSchema（总纲 4.1.1）
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OrchError } from '../../core/errors.ts'

export type Db = {
  raw: DatabaseSync
  file: string
  epoch: number
  readonly: boolean
}

export type Tx = {
  raw: DatabaseSync
  exec(sql: string): void
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number }
}

const BOOTSTRAP = [
  "CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
]

export function openDb(file: string, opts?: { readonly?: boolean; busyTimeoutMs?: number }): Db {
  const readonly = opts?.readonly === true
  if (!readonly) mkdirSync(dirname(file), { recursive: true })
  const raw = new DatabaseSync(file, { readOnly: readonly })
  if (!readonly) {
    raw.exec('PRAGMA journal_mode=WAL')
    raw.exec('PRAGMA foreign_keys=ON')
    raw.exec('PRAGMA synchronous=FULL')
  }
  raw.exec('PRAGMA busy_timeout=' + String(opts?.busyTimeoutMs ?? 5000))
  return { raw, file, epoch: readEpoch(raw), readonly }
}

export function hasServiceMeta(raw: DatabaseSync): boolean {
  const hit = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_meta'").get()
  return hit !== undefined
}

function readEpoch(raw: DatabaseSync): number {
  if (!hasServiceMeta(raw)) return 0
  const row = raw.prepare("SELECT value FROM service_meta WHERE key = 'instance_epoch'").get() as { value?: string } | undefined
  return row?.value ? Number(row.value) : 0
}

function bootstrap(db: Db): void {
  if (db.readonly) return
  for (const sql of BOOTSTRAP) db.raw.exec(sql)
}

export function makeTx(raw: DatabaseSync): Tx {
  return {
    raw,
    exec(sql: string) {
      raw.exec(sql)
    },
    all<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[]
    },
    get<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).get(...(params as never[])) as T | undefined
    },
    run(sql: string, params: unknown[] = []) {
      const res = raw.prepare(sql).run(...(params as never[]))
      return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) }
    },
  }
}

export function withTx<T>(db: Db, fn: (tx: Tx) => T): T {
  if (db.readonly) throw new OrchError('FORBIDDEN', '只读连接不许写')
  bootstrap(db)
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    // epoch 栅栏：事务一开始就校验，旧进程复活也写不进来（规格 2.2 行 105）
    const current = readEpoch(db.raw)
    if (current !== db.epoch) {
      throw new OrchError('STALE_GENERATION', 'epoch 不匹配，这个进程已经不是账本写者', { expected: db.epoch, actual: current })
    }
    const result = fn(makeTx(db.raw))
    db.raw.exec('COMMIT')
    return result
  } catch (err) {
    try { db.raw.exec('ROLLBACK') } catch { /* 回滚失败时保留原异常 */ }
    throw err
  }
}

export type SchemaStep = { version: number; name: string; checksum: string; statements: string[] }

// 迁移执行器：已执行版本不重跑；内容改了必须新开编号（总纲 4.1.1）
export function execSchema(db: Db, steps: SchemaStep[]): number[] {
  bootstrap(db)
  const applied: number[] = []
  for (const step of steps) {
    const row = db.raw.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(step.version) as { checksum?: string } | undefined
    if (row) {
      if (row.checksum !== step.checksum) {
        throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '已执行的迁移被改了，要新开编号', { version: step.version })
      }
      continue
    }
    // 每步一个事务：中途被杀时这步整体没提交，重跑可重入（规格 12.3 G-14）
    withTx(db, (tx) => {
      for (const sql of step.statements) tx.exec(sql)
      tx.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [step.version, step.name, step.checksum, new Date().toISOString()])
    })
    applied.push(step.version)
  }
  return applied
}
