import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'

export const FIXTURE_TIME = '2026-11-20T00:00:00.000Z'

export function seedScope(db: Db, runId: string, nodeId: string, nodeType: 'agent' | 'wait' = 'agent'): void {
  const taskId = runId + '-task'
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES (?, ?, 'running', 1, ?, ?)",
      [taskId, taskId, FIXTURE_TIME, FIXTURE_TIME])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES (?, ?, 'running', 1, ?, ?)",
      [runId, taskId, FIXTURE_TIME, FIXTURE_TIME])
    tx.run(`INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 1, 'started', 1, ?, ?)`, [nodeId, runId, nodeId, nodeType, FIXTURE_TIME, FIXTURE_TIME])
  })
}

export function checkpoint(source: string, directory: string, file: string): string {
  const reader = openDb(source, { readonly: true })
  try {
    // A read-only connection can copy all committed WAL pages while a different process holds the write lock.
    reader.raw.prepare('VACUUM INTO ?').run(join(directory, file))
    return file
  } finally {
    reader.raw.close()
  }
}

export function recordJson(directory: string, file: string, value: unknown): string {
  writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return file
}

export async function eventually(predicate: () => boolean, description: string, timeoutMs = 8_000): Promise<void> {
  const until = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= until) throw new Error('Timed out waiting for ' + description)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
