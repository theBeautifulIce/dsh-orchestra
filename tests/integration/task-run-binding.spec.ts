// tests/integration/task-run-binding.spec.ts —— 任务与当前 run 的绑定、收口同步与历史数据回填（审计 P1-04）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '../../src/core/workflow-def.ts'
import { applySteps, defaultMigrationsDir, loadSteps, type SchemaStep } from '../../src/infra/db/migrate.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { createRun, createRunInTx, reserveTask } from '../../src/service/runs.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const SECRET = TEST_SECRET
const NOW = '2026-11-19T02:00:00.000Z'

type TaskRow = { status: string; display_status: string | null; current_run_id: string | null }

function definition(workflowId: string): WorkflowDefinition {
  return {
    workflow_id: workflowId,
    workflow_version: '1',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'n1', type: 'agent' }],
  }
}

// 目录要挂库：触发器路径靠 workflow_versions 行做外键校验
function catalogFor(db: Db, workflowId: string): WorkflowCatalog {
  const catalog = new WorkflowCatalog('S2', db)
  catalog.load(definition(workflowId))
  return catalog
}

function taskRow(db: Db, taskId: string): TaskRow {
  return db.raw.prepare('SELECT status, display_status, current_run_id FROM tasks WHERE task_id = ?')
    .get(taskId) as TaskRow
}

// 触发规则外键指向 workflows 行，目录落库的 workflow_versions 行不够
function seedWorkflow(db: Db, workflowId: string): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO workflows (workflow_id, name, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'active', 'tester', 'tester', ?, ?)",
      [workflowId, workflowId, NOW, NOW],
    )
  })
}

// 触发器任务：任务行 + 触发规则行（触发规则的任务号唯一）
function seedTriggerTask(db: Db, workflowId: string, taskId: string, triggerId: string): void {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, trigger_kind, created_at, updated_at) VALUES (?, ?, 'queued', 0, 'scheduled', ?, ?)",
      [taskId, '触发任务', NOW, NOW],
    )
    tx.run(
      "INSERT INTO task_triggers (trigger_id, task_id, workflow_id, workflow_version, kind, enabled, revision, daily_time, time_zone, created_by, created_at, updated_at) "
      + "VALUES (?, ?, ?, '1', 'scheduled', 1, 1, '09:00', 'UTC', 'tester', ?, ?)",
      [triggerId, taskId, workflowId, NOW, NOW],
    )
  })
}

// 把 run 的节点推到终态再收口：cancel=true 时先落取消意图
function finishRun(db: Db, runId: string, nodeStatus: string, opts: { cancel?: boolean } = {}): string | null {
  return withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET status = ?, side_effect_policy = 'pure' WHERE run_id = ?", [nodeStatus, runId])
    if (opts.cancel) {
      tx.run("UPDATE runs SET cancel_requested_at = ?, cancel_result = 'interrupted' WHERE run_id = ?", [NOW, runId])
    }
    return closeRun(tx, SECRET, runId, NOW)
  })
}

// 迁移链跑到指定版本：先建库，再按版本补剩下的迁移
function ledgerUpTo(version: number): { db: Db; steps: SchemaStep[] } {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-binding-'))
  const db = openDb(join(dir, 'orchestra.db'))
  const steps = loadSteps(defaultMigrationsDir())
  applySteps(db, steps.filter((step) => step.version <= version))
  return { db, steps }
}

function seedLegacyRun(
  db: Db,
  task: { id: string; status: string; currentRunId?: string | null },
  runs: { id: string; status: string; rootRunId: string }[],
): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO tasks (task_id, title, status, revision, current_run_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
      [task.id, '历史任务', task.status, task.currentRunId ?? null, NOW, NOW],
    )
    for (const run of runs) {
      tx.run(
        'INSERT INTO runs (run_id, task_id, status, revision, started_at, created_at, updated_at, root_run_id) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
        [run.id, task.id, run.status, NOW, NOW, NOW, run.rootRunId],
      )
    }
  })
}

describe('任务与当前 run 的绑定', () => {
  it('AC1 普通手动任务：current_run_id 绑到同一笔事务创建的根 run', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-manual')
    const created = createRun(db, catalog, {
      taskTitle: '手动任务', workflowId: 'wf-manual', workflowVersion: '1', now: NOW,
    })
    const row = taskRow(db, created.task_id)
    expect(row.current_run_id).toBe(created.run_id)
    expect(row.status).toBe('running')
    const run = db.raw.prepare('SELECT root_run_id FROM runs WHERE run_id = ?').get(created.run_id) as { root_run_id: string }
    expect(run.root_run_id).toBe(created.run_id)
  })

  it('AC2 预留 task_id 启动：current_run_id 绑到根 run', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-reserved')
    const reserved = reserveTask(db, { title: '预留任务', actor: 'tester', now: NOW, operationId: 'op-reserve-binding' })
    const created = createRun(db, catalog, {
      taskTitle: '预留任务', workflowId: 'wf-reserved', workflowVersion: '1', taskId: reserved.task_id, now: NOW,
    })
    expect(created.task_id).toBe(reserved.task_id)
    const row = taskRow(db, reserved.task_id)
    expect(row.current_run_id).toBe(created.run_id)
    expect(row.status).toBe('running')
  })

  it('AC3 触发器创建运行：current_run_id 绑到根 run', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-trigger')
    seedWorkflow(db, 'wf-trigger')
    seedTriggerTask(db, 'wf-trigger', 'task-trigger', 'trigger-binding')
    const created = withTx(db, (tx) => createRunInTx(tx, catalog, {
      taskTitle: '触发任务', workflowId: 'wf-trigger', workflowVersion: '1', triggerKind: 'scheduled', now: NOW,
    }, 'trigger-binding'))
    expect(taskRow(db, 'task-trigger').current_run_id).toBe(created.run_id)
    expect(taskRow(db, 'task-trigger').status).toBe('running')
  })
})

describe('run 收口同步任务状态', () => {
  it('AC4 普通任务收口为 succeeded：任务状态跟着走', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-succeeded')
    const created = createRun(db, catalog, {
      taskTitle: '成功任务', workflowId: 'wf-succeeded', workflowVersion: '1', now: NOW,
    })
    expect(finishRun(db, created.run_id, 'done')).toBe('succeeded')
    const row = taskRow(db, created.task_id)
    expect(row.status).toBe('succeeded')
    expect(row.display_status).toBeNull()
  })

  it('AC4 普通任务收口为 failed：任务状态跟着走', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-failed')
    const created = createRun(db, catalog, {
      taskTitle: '失败任务', workflowId: 'wf-failed', workflowVersion: '1', now: NOW,
    })
    expect(finishRun(db, created.run_id, 'failed')).toBe('failed')
    expect(taskRow(db, created.task_id).status).toBe('failed')
  })

  it('AC4 普通任务收口为 cancelled：任务状态跟着走', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-cancelled')
    const created = createRun(db, catalog, {
      taskTitle: '取消任务', workflowId: 'wf-cancelled', workflowVersion: '1', now: NOW,
    })
    expect(finishRun(db, created.run_id, 'done', { cancel: true })).toBe('cancelled')
    expect(taskRow(db, created.task_id).status).toBe('cancelled')
  })

  it('AC5 旧 run 迟到收口不覆盖后启动 run 的任务状态', () => {
    const { db } = freshLedger()
    const catalog = catalogFor(db, 'wf-late')
    seedWorkflow(db, 'wf-late')
    seedTriggerTask(db, 'wf-late', 'task-late', 'trigger-late')
    const params = {
      taskTitle: '迟到收口', workflowId: 'wf-late', workflowVersion: '1', triggerKind: 'scheduled' as const, now: NOW,
    }
    const first = withTx(db, (tx) => createRunInTx(tx, catalog, params, 'trigger-late'))
    const second = withTx(db, (tx) => createRunInTx(tx, catalog, params, 'trigger-late'))
    expect(taskRow(db, 'task-late').current_run_id).toBe(second.run_id)
    // 旧 run 这时才收口：任务当前 run 已经是第二条，不能被覆盖
    expect(finishRun(db, first.run_id, 'done')).toBe('succeeded')
    const row = taskRow(db, 'task-late')
    expect(row.current_run_id).toBe(second.run_id)
    expect(row.status).toBe('running')
    // 新 run 收口后任务状态才跟着更新
    expect(finishRun(db, second.run_id, 'done')).toBe('succeeded')
    expect(taskRow(db, 'task-late').status).toBe('succeeded')
  })
})

describe('迁移 043：历史任务的 current_run_id 回填', () => {
  it('AC6 空库：043 跑通、核对表就位、迁移可重复执行', () => {
    const { db, steps } = ledgerUpTo(42)
    const applied = applySteps(db, steps)
    expect(applied).toContain(43)
    const table = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_run_binding_review'").get()
    expect(table).toBeDefined()
    const reviewCount = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM task_run_binding_review').get() as { n: number }).n)
    expect(reviewCount).toBe(0)
    // 重复执行：不再改任何东西
    expect(applySteps(db, steps)).toEqual([])
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM task_run_binding_review').get() as { n: number }).n)).toBe(0)
  })

  it('AC6 含历史数据：单 run 任务被绑定，多 run 任务留核对记录而不是被随意绑定', () => {
    const { db, steps } = ledgerUpTo(42)
    // 单 run 任务：可唯一判定
    seedLegacyRun(db, { id: 't-single', status: 'running' }, [{ id: 'r-single', status: 'succeeded', rootRunId: 'r-single' }])
    // 多 run 任务：两条根 run，先后不明
    seedLegacyRun(db, { id: 't-multi', status: 'running' }, [
      { id: 'r-multi-1', status: 'succeeded', rootRunId: 'r-multi-1' },
      { id: 'r-multi-2', status: 'succeeded', rootRunId: 'r-multi-2' },
    ])
    // 只有子 run 的任务：名下没有根 run
    seedLegacyRun(db, { id: 't-child', status: 'running' }, [{ id: 'r-child', status: 'succeeded', rootRunId: 'r-single' }])
    // 预留任务：本来就没有当前 run
    seedLegacyRun(db, { id: 't-reserved', status: 'reserved' }, [])
    // 已绑定的任务：不动
    seedLegacyRun(db, { id: 't-bound', status: 'running', currentRunId: 'r-bound' }, [
      { id: 'r-bound', status: 'running', rootRunId: 'r-bound' },
    ])

    expect(applySteps(db, steps)).toContain(43)

    // 单 run 任务：绑上根 run，run 已终态则任务状态一并同步
    const single = taskRow(db, 't-single')
    expect(single.current_run_id).toBe('r-single')
    expect(single.status).toBe('succeeded')
    // 多 run 任务：不绑定，只留核对记录
    expect(taskRow(db, 't-multi').current_run_id).toBeNull()
    const multi = db.raw.prepare(
      "SELECT task_id, candidate_run_id, reason FROM task_run_binding_review WHERE task_id = 't-multi' ORDER BY candidate_run_id",
    ).all() as { task_id: string; candidate_run_id: string; reason: string }[]
    expect(multi.map((row) => row.candidate_run_id)).toEqual(['r-multi-1', 'r-multi-2'])
    expect(multi.every((row) => row.reason === 'multiple_root_runs')).toBe(true)
    // 只有子 run 的任务：留核对记录
    expect(taskRow(db, 't-child').current_run_id).toBeNull()
    const child = db.raw.prepare(
      "SELECT candidate_run_id, reason FROM task_run_binding_review WHERE task_id = 't-child'",
    ).all() as { candidate_run_id: string; reason: string }[]
    expect(child).toEqual([{ candidate_run_id: 'r-child', reason: 'no_root_run' }])
    // 预留任务与已绑定的任务都不动
    expect(taskRow(db, 't-reserved').current_run_id).toBeNull()
    expect(taskRow(db, 't-bound').current_run_id).toBe('r-bound')
    expect(taskRow(db, 't-bound').status).toBe('running')

    // 迁移可重复执行：版本记账会跳过已应用的迁移
    expect(applySteps(db, steps)).toEqual([])
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM task_run_binding_review').get() as { n: number }).n)).toBe(3)
    expect(taskRow(db, 't-single').current_run_id).toBe('r-single')
    // 语句级也要幂等：直接重跑 043 的语句，不再新增核对记录，也不再改绑定
    const step = steps.find((item) => item.version === 43)!
    withTx(db, (tx) => {
      for (const sql of step.statements) tx.exec(sql)
    })
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM task_run_binding_review').get() as { n: number }).n)).toBe(3)
    expect(taskRow(db, 't-single').current_run_id).toBe('r-single')
    expect(taskRow(db, 't-multi').current_run_id).toBeNull()
    expect(taskRow(db, 't-child').current_run_id).toBeNull()
    expect(taskRow(db, 't-reserved').current_run_id).toBeNull()
  })
})
