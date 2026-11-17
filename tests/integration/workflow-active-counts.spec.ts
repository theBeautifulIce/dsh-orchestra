import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent } from '../../src/infra/db/ledger.ts'
import { listWorkflowSummaries } from '../../src/service/queries/workflows.ts'

const NOW = '2026-11-17T10:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const dirs: string[] = []
const closers: { close: () => void }[] = []

afterEach(() => {
  for (const db of closers.splice(0)) {
    try { db.close() } catch { /* 已经关过 */ }
  }
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ }
  }
})

function ledger(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'orch-workflow-counts-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}

function seedWorkflow(db: Db, workflowId: string, name: string): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO workflows (workflow_id, name, status, scope, created_by, updated_by, created_at, updated_at)"
      + " VALUES (?, ?, 'active', 'reusable', 'tester', 'tester', ?, ?)", [workflowId, name, NOW, NOW])
  })
}

function seedTask(db: Db, taskId: string, title: string, workflowId: string): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, workflow_id, workflow_version, status, display_status, revision, created_at, updated_at)"
      + " VALUES (?, ?, ?, 1, 'running', 'running', 1, ?, ?)", [taskId, title, workflowId, NOW, NOW])
  })
}

type RunSeed = { runId: string; taskId: string; workflowId: string; parentRunId?: string | null }

function seedRun(db: Db, seed: RunSeed): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at, parent_run_id, root_run_id, subworkflow_depth)"
      + " VALUES (?, ?, ?, 1, 'running', 1, ?, ?, ?, ?, ?)",
      [seed.runId, seed.taskId, seed.workflowId, NOW, NOW,
        seed.parentRunId ?? null, seed.parentRunId ?? seed.runId, seed.parentRunId ? 1 : 0])
    appendEvent(tx, { type: 'run.started', runId: seed.runId, payload: { run_id: seed.runId } })
  })
}

function settleRun(db: Db, runId: string): void {
  withTx(db, (tx) => {
    tx.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE run_id = ?", [NOW, runId])
    appendEvent(tx, { type: 'run.finished', runId, payload: { run_id: runId } })
  })
}

function activeCount(db: Db, workflowId: string): number {
  const listed = listWorkflowSummaries(db, { now: NOW_MS })
  const item = listed.items.find((entry) => entry.workflow_id === workflowId)
  if (!item) throw new Error('流程列表里没有这个流程：' + workflowId)
  return item.active_task_count
}

describe('流程的活跃任务计数', () => {
  it('根 Run 与子 Run 都活跃时，按 task 去重后各算一次', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedTask(db, 't1', '任务一', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })

    expect(activeCount(db, 'wf1')).toBe(1)
  })

  it('一个流程下两个任务各有一个活跃 Run：活跃任务数是 2', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedTask(db, 't1', '任务一', 'wf1')
    seedTask(db, 't2', '任务二', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })
    seedRun(db, { runId: 'r2', taskId: 't2', workflowId: 'wf1' })

    expect(activeCount(db, 'wf1')).toBe(2)
  })

  it('子 Run 结算后：根 Run 还活跃，活跃任务数不变', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedTask(db, 't1', '任务一', 'wf1')
    seedTask(db, 't2', '任务二', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })
    seedRun(db, { runId: 'r2', taskId: 't2', workflowId: 'wf1' })

    settleRun(db, 'r1s')

    expect(activeCount(db, 'wf1')).toBe(2)
  })

  it('根 Run 与子 Run 都结算后：这个任务不再算活跃', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedTask(db, 't1', '任务一', 'wf1')
    seedTask(db, 't2', '任务二', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })
    seedRun(db, { runId: 'r2', taskId: 't2', workflowId: 'wf1' })

    settleRun(db, 'r1s')
    settleRun(db, 'r1')

    expect(activeCount(db, 'wf1')).toBe(1)
  })

  it('所有 Run 都结算后：活跃任务数是 0', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedTask(db, 't1', '任务一', 'wf1')
    seedTask(db, 't2', '任务二', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })
    seedRun(db, { runId: 'r2', taskId: 't2', workflowId: 'wf1' })

    settleRun(db, 'r1s')
    settleRun(db, 'r1')
    settleRun(db, 'r2')

    expect(activeCount(db, 'wf1')).toBe(0)
  })

  it('活跃任务数按流程分别统计，互不串台', () => {
    const db = ledger()
    seedWorkflow(db, 'wf1', '流程一')
    seedWorkflow(db, 'wf2', '流程二')
    seedTask(db, 't1', '任务一', 'wf1')
    seedTask(db, 't2', '任务二', 'wf1')
    seedRun(db, { runId: 'r1', taskId: 't1', workflowId: 'wf1' })
    seedRun(db, { runId: 'r1s', taskId: 't1', workflowId: 'wf1', parentRunId: 'r1' })
    seedRun(db, { runId: 'r2', taskId: 't2', workflowId: 'wf1' })
    seedRun(db, { runId: 'r3', taskId: 't2', workflowId: 'wf2' })

    expect(activeCount(db, 'wf1')).toBe(2)
    expect(activeCount(db, 'wf2')).toBe(1)

    settleRun(db, 'r2')

    expect(activeCount(db, 'wf1')).toBe(1)
    expect(activeCount(db, 'wf2')).toBe(1)
  })
})
