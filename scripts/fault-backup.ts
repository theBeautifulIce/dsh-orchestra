import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { restore, sha256File, verifyBackup, type BackupManifest } from '../src/infra/backup.ts'
import { OrchError } from '../src/core/errors.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { createRun } from '../src/service/runs.ts'
import { catalogFor, freshLedger } from '../tests/fixtures/ledger.ts'
import { ORPHAN_REFERENCES_SQL, MISSING_GLOBAL_EVENTS_SQL, sealCheckpoint, sqlRows } from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'

const execute = promisify(execFile)
const fingerprint = (file: string) => ({ bytes: statSync(file).size, sha256: sha256File(file) })
function rejection(action: () => unknown) {
  try { action(); return 'accepted' } catch (error) {
    if (!(error instanceof OrchError)) throw error
    return error.code + (error.details?.table ? '/' + String(error.details.table) : '')
  }
}
export const caseG15S6: FaultCase = async ({ directory }) => {
  const { db, file } = freshLedger(directory)
  const run = (() => {
    try { return createRun(db, catalogFor(['read']), { taskTitle: '备份校验', workflowVersion: '1', now: new Date().toISOString() }) }
    finally { db.raw.close() }
  })()
  sealCheckpoint(file)
  const before = fingerprint(file)
  const source = openDb(file, { readonly: true })
  let events
  try { events = sqlRows(source.raw.prepare('SELECT seq,event_id FROM events WHERE run_id=? ORDER BY seq').all(run.run_id)) }
  finally { source.raw.close() }

  // Simultaneous readers use independent backup destinations against this sealed source.
  const dirs = ['backup-a','backup-b']
  const backupModule = new URL('../src/infra/backup.ts', import.meta.url).href
  const worker = 'const {backup}=await import(process.argv[1]); backup(process.argv[2],process.argv[3])'
  await Promise.all(dirs.map((name) => execute(process.execPath, ['--input-type=module','-e',worker,backupModule,file,join(directory, name)])))
  const healthy = join(directory, dirs[0]!)
  const manifest = verifyBackup(healthy)
  const second = verifyBackup(join(directory, dirs[1]!))
  const restoredFile = 'restored/orchestra.db'
  restore(healthy, join(directory, restoredFile))
  const artifacts = ['orchestra.db', restoredFile, ...dirs.flatMap((dir) => [dir + '/orchestra.db', dir + '/manifest.json'])]
  const damage: Record<string, unknown> = {}
  const checks: Record<string, { actual: unknown; expected: unknown }> = {
    source_was_populated: { actual: events.length > 0, expected: true },
    good_restore: { actual: sha256File(join(directory, restoredFile)), expected: manifest.db_sha256 },
    parallel_copies: { actual: second.tables, expected: manifest.tables },
    live_target_protected: { actual: rejection(() => restore(healthy, file)), expected: 'FORBIDDEN' },
  }
  for (const mode of ['truncated', 'changed-byte', 'count']) {
    const dir = join(directory, mode)
    cpSync(healthy, dir, { recursive: true, errorOnExist: true, force: false })
    const copy = join(dir, 'orchestra.db')
    const manifestPath = join(dir, 'manifest.json')
    const intact = fingerprint(copy)
    if (mode === 'truncated') truncateSync(copy, Math.floor(intact.bytes / 2))
    else if (mode === 'changed-byte') {
      const bytes = readFileSync(copy)
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
      writeFileSync(copy, bytes)
    } else {
      const altered = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
      altered.tables.find((table) => table.name === 'tasks')!.rows++
      writeFileSync(manifestPath, JSON.stringify(altered))
    }
    const target = join(directory, 'rejected', mode + '.db')
    mkdirSync(join(directory, 'rejected'), { recursive: true })
    const expected = 'SERVICE_UNAVAILABLE/' + (mode === 'count' ? 'tasks' : '(db_file)')
    const outcomes = [rejection(() => verifyBackup(dir)), rejection(() => restore(dir, target)), rejection(() => restore(dir, target))]
    checks[mode] = { actual: [outcomes, existsSync(target)], expected: [[expected, expected, expected], false] }
    damage[mode] = { intact, result: fingerprint(copy), manifest: fingerprint(manifestPath), outcomes }
    artifacts.push(mode + '/orchestra.db', mode + '/manifest.json')
  }
  const after = fingerprint(file)
  checks.unchanged_source = { actual: after, expected: before }
  return { sampleIds: { taskId: run.task_id, runId: run.run_id, eventId: String(events[0]?.event_id) },
    boundary: { reached: true, cases: Object.keys(damage) }, snapshots: { before, breakpoint: damage, after },
    queries: {
      half_rows: { database: restoredFile, sql: 'SELECT ? AS missing WHERE NOT EXISTS (SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id JOIN node_runs n ON n.run_id=r.run_id WHERE t.task_id=? AND r.run_id=?)',
        bindings: [run.task_id, run.task_id, run.run_id], expectedCount: 0 },
      orphan_runs: { database: restoredFile, sql: ORPHAN_REFERENCES_SQL, bindings: [], expectedCount: 0 },
      missing_events: { database: restoredFile, sql: MISSING_GLOBAL_EVENTS_SQL, bindings: [JSON.stringify(events)], expectedCount: 0 },
    }, checks, artifacts }
}
