import { join } from 'node:path'
import type { Db } from '../src/infra/sqlite/driver.ts'
import { MISSING_GLOBAL_EVENTS_SQL, sqlRows, type FaultQuery, type SqlValue } from './fault-reconcile.ts'

export function faultRows(db: Db, sql: string, ...bindings: SqlValue[]) {
  return sqlRows(db.raw.prepare(sql).all(...bindings))
}

export function checkpoint(db: Db, directory: string, name: string) {
  db.raw.prepare('VACUUM INTO ?').run(join(directory, name))
}

export function businessQuery(database: string, sql: string, expectedCount: number, ...bindings: SqlValue[]): FaultQuery {
  return { database, sql, bindings, expectedCount }
}

export const EVENT_PREFIX = 'SELECT * FROM events ORDER BY seq'

export function missingPrefix(database: string, rows: ReturnType<typeof faultRows>) {
  return businessQuery(database, MISSING_GLOBAL_EVENTS_SQL, 0, JSON.stringify(rows))
}
