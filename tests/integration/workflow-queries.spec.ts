import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { listWorkflowSummaries } from '../../src/service/queries/workflows.ts'

const dirs: string[] = []
const closers: { close: () => void }[] = []
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-workflow-q-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    const now = '2026-11-17T10:00:00.000Z'
    for (const [id, name] of [['wf-root', '根流程'], ['wf-child', '子流程']]) {
      tx.run('INSERT INTO workflows (workflow_id, name, status, scope, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, 'active', 'reusable', 'test', 'test', now, now])
    }
    tx.run("INSERT INTO tasks (task_id, title, status, current_run_id, revision, created_at, updated_at) VALUES ('task-1', '任务', 'running', 'root-run', 1, ?, ?)", [now, now])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, status, revision, created_at, updated_at) VALUES ('root-run', 'task-1', 'wf-root', 'running', 1, ?, ?)", [now, now])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, parent_run_id, status, revision, created_at, updated_at) VALUES ('child-run', 'task-1', 'wf-child', 'root-run', 'running', 1, ?, ?)", [now, now])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('node-1', 'root-run', 'node-1', 1, 'agent', 1, 'started', 1, ?, ?)", [now, now])
    tx.run("INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at) VALUES ('decision-1', 'root-run', 'node-1', 'verify_human', 'pending', 1, '{}', ?)", [now])
  })
  return db
}
afterEach(() => {
  for (const db of closers.splice(0)) { try { db.close() } catch { /* 忽略已关闭句柄 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略延迟释放 */ } }
})

describe('workflow active task summary', () => {
  it('根流程与 task_local 子流程的活动 Run 都计入去重任务数', () => {
    const db = seeded()
    const rows = listWorkflowSummaries(db).items
    expect(rows.find((row) => row.workflow_id === 'wf-root')?.active_task_count).toBe(1)
    expect(rows.find((row) => row.workflow_id === 'wf-child')?.active_task_count).toBe(1)
  })

  it('结算来源必须引用同节点同运行的已完成系统证据或已收口决定', () => {
    const db = seeded()
    const insert = db.raw.prepare('INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, evidence_id, decision_id, stop_evidence, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    expect(() => insert.run('node-1', 'root-run', 'evidence', 'missing-execution', null, null, 'now')).toThrow('UNVERIFIED_RESOLUTION_BASIS_INVALID')
    expect(() => insert.run('node-1', 'root-run', 'decision', null, 'decision-1', null, 'now')).toThrow('UNVERIFIED_RESOLUTION_BASIS_INVALID')
  })
})
