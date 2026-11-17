import { performance } from 'node:perf_hooks'
import { OrchError } from '../../core/errors.ts'
import { openDb, type Db } from '../../infra/sqlite/driver.ts'

/** 查询事务仅暴露读方法，避免读模型通过类型化接口发出写语句。 */
export type ReadTx = {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
}

export type ReadCtx = { tx: ReadTx; as_of_seq: number }

const DEFAULT_QUERY_TIMEOUT_MS = 5000

/**
 * 使用独立只读连接，在单个 SQLite 快照内读取 as_of_seq 与查询结果。
 * DatabaseSync 查询是同步的，故超时只能在回调返回后判定并丢弃整页，不能抢占正在执行的 SQLite 指令。
 */
export function withReadTx<T>(db: Db, fn: (ctx: ReadCtx) => T, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): T {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '查询时限必须是正数', { timeout_ms: timeoutMs })
  }

  const startedAt = performance.now()
  // SQLite's :memory: databases are connection-local, so a second connection would read an empty database.
  // Keep the shared connection for this synchronous callback and restore its query_only setting afterward.
  const ownsReader = db.file !== ':memory:'
  const reader = ownsReader ? openDb(db.file, { readonly: true }) : db
  const previousQueryOnly = Number((reader.raw.prepare('PRAGMA query_only').get() as { query_only: number }).query_only)
  let inTransaction = false
  try {
    reader.raw.exec('PRAGMA query_only=ON')
    reader.raw.exec('BEGIN DEFERRED')
    inTransaction = true
    try {
      const head = reader.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }
      const ctx: ReadCtx = {
        as_of_seq: Number(head.seq),
        tx: {
          all<T>(sql: string, params: unknown[] = []) {
            return reader.raw.prepare(sql).all(...(params as never[])) as T[]
          },
          get<T>(sql: string, params: unknown[] = []) {
            return reader.raw.prepare(sql).get(...(params as never[])) as T | undefined
          },
        },
      }
      const result = fn(ctx)
      const elapsedMs = performance.now() - startedAt
      if (elapsedMs > timeoutMs) {
        throw new OrchError('QUERY_TIMEOUT', '查询超过时限，结果未返回', { timeout_ms: timeoutMs, elapsed_ms: Math.round(elapsedMs) })
      }
      reader.raw.exec('COMMIT')
      inTransaction = false
      return result
    } catch (err) {
      if (inTransaction) {
        try { reader.raw.exec('ROLLBACK') } catch { /* 保留查询本身的异常 */ }
        inTransaction = false
      }
      throw err
    }
  } finally {
    if (ownsReader) reader.raw.close()
    else reader.raw.exec('PRAGMA query_only=' + String(previousQueryOnly))
  }
}
