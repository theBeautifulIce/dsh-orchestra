// G1 用例共用的临时账本夹具
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'

export const TEST_SECRET = 'test-secret-for-g1'

export function freshLedger(dir?: string): { dir: string; file: string; db: Db } {
  const base = dir ?? mkdtempSync(join(tmpdir(), 'orchestra-g1-'))
  const file = join(base, 'orchestra.db')
  const db = openDb(file)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return { dir: base, file, db }
}

export function seed(db: Db): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '样本任务', 'running', 1, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')")
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')")
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, created_at, updated_at) VALUES ('nr1', 'r1', 'n1', 1, 'agent', 'running', 1, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')")
    appendEvent(tx, { type: 'task.created', runId: 'r1', nodeRunId: 'nr1', payload: { seed: true } })
    appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'started', { seed: true })
  })
}

export function eventSeqs(db: Db): number[] {
  return (db.raw.prepare('SELECT seq FROM events ORDER BY seq ASC').all() as { seq: number }[]).map((r) => Number(r.seq))
}

export function countOf(db: Db, table: string): number {
  return Number((db.raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n)
}
