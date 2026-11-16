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

describe('G4：两个独立连接竞争同一张草稿', () => {
  it('最多一个成功，版本表只出一个新版本', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openServiceOrchestra } = await import('../../src/index.ts')
    const { openDb, withTx } = await import('../../src/infra/sqlite/driver.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-g4-race-'))
    const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: 'g4-race', phase: 'S4' })
    const second = openDb(join(dir, 'orchestra.db'))
    try {
      const commands = service.orchestra.commands
      commands.createWorkflow!({
        workflowId: 'wf_race', name: '发布流程', actor: 'human:me', now: NOW, operationId: 'c1a2b3c4-1111-7aaa-8bbb-000000000201',
        definition: doc(),
      } as never)
      // 两个连接、同一张草稿（revision 1）各自发布
      const publish = (db: { raw: never } | never, operationId: string) =>
        withTx(db as never, (tx: never) => publishWorkflowCommand(tx as never, {
          workflowId: 'wf_race', revision: 1, baseVersion: 0, note: '发布说明', actor: 'human:me', now: NOW,
          operationId,
        } as never, ctx))
      const results = await Promise.allSettled([
        Promise.resolve().then(() => publish(service.orchestra.db, 'c1a2b3c4-1111-7aaa-8bbb-000000000202')),
        Promise.resolve().then(() => publish(second, 'c1a2b3c4-1111-7aaa-8bbb-000000000203')),
      ])
      const ok = results.filter((r) => r.status === 'fulfilled')
      const failed = results.filter((r) => r.status === 'rejected')
      expect(ok).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect((failed[0] as PromiseRejectedResult).reason?.code).toMatch(/WORKFLOW_(DRAFT_NOT_OPEN|REVISION_CONFLICT|VERSION_CONFLICT)/)
      const versions = service.orchestra.db.raw
        .prepare("SELECT version FROM workflow_versions WHERE workflow_id = 'wf_race'").all() as { version: string }[]
      expect(versions.map((v) => v.version)).toEqual(['1'])
    } finally {
      second.raw.close()
      await service.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
