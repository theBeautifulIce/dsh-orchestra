// G1 用例共用的临时账本夹具
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import type { PassCondition } from '../../src/core/policy.ts'

export const TEST_SECRET = 'test-secret-for-g1'

// M5 之后判定条件只从 run 绑定的工作流版本取，测试也得建真实目录，不能再手传 policy
export const DEFAULT_PASS: PassCondition[] = [{ path: 'evidence.exitCode', op: 'eq', value: 0 }]

export function catalogFor(
  nodeIds: string[],
  opts: { version?: string; passConditions?: PassCondition[]; requiredHashes?: string[] } = {},
): WorkflowCatalog {
  const catalog = new WorkflowCatalog('S2')
  catalog.load({
    workflow_version: opts.version ?? '1',
    pass_conditions: opts.passConditions ?? DEFAULT_PASS,
    required_hashes: opts.requiredHashes,
    nodes: nodeIds.map((node_id) => ({ node_id, type: 'agent' as const })),
  })
  return catalog
}

// 让 run 绑上工作流版本：没有版本就没有判定条件，done 报告会被 VERDICT_UNSUPPORTED 拒
export function bindRunVersion(db: Db, version: number | string = 1, runId = 'r1'): void {
  withTx(db, (tx) => tx.run('UPDATE runs SET workflow_version = ? WHERE run_id = ?', [version, runId]))
}

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
