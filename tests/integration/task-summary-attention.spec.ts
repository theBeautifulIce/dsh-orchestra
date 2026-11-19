import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent } from '../../src/infra/db/ledger.ts'
import { getTaskSummary, listTaskSummaries } from '../../src/service/queries/tasks.ts'

const NOW = '2026-11-17T10:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const STOP_EVIDENCE = '补偿已执行，补偿凭据见证据附件'

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
  const dir = mkdtempSync(join(tmpdir(), 'orch-task-summary-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}

type TaskSeed = { taskId: string; runId: string; nodeRunId: string; title: string }

/** 造一个「当前运行里挂着一笔未核实副作用」的任务：节点是 compensable，且没有任何核实记录。 */
function seedTaskWithEffect(db: Db, seed: TaskSeed): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, workflow_id, workflow_version, status, display_status, current_run_id, revision, created_at, updated_at)"
      + " VALUES (?, ?, 'wf1', 1, 'running', 'running', ?, 1, ?, ?)",
      [seed.taskId, seed.title, seed.runId, NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at)"
      + " VALUES (?, ?, 'wf1', 1, 'running', 1, ?, ?)",
      [seed.runId, seed.taskId, NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at)"
      + " VALUES (?, ?, 'n1', 1, 'agent', 1, 'running', 1, 'compensable', ?, ?)",
      [seed.nodeRunId, seed.runId, NOW, NOW])
    appendEvent(tx, { type: 'task.created', runId: seed.runId, nodeRunId: seed.nodeRunId, payload: { task_id: seed.taskId } })
  })
}

function summaryOf(db: Db, taskId: string) {
  const listed = listTaskSummaries(db, { now: NOW_MS })
  const item = listed.items.find((entry) => entry.task_id === taskId)
  if (!item) throw new Error('任务列表里没有这个任务：' + taskId)
  return item
}

describe('任务摘要的待核实计数', () => {
  it('结算前有一笔未核实副作用：unverified_count=1，注意力落在 unverified', () => {
    const db = ledger()
    seedTaskWithEffect(db, { taskId: 't1', runId: 'r1', nodeRunId: 'nr1', title: '带副作用的任务' })

    const listed = summaryOf(db, 't1')
    expect(listed.unverified_count).toBe(1)
    expect(listed.attention).toBe('unverified')
    expect(listed.attention_reason).toBe('1 项外部操作待核验')
    expect(listed.max_side_effect_level).toBe('compensable')

    const single = getTaskSummary(db, 't1', NOW_MS)
    expect(single.unverified_count).toBe(1)
    expect(single.attention).toBe('unverified')
    expect(single.attention_reason).toBe('1 项外部操作待核验')
  })

  it('verified_none 结算后：unverified_count=0，注意力不再落在 unverified', () => {
    const db = ledger()
    seedTaskWithEffect(db, { taskId: 't1', runId: 'r1', nodeRunId: 'nr1', title: '带副作用的任务' })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET side_effect_verified_none = 1, stop_evidence = ? WHERE node_run_id = 'nr1'", [STOP_EVIDENCE])
      tx.run("INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, stop_evidence, resolved_at)"
        + " VALUES ('nr1', 'r1', 'verified_none', ?, ?)", [STOP_EVIDENCE, NOW])
    })

    const listed = summaryOf(db, 't1')
    expect(listed.unverified_count).toBe(0)
    expect(listed.attention).not.toBe('unverified')
    expect(listed.attention).toBe('running')
    expect(listed.attention_reason).toBe('任务仍在执行')

    const single = getTaskSummary(db, 't1', NOW_MS)
    expect(single.unverified_count).toBe(0)
    expect(single.attention).not.toBe('unverified')
    expect(single.attention).toBe('running')
  })

  it('evidence 结算后：unverified_count=0，注意力不再落在 unverified', () => {
    const db = ledger()
    seedTaskWithEffect(db, { taskId: 't1', runId: 'r1', nodeRunId: 'nr1', title: '带副作用的任务' })
    withTx(db, (tx) => {
      tx.run("INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at)"
        + " VALUES ('nr1', 1, 1, 'shell', 'tex_evidence_1', 0, 'out_hash', 'err_hash', 'cmd_hash', ?, ?)", [NOW, NOW])
      tx.run("INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, evidence_id, resolved_at)"
        + " VALUES ('nr1', 'r1', 'evidence', 'tex_evidence_1', ?)", [NOW])
    })

    const listed = summaryOf(db, 't1')
    expect(listed.unverified_count).toBe(0)
    expect(listed.attention).not.toBe('unverified')
    expect(listed.attention).toBe('running')

    const single = getTaskSummary(db, 't1', NOW_MS)
    expect(single.unverified_count).toBe(0)
    expect(single.attention).not.toBe('unverified')
    expect(single.attention).toBe('running')
  })

  it('结算后的任务不再出现在 attention=unverified 的过滤结果里', () => {
    const db = ledger()
    seedTaskWithEffect(db, { taskId: 't1', runId: 'r1', nodeRunId: 'nr1', title: '已结算的任务' })
    seedTaskWithEffect(db, { taskId: 't2', runId: 'r2', nodeRunId: 'nr2', title: '还没结算的任务' })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET side_effect_verified_none = 1, stop_evidence = ? WHERE node_run_id = 'nr1'", [STOP_EVIDENCE])
      tx.run("INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, stop_evidence, resolved_at)"
        + " VALUES ('nr1', 'r1', 'verified_none', ?, ?)", [STOP_EVIDENCE, NOW])
    })

    const unverified = listTaskSummaries(db, { attention: 'unverified', now: NOW_MS })
    expect(unverified.items.map((entry) => entry.task_id)).toEqual(['t2'])

    const settled = summaryOf(db, 't1')
    expect(settled.unverified_count).toBe(0)
    expect(settled.attention).not.toBe('unverified')
  })
})
