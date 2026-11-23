// 仓库里唯一允许 import node:sqlite 的文件：对外只暴露 openDb / withTx / execSchema（总纲 4.1.1）
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
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

type Observation = {
  readConnections: number
  writeConnections: number
  activeStatements: number
  commits: { from: number; to: number; atMs: number }[] | null
}
const observations = new Map<string, Observation>()
const observedConnections = new WeakMap<DatabaseSync, Observation>()

/** Opt-in, process-local diagnostics for a single file. Enable before opening its connections. */
export function observeSqlite(file: string) {
  const path = resolve(file)
  if (observations.has(path)) throw new Error('SQLite diagnostics already active for this file')
  const observation: Observation = { readConnections: 0, writeConnections: 0, activeStatements: 0, commits: null }
  observations.set(path, observation)
  return {
    snapshot: () => ({ readConnections: observation.readConnections, writeConnections: observation.writeConnections,
      activeStatements: observation.activeStatements }),
    startCommitSampling: () => { observation.commits = [] },
    drainCommits: () => observation.commits?.splice(0) ?? [],
    stop: () => {
      if (observation.readConnections || observation.writeConnections || observation.activeStatements) {
        throw new Error('SQLite diagnostics detected unreleased resources')
      }
      if (observations.get(path) === observation) observations.delete(path)
      observation.commits = null
    },
  }
}

function instrument(raw: DatabaseSync, readonly: boolean, observation: Observation): void {
  const count = readonly ? 'readConnections' : 'writeConnections'
  const close = raw.close.bind(raw)
  const exec = raw.exec.bind(raw)
  const prepare = raw.prepare.bind(raw)
  const executing = <T>(operation: () => T): T => {
    observation.activeStatements++
    try { return operation() } finally { observation.activeStatements-- }
  }
  raw.close = () => { close(); observation[count]-- }
  raw.exec = (sql) => executing(() => exec(sql))
  raw.prepare = (sql) => executing(() => {
    const statement = prepare(sql)
    for (const method of ['all', 'get', 'run'] as const) {
      const original = statement[method]
      Object.defineProperty(statement, method, { value: (...args: unknown[]) => executing(() => Reflect.apply(original, statement, args)) })
    }
    const iterate = statement.iterate
    statement.iterate = (...args) => {
      const iterator = executing(() => Reflect.apply(iterate, statement, args) as ReturnType<typeof iterate>)
      const next = iterator.next.bind(iterator)
      iterator.next = (...params) => executing(() => next(...params))
      return iterator
    }
    return statement
  })
  observation[count]++
  observedConnections.set(raw, observation)
}

export function openDb(file: string, opts?: { readonly?: boolean; busyTimeoutMs?: number }): Db {
  const readonly = opts?.readonly === true
  if (!readonly) mkdirSync(dirname(file), { recursive: true })
  const raw = new DatabaseSync(file, { readOnly: readonly })
  try {
    const observation = observations.size && observations.get(resolve(file))
    if (observation) instrument(raw, readonly, observation)
    if (!readonly) {
      raw.exec('PRAGMA journal_mode=WAL')
      raw.exec('PRAGMA foreign_keys=ON')
      raw.exec('PRAGMA synchronous=FULL')
    }
    raw.exec('PRAGMA busy_timeout=' + String(opts?.busyTimeoutMs ?? 5000))
    return { raw, file, epoch: readEpoch(raw), readonly }
  } catch (error) {
    raw.close()
    throw error
  }
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
    const commits = observedConnections.get(db.raw)?.commits
    const before = commits && ledgerHead(db.raw)
    const result = fn(makeTx(db.raw))
    const after = commits && ledgerHead(db.raw)
    db.raw.exec('COMMIT')
    if (commits && typeof before === 'number' && typeof after === 'number' && after > before) {
      commits.push({ from: before + 1, to: after, atMs: performance.now() })
    }
    return result
  } catch (err) {
    try { db.raw.exec('ROLLBACK') } catch { /* 回滚失败时保留原异常 */ }
    throw err
  }
}

function ledgerHead(raw: DatabaseSync): number {
  return Number(raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq)
}

export type SchemaStep = { version: number; name: string; checksum: string; legacyChecksums?: string[]; statements: string[] }

// 迁移执行器：已执行版本不重跑；内容改了必须新开编号（总纲 4.1.1）
export function execSchema(db: Db, steps: SchemaStep[]): number[] {
  bootstrap(db)
  const applied: number[] = []
  for (const step of steps) {
    const row = db.raw.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(step.version) as { checksum?: string } | undefined
    if (row) {
      // 已发行版本可能按原始行尾记账，只接受同一段 SQL 的 LF/CRLF 历史摘要；
      // 文本真改了仍然拒绝。
      if (row.checksum !== step.checksum && !(row.checksum && step.legacyChecksums?.includes(row.checksum))) {
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
