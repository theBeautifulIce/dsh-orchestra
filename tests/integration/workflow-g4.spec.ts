// G4 必过项里的行为断言：并发发布只出一个版本、在途 run 固定旧版本、已消费草稿优先级
import { describe, expect, it } from 'vitest'
import { freshLedger, seed } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import {
  createWorkflow, openDraft, publishDraft, publishWorkflowCommand, updateDraft,
} from '../../src/service/commands/workflows.ts'
import { OrchError } from '../../src/core/errors.ts'

const NOW = '2026-11-16T18:00:00.000Z'
const RUNTIME = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])
const ctx = { registeredNodeTypes: RUNTIME, publishedVersions: () => true }

const node = (id: string, type = 'agent') => ({ node_id: id, type, title: id, position: { x: 0, y: 0 }, config: {} })
const doc = (name = '发布流程') => ({
  name,
  nodes: [node('t', 'trigger'), node('a')],
  edges: [{ from: 't', to: 'a' }],
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

function bootstrap(db: Db): void {
  withTx(db, (tx) => createWorkflow(tx, {
    workflowId: 'wf1', name: '发布流程', definition: doc(), actor: 'human:me', now: NOW,
  }))
}

describe('G4：版本固定与并发发布', () => {
  it('并发发布同一个草稿：只有一个成功，版本号只出一个', () => {
    const { db } = freshLedger()
    bootstrap(db)
    // 两个调用方都以为自己是第一：同 revision、不同 operation_id，第二个必须失败
    const first = withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '2dc9186f-37c7-705f-82be-b703c36a20c6', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(first.version).toBe('1')
    expect(codeOf(() => withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '0aecf828-f595-760d-8aad-c4577b2b5aa9', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))).toBe('WORKFLOW_DRAFT_NOT_OPEN')
    const versions = db.raw.prepare("SELECT version FROM workflow_versions WHERE workflow_id = 'wf1'").all() as { version: string }[]
    expect(versions.map((v) => v.version)).toEqual(['1'])
    db.raw.close()
  })

  it('在途 run 固定旧版本：新版本发布不改已创建 run 的解释', () => {
    const { db } = freshLedger()
    seed(db)
    bootstrap(db)
    // 起 run 前先发布 v1，run 记住 v1；之后发布 v2，run 仍按 v1 解释
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '61a6f7d5-95fe-79c5-8f31-b9e389272242', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    withTx(db, (tx) => tx.run(
      "INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) "
      + "VALUES ('r_run_pin', 't1', 'wf1', '1', 'hash-v1', 'running', 0, ?, ?)", [NOW, NOW]))

    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 1, actor: 'human:me', now: NOW }))
    expect(reopened.based_on_version).toBe('1')
    // 回滚式改动：把草稿改成另一个图再发 v2
    withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: reopened.revision,
      definition: { name: '发布流程', nodes: [node('t', 'trigger'), node('a'), node('b')], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }] },
      actor: 'human:me', now: NOW,
    }))
    const second = withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: reopened.revision + 1, baseVersion: 1, operationId: '07ea2259-9ce5-74f8-8faf-f1289e3e2cf1', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(second.version).toBe('2')
    expect(second.based_on_version).toBe('1')

    const run = db.raw.prepare("SELECT workflow_version, workflow_definition_hash FROM runs WHERE run_id = 'r_run_pin'").get() as
      { workflow_version: string; workflow_definition_hash: string }
    expect(String(run.workflow_version)).toBe('1')
    expect(run.workflow_definition_hash).toBe('hash-v1')
    db.raw.close()
  })

  it('已消费草稿优先报 DRAFT_NOT_OPEN，而不是 revision 冲突（Q-38）', () => {
    const { db } = freshLedger()
    bootstrap(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '6855f1df-1155-7427-8817-ca07265346a2', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    // 草稿 revision 仍是 1，但已消费：先报 DRAFT_NOT_OPEN
    expect(codeOf(() => withTx(db, (tx) => publishDraft(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))).toBe('WORKFLOW_DRAFT_NOT_OPEN')
    expect(codeOf(() => withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: doc(), actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_DRAFT_NOT_OPEN')
    db.raw.close()
  })

  it('based_on_version 断言：v1 为 NULL，v2 为 1（Q-37）', () => {
    const { db } = freshLedger()
    bootstrap(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '2b6a1165-5922-7bfd-814b-5b6d48eac59d', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 1, actor: 'human:me', now: NOW }))
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: reopened.revision, baseVersion: 1, operationId: 'c3fe93d4-8f92-755b-8b26-4c7a2be92b41', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    const rows = db.raw.prepare('SELECT version, based_on_version FROM workflow_versions WHERE workflow_id = ? ORDER BY version').all('wf1') as
      { version: string; based_on_version: string | null }[]
    expect(rows).toEqual([
      { version: '1', based_on_version: null },
      { version: '2', based_on_version: '1' },
    ])
    db.raw.close()
  })

  it('版本行不可变：发布后不能改也不能删（G4 版本约束）', () => {
    const { db } = freshLedger()
    bootstrap(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'e5666f49-b24e-74b2-8cf8-1c2304ebe16f', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(() => withTx(db, (tx) => tx.run("UPDATE workflow_versions SET publish_note = '改写' WHERE workflow_id = 'wf1'")))
      .toThrowError(/不可修改/)
    expect(() => withTx(db, (tx) => tx.run("DELETE FROM workflow_versions WHERE workflow_id = 'wf1'")))
      .toThrowError(/不可删除/)
    db.raw.close()
  })
})

describe('G4：发布后同进程立即可起 run（审计 P1-1）', () => {
  it('create → publish → startRun 全程不重启、不手工 load', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-e2e-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-secret', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      const created = commands.createWorkflow!({
        workflowId: 'wf1', name: '发布流程', definition: doc(), actor: 'human:me', now: NOW,
        operationId: 'b0f63807-0534-716b-81d0-b452ce91577c',
      } as never)
      expect((created as { revision: number }).revision).toBe(1)
      const published = commands.publishWorkflow!({
        workflowId: 'wf1', revision: 1, baseVersion: 0, note: '首次发布', actor: 'human:me', now: NOW,
        operationId: 'ae99238a-fd70-792c-8e51-319798508b20',
      } as never) as { version: string; definition_hash: string }
      expect(published.version).toBe('1')

      const run = commands.startRun!({
        taskTitle: '跑起来', workflowId: 'wf1', workflowVersion: '1', operationId: '535f5623-7bc9-76c1-8406-1a8c503311fd', now: NOW,
      }) as { run_id: string; workflow_version: string }
      expect(run.run_id).toBeTruthy()
      expect(String(run.workflow_version)).toBe('1')
      // 运行面只投影非 trigger 节点：trigger 是图入口，不进运行面
      const nodeIds = service.orchestra.db.raw
        .prepare('SELECT node_id FROM node_runs WHERE run_id = ? ORDER BY seq').all(run.run_id) as { node_id: string }[]
      expect(nodeIds.map((n) => n.node_id)).toEqual(['a'])
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G4：执行拓扑进定义（审计 P1-3）', () => {
  const edgeDoc = (edges: { from: string; to: string }[]) => ({
    name: '发布流程',
    nodes: [node('t', 'trigger'), node('a'), node('b')],
    edges,
  })

  it('同节点不同边：definition_hash 必须不同', async () => {
    const { runtimeProjection } = await import('../../src/service/commands/workflows.ts')
    const { definitionHashOf } = await import('../../src/service/workflows.ts')
    const h1 = definitionHashOf(runtimeProjection('wf1', '1', edgeDoc([{ from: 't', to: 'a' }, { from: 'a', to: 'b' }]) as never))
    const h2 = definitionHashOf(runtimeProjection('wf1', '1', edgeDoc([{ from: 't', to: 'a' }, { from: 'b', to: 'a' }]) as never))
    expect(h1).not.toBe(h2)
  })

  it('dispatcher 按依赖放行：a 未完成时不派发 b', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const { dispatchRun } = await import('../../src/service/dispatcher.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-dep-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-dep', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      commands.createWorkflow!({
        workflowId: 'wf_dep', name: '发布流程', actor: 'human:me', now: NOW, operationId: 'a3864b74-2372-76e3-85a5-ffbdd9101059',
        definition: edgeDoc([{ from: 't', to: 'a' }, { from: 'a', to: 'b' }]),
      } as never)
      commands.publishWorkflow!({
        workflowId: 'wf_dep', revision: 1, baseVersion: 0, note: '首次发布', actor: 'human:me', now: NOW,
        operationId: '70d74c6b-3048-7185-8565-6d04a05f2fbb',
      } as never)
      const run = commands.startRun!({
        taskTitle: '依赖顺序', workflowId: 'wf_dep', workflowVersion: '1', operationId: '95175081-289b-706f-8a3b-e799abfcee9b', now: NOW,
      }) as { run_id: string }
      const outcomes = await dispatchRun(
        { db: service.orchestra.db, secret: 'g4-dep', catalog: service.orchestra.catalog } as never,
        { runId: run.run_id, now: NOW, nodes: { a: { nodeType: 'agent' }, b: { nodeType: 'agent' } } } as never,
      )
      // a 是唯一前置完成的节点；b 等 a，这轮不派发
      expect(outcomes).toHaveLength(1)
      const statuses = service.orchestra.db.raw
        .prepare('SELECT node_id, status FROM node_runs WHERE run_id = ? ORDER BY seq').all(run.run_id) as
        { node_id: string; status: string }[]
      expect(statuses.find((s) => s.node_id === 'b')?.status).toBe('queued')
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G4：真并发发布（worker_threads + 屏障）', () => {
  it('两个 worker 同时抢一张草稿：恰好一个成功，失败方是业务冲突', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { pathToFileURL } = await import('node:url')
    const { Worker } = await import('node:worker_threads')
    const { openServiceOrchestra } = await import('../../src/index.ts')

    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-race-'))
    const dbPath = join(dir, 'orchestra.db')
    const service = await openServiceOrchestra({ dbFile: dbPath, secret: 'g4-race', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      commands.createWorkflow!({
        workflowId: 'wf_race', name: '发布流程', actor: 'human:me', now: NOW,
        operationId: 'c1a2b3c4-1111-7aaa-8bbb-000000000201',
        definition: doc(),
      } as never)

      // 每个 worker 自己开连接、自己建上下文，屏障放行后同时抢写锁
      const driverUrl = pathToFileURL(join(process.cwd(), 'src/infra/sqlite/driver.ts')).href
      const cmdsUrl = pathToFileURL(join(process.cwd(), 'src/service/commands/workflows.ts')).href
      const workerSource = `
        const { parentPort, workerData } = require('node:worker_threads')
        ;(async () => {
          const { openDb, withTx } = await import(workerData.driverUrl)
          const { publishWorkflowCommand, publishContextFor } = await import(workerData.cmdsUrl)
          const barrier = new Int32Array(workerData.barrier)
          const db = openDb(workerData.dbPath)
          const arrived = Atomics.add(barrier, 0, 1) + 1
          Atomics.notify(barrier, 0)
          const deadline = Date.now() + 5000
          while (Atomics.load(barrier, 0) < workerData.participants && Date.now() < deadline) {
            // expected 必须用本地 arrived：再读计数会把已经到 2 的值当 expected，错过 notify（审计 P2）
            Atomics.wait(barrier, 0, arrived, 50)
          }
          if (Atomics.load(barrier, 0) !== workerData.participants) {
            throw new Error('worker barrier timeout')
          }
          try {
            const out = withTx(db, (tx) => publishWorkflowCommand(tx, workerData.publish, publishContextFor(tx, new Set(['agent', 'subworkflow', 'wait']))))
            parentPort.postMessage({ ok: true, version: out.version })
          } catch (err) {
            parentPort.postMessage({ ok: false, code: err && err.code ? err.code : null, message: err && err.message })
          } finally {
            db.raw.close()
            parentPort.close()
          }
        })()
      `
      const barrierBuffer = new SharedArrayBuffer(4)
      const barrier = new Int32Array(barrierBuffer)
      const publish = (operationId: string) => ({
        workflowId: 'wf_race', revision: 1, baseVersion: 0, note: '发布说明',
        actor: 'human:me', now: NOW, operationId,
      })
      const results = await Promise.all(['c1a2b3c4-1111-7aaa-8bbb-000000000202', 'c1a2b3c4-1111-7aaa-8bbb-000000000203'].map((operationId) =>
        new Promise<{ ok: boolean; version?: string; code?: string | null }>((resolve, reject) => {
          const worker = new Worker(workerSource, {
            eval: true,
            execArgv: ['--experimental-strip-types'],
            workerData: { driverUrl, cmdsUrl, dbPath, barrier: barrierBuffer, participants: 2, publish: publish(operationId) },
          })
          worker.once('message', resolve)
          worker.once('error', reject)
        }),
      ))

      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      expect(ok).toHaveLength(1)
      expect(ok[0]!.version).toBe('1')
      expect(failed).toHaveLength(1)
      // 失败方必须是业务冲突，不是数据库错误（busy/IO 之类）
      expect(failed[0]!.code).toMatch(/^WORKFLOW_(DRAFT_NOT_OPEN|REVISION_CONFLICT|VERSION_CONFLICT)$/)

      const versions = service.orchestra.db.raw
        .prepare("SELECT version FROM workflow_versions WHERE workflow_id = 'wf_race'").all() as { version: string }[]
      expect(versions.map((v) => v.version)).toEqual(['1'])
      // 业务副作用不重复：workflow.published 只有一条，inbox 只有胜者的回执
      const events = service.orchestra.db.raw
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.published'").get() as { n: number }
      expect(Number(events.n)).toBe(1)
      const receipts = service.orchestra.db.raw
        .prepare("SELECT COUNT(*) AS n FROM inbox WHERE kind = 'workflow.publish' AND status = 'applied'").get() as { n: number }
      expect(Number(receipts.n)).toBe(1)
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G4：task_local 生命周期闭环（方向 A：预分配 task ID）', () => {
  it('预留 task → 建/发 task_local → 发父流程 → 绑定预留 task 起 run', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const { withTx } = await import('../../src/infra/sqlite/driver.ts')
    const { assertWorkflowUsable } = await import('../../src/service/commands/workflows.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-life-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-life', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      const id = (n: number) => '5e1f2a3b-0000-7aaa-8bbb-000000000' + String(300 + n).slice(-3)
      const reserved = commands.reserveTask!({ title: '专属任务', actor: 'human:me', now: NOW, operationId: id(1) }) as { task_id: string }
      expect(reserved.task_id).toBeTruthy()
      commands.createWorkflow!({
        workflowId: 'wf_child', name: '任务专属', scope: 'task_local', ownerTaskId: reserved.task_id,
        definition: { name: '任务专属', nodes: [node('t', 'trigger'), node('a')], edges: [{ from: 't', to: 'a' }] },
        actor: 'human:me', now: NOW, operationId: id(2),
      } as never)
      commands.publishWorkflow!({
        workflowId: 'wf_child', revision: 1, baseVersion: 0, note: '发布子流程', actor: 'human:me', now: NOW, operationId: id(3),
      } as never)
      commands.createWorkflow!({
        workflowId: 'wf_parent', name: '父流程',
        definition: {
          name: '父流程',
          nodes: [node('t', 'trigger'), { ...node('s', 'subworkflow'), config: { workflow_id: 'wf_child', pinned_version: 1 } }],
          edges: [{ from: 't', to: 's' }],
        },
        actor: 'human:me', now: NOW, operationId: id(4),
      } as never)
      commands.publishWorkflow!({
        workflowId: 'wf_parent', revision: 1, baseVersion: 0, note: '发布父流程', actor: 'human:me', now: NOW, operationId: id(5),
      } as never)
      const run = commands.startRun!({
        taskTitle: '跑起来', workflowId: 'wf_parent', workflowVersion: '1', taskId: reserved.task_id,
        operationId: id(6), now: NOW,
      }) as { run_id: string; task_id: string }
      expect(run.task_id).toBe(reserved.task_id)
      withTx(service.orchestra.db, (tx) => {
        expect(() => assertWorkflowUsable(tx, 'wf_child', reserved.task_id)).not.toThrow()
        expect(() => assertWorkflowUsable(tx, 'wf_child', 'task_other')).toThrowError(/只允许所属任务/)
        expect(() => assertWorkflowUsable(tx, 'wf_child', null)).toThrowError(/只允许所属任务/)
      })
      // 真实派发 subworkflow 节点：子 run 必须继承预留 task_id
      await commands.dispatch!({
        runId: run.run_id,
        nodes: { s: { tools: [] } },
        now: NOW,
      })
      const child = service.orchestra.db.raw.prepare(
        'SELECT run_id, task_id, workflow_id, workflow_version, parent_run_id, parent_node_run_id FROM runs WHERE parent_run_id = ?',
      ).get(run.run_id) as
        { run_id: string; task_id: string; workflow_id: string; workflow_version: string | number; parent_run_id: string; parent_node_run_id: string } | undefined
      expect(child).toBeTruthy()
      expect(child!.task_id).toBe(reserved.task_id)
      expect(child!.workflow_id).toBe('wf_child')
      expect(String(child!.workflow_version)).toBe('1')
      expect(child!.parent_run_id).toBe(run.run_id)
      expect(child!.parent_node_run_id).toBeTruthy()
      const parentNode = service.orchestra.db.raw.prepare(
        "SELECT node_run_id, status FROM node_runs WHERE run_id = ? AND node_id = 's'").get(run.run_id) as
        { node_run_id: string; status: string }
      expect(parentNode.status).toBe('waiting')
      // 关联必须是精确的 node_run_id，不是「非空就行」
      expect(child!.parent_node_run_id).toBe(parentNode.node_run_id)
      const started = service.orchestra.db.raw.prepare(
        "SELECT payload_redacted AS payload FROM events WHERE type = 'subworkflow.started' ORDER BY seq DESC LIMIT 1").get() as
        { payload: string } | undefined
      expect(started).toBeTruthy()
      expect(JSON.parse(started!.payload).child_run_id).toBe(child!.run_id)
      expect(() => commands.createRun!({
        taskTitle: 'x', workflowId: 'wf_child', workflowVersion: '1', now: NOW,
      } as never)).toThrowError(/只能作为子流程/)
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G4：预留任务只许消费一次', () => {
  it('第二次绑定同一预留任务（换 operation_id）必须 STALE_GENERATION', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-bind-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-bind', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      const id = (n: number) => '6f2e3d4c-0000-7aaa-8bbb-000000000' + String(400 + n).slice(-3)
      const reserved = commands.reserveTask!({ title: '一次性任务', actor: 'human:me', now: NOW, operationId: id(1) }) as { task_id: string }
      commands.createWorkflow!({
        workflowId: 'wf_once', name: '发布流程', definition: doc(), actor: 'human:me', now: NOW, operationId: id(2),
      } as never)
      commands.publishWorkflow!({
        workflowId: 'wf_once', revision: 1, baseVersion: 0, note: '首次发布', actor: 'human:me', now: NOW, operationId: id(3),
      } as never)
      const first = commands.startRun!({
        taskTitle: '第一次', workflowId: 'wf_once', workflowVersion: '1', taskId: reserved.task_id,
        operationId: id(4), now: NOW,
      }) as { task_id: string }
      expect(first.task_id).toBe(reserved.task_id)
      // 换个 operation_id 再绑同一个预留任务：必须被拒，不能悄悄新建任务
      expect(() => commands.startRun!({
        taskTitle: '第二次', workflowId: 'wf_once', workflowVersion: '1', taskId: reserved.task_id,
        operationId: id(5), now: NOW,
      } as never)).toThrowError(/预留任务已被占用/)
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G4：nodeIds 必须构成依赖闭包（审计 P1）', () => {
  const chainDoc = {
    name: '链式流程',
    nodes: [node('t', 'trigger'), node('a'), node('b'), node('c')],
    edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  }

  it('只选 A / 选 A+B / 选 A+B+C 成功；缺前置在建 run 前拒绝并列出缺谁', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-dep2-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-dep2', phase: 'S4' })
    try {
      const commands = service.orchestra.commands
      const id = (n: number) => '7a3b4c5d-0000-7aaa-8bbb-000000000' + String(500 + n).slice(-3)
      commands.createWorkflow!({
        workflowId: 'wf_chain', name: '链式流程', definition: chainDoc, actor: 'human:me', now: NOW, operationId: id(1),
      } as never)
      commands.publishWorkflow!({
        workflowId: 'wf_chain', revision: 1, baseVersion: 0, note: '首次发布', actor: 'human:me', now: NOW, operationId: id(2),
      } as never)
      const start = (nodeIds: string[], operationId: string) => commands.startRun!({
        taskTitle: '闭包', workflowId: 'wf_chain', workflowVersion: '1', nodeIds, operationId, now: NOW,
      })
      // 只选 A（trigger 不进运行面，A 无前置）→ 成功
      expect(() => start(['a'], id(3))).not.toThrow()
      // 选 A+B → 成功，B 等 A
      expect(() => start(['a', 'b'], id(4))).not.toThrow()
      // 只选 B → 建 run 前拒绝，并指出缺 a
      try {
        start(['b'], id(5))
        throw new Error('本应抛错')
      } catch (err) {
        expect((err as { code?: string }).code).toBe('PAYLOAD_SCHEMA_INVALID')
        expect(JSON.stringify((err as { details?: unknown }).details)).toContain('"a"')
      }
      // 选 A+B+C → 成功
      expect(() => start(['a', 'b', 'c'], id(6))).not.toThrow()
      // 选 B+C（缺 a）→ 拒绝
      try {
        start(['b', 'c'], id(7))
        throw new Error('本应抛错')
      } catch (err) {
        expect((err as { code?: string }).code, String(err)).toBe('PAYLOAD_SCHEMA_INVALID')
      }
    } finally {
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
