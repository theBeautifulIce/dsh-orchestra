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
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-a', actor: 'human:me', now: NOW,
    }, ctx))
    expect(first.version).toBe('1')
    expect(codeOf(() => withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-b', actor: 'human:me', now: NOW,
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
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-v1', actor: 'human:me', now: NOW,
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
      workflowId: 'wf1', revision: reopened.revision + 1, baseVersion: 1, operationId: 'op-v2', actor: 'human:me', now: NOW,
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
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-x', actor: 'human:me', now: NOW,
    }, ctx))
    // 草稿 revision 仍是 1，但已消费：先报 DRAFT_NOT_OPEN
    expect(codeOf(() => withTx(db, (tx) => publishDraft(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, actor: 'human:me', now: NOW,
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
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-1', actor: 'human:me', now: NOW,
    }, ctx))
    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 1, actor: 'human:me', now: NOW }))
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: reopened.revision, baseVersion: 1, operationId: 'op-2', actor: 'human:me', now: NOW,
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
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'op-imm', actor: 'human:me', now: NOW,
    }, ctx))
    expect(() => withTx(db, (tx) => tx.run("UPDATE workflow_versions SET publish_note = '改写' WHERE workflow_id = 'wf1'")))
      .toThrowError(/不可修改/)
    expect(() => withTx(db, (tx) => tx.run("DELETE FROM workflow_versions WHERE workflow_id = 'wf1'")))
      .toThrowError(/不可删除/)
    db.raw.close()
  })
})
