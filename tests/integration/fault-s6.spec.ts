import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { sha256File } from '../../src/infra/backup.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { setTaskAutonomy } from '../../src/service/commands/start-run.ts'
import { caseG01S6 } from '../../scripts/fault-g01.ts'
import { runFaultCase } from '../../scripts/fault-inject.ts'
import { executeFaultQuery, type FaultQuery } from '../../scripts/fault-reconcile.ts'
import { writeFaultReport } from '../../scripts/fault-report.ts'

const args = ['--no-warnings', 'scripts/fault-inject.ts', '--s6']
const exec = promisify(execFile)
const output = () => mkdtempSync(join(tmpdir(), 'fault-s6-'))
const witness = (root: string) => join(root, 'G6', 'G-01')
const reportFile = (root: string) => join(witness(root), 'report.json')

describe('S6 fault evidence', () => {
  it('publishes independently replayable G-01 reports in distinct roots and refuses to overwrite them', async () => {
    const outputs = [output(), output()]
    const results = await Promise.all(outputs.map((out) =>
      exec(process.execPath, [...args, '--case', 'G-01', '--out', out], { timeout: 30_000 })))
    const reports = results.map(({ stdout }, index) => {
      const root = outputs[index]!
      const report = JSON.parse(stdout) as Awaited<ReturnType<typeof runFaultCase>>
      expect(report).toEqual(JSON.parse(readFileSync(reportFile(root), 'utf8')))
      expect(report).toMatchObject({ case: 'G-01', passed: true, failures: [], boundary: { reached: true, exit: { code: null, signal: 'SIGKILL' } } })
      expect(report.sampleIds.eventId).toEqual(expect.any(String))
      expect(report.snapshots.breakpoint).toEqual(report.snapshots.before)
      expect(report.snapshots.after).toEqual(report.snapshots.before)
      for (const query of Object.values(report.reconcile)) {
        expect(query).toMatchObject({ actualCount: 0, expectedCount: 0, rows: [], passed: true })
        expect(executeFaultQuery(witness(root), query!)).toEqual(query)
      }
      for (const [file, manifest] of Object.entries(report.artifacts)) {
        const path = join(witness(root), file)
        expect(sha256File(path)).toBe(manifest.sha256)
        expect(statSync(path).size).toBe(manifest.bytes)
      }
      return report
    })
    expect(reports[0]!.sampleIds.taskId).not.toBe(reports[1]!.sampleIds.taskId)
    const prior = sha256File(reportFile(outputs[0]!))
    const existing = spawnSync(process.execPath, [...args, '--case', 'G-01', '--out', outputs[0]!], { encoding: 'utf8' })
    expect(existing.status).toBe(1)
    expect(existing.stderr).toContain('S6 evidence already exists')
    expect(sha256File(reportFile(outputs[0]!))).toBe(prior)
  }, 35_000)

  it('fails on a real committed business change in the rollback checkpoint', async () => {
    const out = output()
    const report = await writeFaultReport('G-01', out, args, async ({ directory }) => {
      const observed = await caseG01S6({ directory })
      const db = openDb(join(directory, 'orchestra.db'))
      try {
        setTaskAutonomy(db, {
          ...(observed.params!.requested as Parameters<typeof setTaskAutonomy>[1]),
        })
        db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.raw.exec('PRAGMA journal_mode=DELETE')
      } finally {
        db.raw.close()
      }
      return observed
    })
    expect(report.reconcile.half_rows).toMatchObject({
      passed: false, actualCount: 1, rows: [{ gap: 'business_without_event', id: report.sampleIds.taskId }],
    })
    expect(report.extra.queries.rollback_event).toMatchObject({ actualCount: 1, passed: false })
    expect(report.extra.queries.rollback_task).toMatchObject({ actualCount: 0, passed: false })
    expect(report.passed).toBe(false)
    expect(JSON.parse(readFileSync(reportFile(out), 'utf8')).passed).toBe(false)
  }, 35_000)

  it('retains a failed report if the scenario or its evidence is missing', async () => {
    const out = output()
    const report = await writeFaultReport('G-01', out, args, async () => {
      throw new Error('worker exited before its boundary marker')
    })
    expect(report.passed).toBe(false)
    expect(report.reconcile).toEqual({ half_rows: null, orphan_runs: null, missing_events: null })
    expect(report.failures).toEqual(expect.arrayContaining([
      'worker exited before its boundary marker', 'Fault boundary was not reached', 'Missing breakpoint snapshot',
      'Missing required query half_rows', 'Missing retained evidence files',
    ]))
    expect(JSON.parse(readFileSync(reportFile(out), 'utf8')).failures).toEqual(report.failures)
  })

  it('fails on wrong SQL, missing/wrong bindings, absent checkpoints and reversed expectations', () => {
    const directory = output()
    const db = openDb(join(directory, 'fixture.db'))
    try {
      db.raw.exec('CREATE TABLE samples (key TEXT PRIMARY KEY); INSERT INTO samples VALUES (\'actual\');')
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.raw.exec('PRAGMA journal_mode=DELETE')
    } finally {
      db.raw.close()
    }
    const query: FaultQuery = { database: 'fixture.db', sql: 'SELECT key FROM samples WHERE key = ?', bindings: ['actual'], expectedCount: 1 }
    const hash = sha256File(join(directory, query.database))
    expect(executeFaultQuery(directory, query)).toMatchObject({ rows: [{ key: 'actual' }], passed: true })
    for (const bad of [
      { sql: 'SELECT nope FROM samples WHERE key = ?' },
      { sql: 'DELETE FROM samples WHERE key = ?' },
      { sql: 'WITH matched AS (SELECT key FROM samples WHERE key = ?) DELETE FROM samples WHERE key IN matched' },
      { bindings: [] },
      { database: 'missing.db' },
      { database: '../fixture.db' },
    ]) {
      expect(executeFaultQuery(directory, { ...query, ...bad })).toMatchObject({ actualCount: null, rows: null, passed: false })
    }
    expect(executeFaultQuery(directory, { ...query, bindings: ['different'] })).toMatchObject({ actualCount: 0, passed: false })
    expect(executeFaultQuery(directory, { ...query, expectedCount: 0 })).toMatchObject({ actualCount: 1, passed: false })
    expect(sha256File(join(directory, query.database))).toBe(hash)
  })

  it('rejects missing arguments and S6 variants before creating any evidence directory', () => {
    const root = join(output(), 'unused')
    for (const options of [
      ['--out', root],
      ['--case', 'G-01'],
      ['--case', 'G-17', '--out', root],
      ['--case', 'ev-g2-13', '--out', root],
      ['--case', 'G-01', '--out', root, '--extra'],
      ['--case', 'G-01', '--out', '--unknown'],
    ]) {
      const result = spawnSync(process.execPath, [...args, ...options], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toBe('')
      expect(existsSync(root)).toBe(false)
    }
  })

  it('rejects historical output paths and directory aliases before writing', async () => {
    const protectedPath = resolve('docs/gates')
    const alias = join(output(), 'alias')
    symlinkSync(protectedPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(runFaultCase('G-01', { out: join(protectedPath, 'evidence') })).rejects.toThrow('overlaps historical')
    await expect(runFaultCase('G-01', { out: join(alias, 'separate-output') })).rejects.toThrow('real directories')
    expect(existsSync(join(protectedPath, 'separate-output'))).toBe(false)
    await expect(runFaultCase('G-01', { out: join(output(), 'G6', 'G-02', 'nested') })).rejects.toThrow('overlaps another fault case')
  })
})
