import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { openDb } from '../src/infra/sqlite/driver.ts'

export const REQUIRED_FAULT_QUERIES = ['half_rows', 'orphan_runs', 'missing_events'] as const
export type FaultMetric = typeof REQUIRED_FAULT_QUERIES[number]
export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

export type FaultQuery = {
  /** Relative path to a standalone SQLite checkpoint in this case's evidence. */
  database: string
  /** Single read statement with plain positional ? parameters. */
  sql: string
  bindings: readonly SqlValue[]
  /** SQL returns the individual matching rows so the count can be recomputed. */
  expectedCount: number
}

export type FaultQueryResult = FaultQuery & {
  rows: SqlRow[] | null
  actualCount: number | null
  passed: boolean
  error?: string
}

export const ORPHAN_REFERENCES_SQL = `
  SELECT "table" AS owner, rowid AS id, parent FROM pragma_foreign_key_check
  UNION ALL
  SELECT 'tasks', t.task_id, 'runs' FROM tasks t LEFT JOIN runs r ON r.run_id = t.current_run_id
    WHERE t.current_run_id IS NOT NULL AND (r.run_id IS NULL OR r.task_id <> t.task_id)
  UNION ALL
  SELECT 'events', e.event_id, 'runs' FROM events e LEFT JOIN runs r ON r.run_id = e.run_id
    WHERE e.run_id IS NOT NULL AND r.run_id IS NULL
  UNION ALL
  SELECT 'events', e.event_id, 'node_runs' FROM events e LEFT JOIN node_runs n ON n.node_run_id = e.node_run_id
    WHERE e.node_run_id IS NOT NULL AND (n.node_run_id IS NULL OR (e.run_id IS NOT NULL AND n.run_id <> e.run_id))
  UNION ALL
  SELECT 'node_run_events', e.id, 'node_runs' FROM node_run_events e LEFT JOIN node_runs n ON n.node_run_id = e.node_run_id
    WHERE n.node_run_id IS NULL
  ORDER BY owner, id, parent
`

export const MISSING_GLOBAL_EVENTS_SQL = `
  SELECT json_extract(p.value, '$.seq') AS seq, json_extract(p.value, '$.event_id') AS event_id
  FROM json_each(?) p LEFT JOIN events e
    ON e.seq = json_extract(p.value, '$.seq') AND e.event_id = json_extract(p.value, '$.event_id')
  WHERE e.seq IS NULL ORDER BY seq
`

export function sealCheckpoint(file: string): void {
  const db = openDb(file)
  try {
    const checkpoint = db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint?.busy !== 0) throw new Error('SQLite checkpoint failed')
    if (db.raw.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') {
      throw new Error('Could not seal SQLite checkpoint')
    }
  } finally {
    db.raw.close()
  }
}

export function insideDirectory(directory: string, target: string): boolean {
  const difference = relative(directory, target)
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep)
}

export function evidenceFile(directory: string, name: string): string {
  const root = realpathSync(directory)
  const file = resolve(root, name)
  if (isAbsolute(name) || file === root || !insideDirectory(root, file)) {
    throw new Error('Evidence file must be relative to the case directory: ' + name)
  }
  const metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.nlink !== 1 || realpathSync(file) !== file) {
    throw new Error('Evidence file must be an independent local file: ' + name)
  }
  return file
}

export function sqlRows(rows: Record<string, unknown>[]): SqlRow[] {
  for (const row of rows) {
    if (Object.values(row).some((value) => value !== null && typeof value !== 'string'
        && (typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new Error('SQL result contains an unsupported value; cast or encode it in the query')
    }
  }
  return rows as SqlRow[]
}

export function executeFaultQuery(directory: string, query: FaultQuery): FaultQueryResult {
  try {
    if (!Number.isSafeInteger(query.expectedCount) || query.expectedCount < 0) {
      throw new Error('Invalid expected row count')
    }
    // Strip quoted strings, quoted identifiers and comments before counting
    // anonymous parameters. SQLite silently binds omitted positional values to NULL.
    const tokens = query.sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g, ' ').trim()
    if (!/^(?:SELECT|WITH)\b/i.test(tokens) || tokens.replace(/;$/, '').includes(';')
        || /\?\d|[:@$][\w]/.test(tokens)) {
      throw new Error('Expected a single SELECT or WITH statement with plain positional bindings')
    }
    if ((tokens.match(/\?/g)?.length ?? 0) !== query.bindings.length) {
      throw new Error('SQL positional parameter count does not match bindings')
    }
    const file = evidenceFile(directory, query.database)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (lstatSync(file + suffix, { throwIfNoEntry: false })) {
        throw new Error('Checkpoint still has a SQLite sidecar: ' + query.database + suffix)
      }
    }
    const db = openDb(file, { readonly: true })
    try {
      db.raw.exec('PRAGMA query_only=ON')
      const rows = sqlRows(db.raw.prepare(query.sql).all(...query.bindings))
      const actualCount = rows.length
      return { ...query, rows, actualCount, passed: actualCount === query.expectedCount }
    } finally {
      db.raw.close()
    }
  } catch (error) {
    return {
      ...query,
      rows: null,
      actualCount: null,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
