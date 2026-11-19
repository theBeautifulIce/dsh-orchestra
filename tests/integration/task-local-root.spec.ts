// tests/integration/task-local-root.spec.ts —— P1-03：task_local 根运行只在服务端可信编排路径放行
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { OrchError } from '../../src/core/errors.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { reserveTask } from '../../src/service/runs.ts'
import {
  startRun,
  startTrustedTaskLocalRun,
  type TrustedTaskLocalRunParams,
} from '../../src/service/commands/start-run.ts'
import { createWorkflow, publishDraft } from '../../src/service/commands/workflows.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { freshLedger } from '../fixtures/ledger.ts'

const NOW = '2026-11-20T09:00:00.000Z'
const RUNTIME = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])
const PUBLISH_CTX = { registeredNodeTypes: RUNTIME, publishedVersions: () => true }

const node = (id: string, type = 'agent') => ({
  node_id: id, type, title: id, position: { x: 0, y: 0 }, config: {},
})
const doc = (name: string) => ({
  name, nodes: [node('t', 'trigger'), node('a')], edges: [{ from: 't', to: 'a' }],
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本该拒绝，却通过了')
}

function ledger(): { db: Db; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-task-local-root-'))
  const made = freshLedger(dir)
  return { db: made.db, file: made.file }
}

function reserve(db: Db, taskId: string, title: string): string {
  return reserveTask(db, { taskId, title, actor: 'human:me', now: NOW, operationId: 'op-reserve-' + taskId }).task_id
}

function taskRow(db: Db, taskId: string): { status: string; current_run_id: string | null } {
  const row = db.raw.prepare('SELECT status, current_run_id FROM tasks WHERE task_id = ?').get(taskId) as
    | { status: string; current_run_id: string | null }
    | undefined
  if (!row) throw new Error('任务不存在: ' + taskId)
  return row
}

function runCount(db: Db): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }
  return Number(row.n)
}

function operationRunId(db: Db, operationId: string): string | null {
  const row = db.raw.prepare('SELECT run_id FROM start_run_operations WHERE operation_id = ?').get(operationId) as
    | { run_id: string }
    | undefined
  return row?.run_id ?? null
}

/** 已发布的 task_local 工作流：走真实的建草稿 + 发布链路（published_by 非空） */
function publishTaskLocal(db: Db, workflowId: string, ownerTaskId: string): { definition: unknown; definition_hash: string } {
  withTx(db, (tx) => {
    createWorkflow(tx, {
      workflowId,
      name: '任务专属流程',
      scope: 'task_local',
      ownerTaskId,
      definition: doc('任务专属流程'),
      actor: 'human:me',
      now: NOW,
    })
  })
  let out!: { definition: unknown; definition_hash: string }
  withTx(db, (tx) => {
    const published = publishDraft(
      tx,
      { workflowId, revision: 1, baseVersion: 0, note: '发布任务专属流程', actor: 'human:me', now: NOW },
      PUBLISH_CTX,
    )
    out = { definition: published.definition, definition_hash: published.definition_hash }
  })
  return out
}

/** 只落过目录行、没发布过的 task_local 工作流：版本行 published_by 为空 */
function draftTaskLocal(db: Db, catalog: WorkflowCatalog, workflowId: string, ownerTaskId: string): void {
  withTx(db, (tx) => {
    createWorkflow(tx, {
      workflowId,
      name: '草稿专属流程',
      scope: 'task_local',
      ownerTaskId,
      definition: doc('草稿专属流程'),
      actor: 'human:me',
      now: NOW,
    })
  })
  catalog.load({
    workflow_id: workflowId,
    workflow_version: '1',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'n1', type: 'agent' }],
  })
}

function seedReusable(db: Db, workflowId: string): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO workflows (workflow_id, name, status, current_version, created_by, updated_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [workflowId, '可复用流程', 'active', null, 'human:me', 'human:me', NOW, NOW],
    )
  })
}

const DRIVER_URL = new URL('../../src/infra/sqlite/driver.ts', import.meta.url).href
const WORKFLOWS_URL = new URL('../../src/service/workflows.ts', import.meta.url).href
const START_RUN_URL = new URL('../../src/service/commands/start-run.ts', import.meta.url).href

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
async function main() {
  const { openDb, withTx } = await import(workerData.driverUrl)
  const { WorkflowCatalog } = await import(workerData.workflowsUrl)
  const { startTrustedTaskLocalRun } = await import(workerData.startRunUrl)
  const barrier = new Int32Array(workerData.barrier)
  Atomics.add(barrier, 0, 1)
  Atomics.notify(barrier, 0)
  const deadline = Date.now() + 5000
  while (Atomics.load(barrier, 0) < 2 && Date.now() < deadline) {
    Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 20)
  }
  const db = openDb(workerData.dbPath)
  try {
    const catalog = new WorkflowCatalog('S4', db)
    catalog.hydrate()
    const out = withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, workerData.params))
    parentPort.postMessage({ ok: true, run_id: out.run_id })
  } catch (err) {
    parentPort.postMessage({ ok: false, code: err && err.code ? err.code : String(err) })
  } finally {
    db.raw.close()
  }
}
main()
`

function spawnTrusted(input: {
  barrier: SharedArrayBuffer
  dbPath: string
  params: TrustedTaskLocalRunParams
}): Promise<{ ok: boolean; code?: string; run_id?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: ['--experimental-strip-types'],
      workerData: {
        barrier: input.barrier,
        dbPath: input.dbPath,
        driverUrl: DRIVER_URL,
        workflowsUrl: WORKFLOWS_URL,
        startRunUrl: START_RUN_URL,
        params: input.params,
      },
    })
    worker.once('message', (msg: { ok: boolean; code?: string; run_id?: string }) => {
      settled = true
      void worker.terminate()
      resolve(msg)
    })
    worker.once('error', (err) => {
      if (!settled) reject(err)
    })
    worker.once('exit', (code) => {
      if (!settled) reject(new Error('worker 提前退出: ' + code))
    })
  })
}

describe('P1-03 task_local 根运行：只有服务端可信编排路径放行', () => {
  it('AC1 伪造 task_id：普通 startRun 传 task_id 起 task_local 被拒，且不留副作用', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_1', '归属任务')
      const published = publishTaskLocal(db, 'wf_local_1', owner)
      const catalog = new WorkflowCatalog('S4', db)
      catalog.adopt(published.definition as never, published.definition_hash)

      expect(codeOf(() => startRun(db, catalog, {
        taskTitle: '客户端伪造',
        workflowId: 'wf_local_1',
        workflowVersion: '1',
        taskId: owner,
        operationId: 'op-fake-1',
        now: NOW,
      }))).toBe('FORBIDDEN')

      // 自报一个不存在的任务号也不能探出别的错误码
      expect(codeOf(() => startRun(db, catalog, {
        taskTitle: '客户端伪造',
        workflowId: 'wf_local_1',
        workflowVersion: '1',
        taskId: 'task_not_exist',
        operationId: 'op-fake-1b',
        now: NOW,
      }))).toBe('FORBIDDEN')

      expect(runCount(db)).toBe(0)
      const task = taskRow(db, owner)
      expect(task.status).toBe('reserved')
      expect(task.current_run_id).toBeNull()
    } finally {
      db.raw.close()
    }
  })

  it('AC2 owner 不匹配：别的任务起这条 task_local 被拒', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_2', '归属任务')
      const other = reserve(db, 'task_other_2', '别的任务')
      const published = publishTaskLocal(db, 'wf_local_2', owner)
      const catalog = new WorkflowCatalog('S4', db)
      catalog.adopt(published.definition as never, published.definition_hash)

      expect(codeOf(() => withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: other,
        workflowId: 'wf_local_2',
        workflowVersion: '1',
        operationId: 'op-mismatch-2',
        now: NOW,
      })))).toBe('FORBIDDEN')

      expect(runCount(db)).toBe(0)
      expect(taskRow(db, other).status).toBe('reserved')
      expect(taskRow(db, other).current_run_id).toBeNull()
      expect(taskRow(db, owner).current_run_id).toBeNull()
    } finally {
      db.raw.close()
    }
  })

  it('AC3 重复启动：同一个预留任务只能被消费一次', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_3', '归属任务')
      const published = publishTaskLocal(db, 'wf_local_3', owner)
      const catalog = new WorkflowCatalog('S4', db)
      catalog.adopt(published.definition as never, published.definition_hash)

      const first = withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_local_3',
        workflowVersion: '1',
        operationId: 'op-ac3-first',
        now: NOW,
      }))
      expect(first.task_id).toBe(owner)

      expect(codeOf(() => withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_local_3',
        workflowVersion: '1',
        operationId: 'op-ac3-second',
        now: NOW,
      })))).toBe('STALE_GENERATION')

      // 同一个 operation_id 再来一次也一样拒：任务已被消费
      expect(codeOf(() => withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_local_3',
        workflowVersion: '1',
        operationId: 'op-ac3-first',
        now: NOW,
      })))).toBe('STALE_GENERATION')

      expect(runCount(db)).toBe(1)
      expect(taskRow(db, owner).current_run_id).toBe(first.run_id)
    } finally {
      db.raw.close()
    }
  })

  it('AC4 并发启动：两个可信启动抢同一个预留任务只有一个成功', async () => {
    const { db, file } = ledger()
    try {
      const owner = reserve(db, 'task_owner_4', '归属任务')
      publishTaskLocal(db, 'wf_local_4', owner)
      const barrier = new SharedArrayBuffer(8)
      const results = await Promise.all([
        spawnTrusted({
          barrier,
          dbPath: file,
          params: { taskId: owner, workflowId: 'wf_local_4', workflowVersion: '1', operationId: 'op-race-4a', now: NOW },
        }),
        spawnTrusted({
          barrier,
          dbPath: file,
          params: { taskId: owner, workflowId: 'wf_local_4', workflowVersion: '1', operationId: 'op-race-4b', now: NOW },
        }),
      ])
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      expect(ok).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.code).toBe('STALE_GENERATION')
      expect(runCount(db)).toBe(1)
      expect(taskRow(db, owner).status).toBe('running')
    } finally {
      db.raw.close()
    }
  })

  it('AC5 未发布版本：草稿版本起不了根运行', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_5', '归属任务')
      const catalog = new WorkflowCatalog('S4', db)
      draftTaskLocal(db, catalog, 'wf_draft_5', owner)

      expect(codeOf(() => withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_draft_5',
        workflowVersion: '1',
        operationId: 'op-draft-5',
        now: NOW,
      })))).toBe('WORKFLOW_NOT_PUBLISHED')

      expect(runCount(db)).toBe(0)
      expect(taskRow(db, owner).status).toBe('reserved')
      expect(taskRow(db, owner).current_run_id).toBeNull()
    } finally {
      db.raw.close()
    }
  })

  it('AC6 可信路径成功：预留任务被消费并指向新 run', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_6', '归属任务')
      const published = publishTaskLocal(db, 'wf_local_6', owner)
      const catalog = new WorkflowCatalog('S4', db)
      catalog.adopt(published.definition as never, published.definition_hash)

      const out = withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_local_6',
        workflowVersion: '1',
        operationId: 'op-ok-6',
        now: NOW,
      }))
      expect(out.task_id).toBe(owner)
      expect(out.workflow_id).toBe('wf_local_6')
      expect(out.workflow_version).toBe('1')
      expect(out.nodes.length).toBeGreaterThan(0)

      const task = taskRow(db, owner)
      expect(task.status).toBe('running')
      expect(task.current_run_id).toBe(out.run_id)
      expect(runCount(db)).toBe(1)
      // 幂等记账仍走既有表
      expect(operationRunId(db, 'op-ok-6')).toBe(out.run_id)
    } finally {
      db.raw.close()
    }
  })

  it('AC7 工作流已停用：可信路径也拒', () => {
    const { db } = ledger()
    try {
      const owner = reserve(db, 'task_owner_7', '归属任务')
      const published = publishTaskLocal(db, 'wf_local_7', owner)
      const catalog = new WorkflowCatalog('S4', db)
      catalog.adopt(published.definition as never, published.definition_hash)
      withTx(db, (tx) => {
        tx.run("UPDATE workflows SET status = 'disabled' WHERE workflow_id = ?", ['wf_local_7'])
      })

      expect(codeOf(() => withTx(db, (tx) => startTrustedTaskLocalRun(tx, catalog, {
        taskId: owner,
        workflowId: 'wf_local_7',
        workflowVersion: '1',
        operationId: 'op-disabled-7',
        now: NOW,
      })))).toBe('FORBIDDEN')

      expect(runCount(db)).toBe(0)
      expect(taskRow(db, owner).status).toBe('reserved')
      expect(taskRow(db, owner).current_run_id).toBeNull()
    } finally {
      db.raw.close()
    }
  })

  it('AC8 无回归：reusable 流程的普通启动与预留任务启动照旧', () => {
    const { db } = ledger()
    try {
      const catalog = new WorkflowCatalog('S4', db)
      seedReusable(db, 'wf_reusable_8')
      catalog.load({
        workflow_id: 'wf_reusable_8',
        workflow_version: '1',
        pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
        nodes: [{ node_id: 'n1', type: 'agent' }],
      })

      const manual = startRun(db, catalog, {
        taskTitle: '手动起',
        workflowId: 'wf_reusable_8',
        workflowVersion: '1',
        operationId: 'op-manual-8',
        now: NOW,
      })
      expect(manual.replayed).toBe(false)
      expect(manual.run_id).toBeTruthy()

      const reserved = reserve(db, 'task_reserved_8', '预留任务')
      const bound = startRun(db, catalog, {
        taskTitle: '预留绑定',
        workflowId: 'wf_reusable_8',
        workflowVersion: '1',
        taskId: reserved,
        operationId: 'op-bind-8',
        now: NOW,
      })
      expect(bound.task_id).toBe(reserved)
      expect(taskRow(db, reserved).current_run_id).toBe(bound.run_id)
      expect(taskRow(db, reserved).status).toBe('running')
    } finally {
      db.raw.close()
    }
  })
})
