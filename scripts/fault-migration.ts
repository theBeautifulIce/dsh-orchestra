import { spawn } from 'node:child_process'
import { constants, copyFileSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OrchError } from '../src/core/errors.ts'
import { sha256Hex } from '../src/core/canonical.ts'
import { applySteps, type SchemaStep } from '../src/infra/db/migrate.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { freshLedger, seed } from '../tests/fixtures/ledger.ts'
import { ORPHAN_REFERENCES_SQL, MISSING_GLOBAL_EVENTS_SQL, sealCheckpoint, sqlRows } from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'

type Cut = 'between' | 'inside'
const steps: SchemaStep[] = [901, 902].map((version) => {
  const name = 's6_sample_' + version
  const statements = ['CREATE TABLE ' + name + ' (id INTEGER PRIMARY KEY)', 'INSERT INTO ' + name + ' VALUES (1)']
  return { version, name, statements, checksum: sha256Hex(statements.join('\n')) }
})
const recorded = 'SELECT version,name,checksum FROM schema_migrations ORDER BY version'
function childWork(file: string, cut: Cut) {
  const db = openDb(file)
  const signal = () => {
    const exists = db.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 's6_sample_%' ORDER BY name").all()
    const visible = exists.map((row) => String(row.name))
    const rows902 = visible.includes('s6_sample_902') ? db.raw.prepare('SELECT id FROM s6_sample_902').all() : []
    writeSync(1, JSON.stringify({ cut, visible, rows902, versions: db.raw.prepare(recorded).all().slice(-2) }) + '\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
    throw new Error('Parent failed to stop the migration worker')
  }
  try {
    applySteps(db, [steps[0]!])
    if (cut === 'between') signal()
    const exec = db.raw.exec.bind(db.raw)
    db.raw.exec = (sql) => {
      exec(sql)
      if (sql === steps[1]!.statements[1]) signal()
    }
    applySteps(db, steps)
  } finally { db.raw.close() }
}

function stopAt(file: string, cut: Cut): Promise<{ marker: { cut: Cut; rows902: unknown[] }; signal: string | null }> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', import.meta.filename, 'worker', file, cut],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    let diagnostic = ''
    let stopped = false
    const timeout = setTimeout(() => { child.kill('SIGKILL') }, 18_000)
    child.stderr.setEncoding('utf8').on('data', (text: string) => { diagnostic += text })
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      buffer += text
      if (!stopped && buffer.includes('\n')) stopped = child.kill('SIGKILL')
    })
    child.on('error', (error) => { clearTimeout(timeout); reject(error) })
    child.on('close', (_code, signal) => {
      clearTimeout(timeout)
      if (!stopped || signal !== 'SIGKILL') { reject(new Error('Migration worker missed boundary ' + cut + ': ' + diagnostic)); return }
      try { accept({ marker: JSON.parse(buffer.trim()), signal }) } catch (error) { reject(error) }
    })
  })
}

export const caseG14S6: FaultCase = async ({ directory }) => {
  const { db, file } = freshLedger(directory)
  let baseline, events
  try {
    seed(db)
    baseline = sqlRows(db.raw.prepare(recorded).all())
    events = sqlRows(db.raw.prepare('SELECT seq,event_id FROM events ORDER BY seq').all())
  } finally { db.raw.close() }
  sealCheckpoint(file)
  const artifacts = ['orchestra.db']
  const cuts: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const checks: Record<string, { actual: unknown; expected: unknown }> = {}
  for (const cut of ['between','inside'] as const) {
    const name = cut + '.db'
    const copy = join(directory, name)
    copyFileSync(file, copy, constants.COPYFILE_EXCL)
    const result = await stopAt(copy, cut)
    cuts[cut] = result
    sealCheckpoint(copy)
    const saved = cut + '-checkpoint.db'
    copyFileSync(copy, join(directory, saved), constants.COPYFILE_EXCL)
    const recovery = openDb(copy)
    try {
      const before = sqlRows(recovery.raw.prepare(recorded).all())
      checks[cut + '_committed_901'] = { actual: before, expected: [...baseline, { version: 901, name: steps[0]!.name, checksum: steps[0]!.checksum }] }
      checks[cut + '_rollback_902'] = { actual: recovery.raw.prepare("SELECT name FROM sqlite_master WHERE name='s6_sample_902'").all(), expected: [] }
      const first = applySteps(recovery, steps)
      const second = applySteps(recovery, steps)
      let refusal = 'accepted'
      try { applySteps(recovery, [{ ...steps[0]!, checksum: 'changed' }]) } catch (error) {
        if (!(error instanceof OrchError)) throw error
        refusal = error.code
      }
      checks[cut + '_idempotent'] = { actual: [first, second, refusal], expected: [[902], [], 'SCHEMA_VERSION_UNSUPPORTED'] }
      checks[cut + '_observed'] = { actual: [result.marker.cut, result.marker.rows902], expected: [cut,cut === 'inside' ? [{ id: 1 }] : []] }
      const versions = sqlRows(recovery.raw.prepare(recorded).all())
      checks[cut + '_versions'] = { actual: versions, expected: [...baseline,...steps.map(({ version, checksum, name }) => ({version, checksum, name}))] }
      after[cut] = { versions, first, second, refusal }
    } finally { recovery.raw.close() }
    sealCheckpoint(copy)
    artifacts.push(name, saved)
  }
  writeFileSync(join(directory, 'boundaries.json'), JSON.stringify(cuts, null, 2))
  artifacts.push('boundaries.json')
  return { sampleIds: { version: 902, eventId: String(events[0]?.event_id) }, boundary: { reached: true, cuts },
    snapshots: { before: { baseline, events }, breakpoint: cuts, after }, checks, artifacts, queries: {
      half_rows: { database: 'inside.db', sql: 'SELECT 1 AS missing WHERE (SELECT count(*) FROM s6_sample_901)<>1 OR (SELECT count(*) FROM s6_sample_902)<>1', bindings: [], expectedCount: 0 },
      orphan_runs: { database: 'inside.db', sql: ORPHAN_REFERENCES_SQL, bindings: [], expectedCount: 0 },
      missing_events: { database: 'inside.db', sql: MISSING_GLOBAL_EVENTS_SQL, bindings: [JSON.stringify(events)], expectedCount: 0 },
    }, extraQueries: {
      before_902: { database: 'inside-checkpoint.db', sql: "SELECT name FROM sqlite_master WHERE name='s6_sample_902'", bindings: [], expectedCount: 0 },
      between_has_both_rows: { database: 'between.db', sql: 'SELECT id FROM s6_sample_901 UNION ALL SELECT id FROM s6_sample_902', bindings: [], expectedCount: 2 },
    } }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename && process.argv[2] === 'worker') {
  const [file, cut] = process.argv.slice(3)
  if (!file || !['inside','between'].includes(cut ?? '')) throw new Error('Invalid migration worker')
  childWork(file, cut as Cut)
}
