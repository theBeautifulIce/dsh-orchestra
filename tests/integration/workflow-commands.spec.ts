// 四条工作流命令：草稿分流、发布事务、版本固定（S4 计划 Task 5–8 / Q-37…Q-42）
import { describe, expect, it } from 'vitest'
import { freshLedger } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import {
  createWorkflow, getWorkflow, listWorkflows, openDraft, publishDraft, updateDraft,
} from '../../src/service/commands/workflows.ts'
import { OrchError } from '../../src/core/errors.ts'

const NOW = '2026-11-16T16:00:00.000Z'
const RUNTIME = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])
const ctx = { registeredNodeTypes: RUNTIME, publishedVersions: () => true }

const node = (id: string, type = 'agent', config: Record<string, unknown> = {}) => ({
  node_id: id, type, title: id, position: { x: 0, y: 0 }, config,
})
const goodDoc = (name = '发布流程') => ({
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

const create = (db: Db, over: Partial<Parameters<typeof createWorkflow>[1]> = {}) =>
  withTx(db, (tx) => createWorkflow(tx, {
    workflowId: 'wf1', name: '发布流程', definition: goodDoc(), actor: 'human:me', now: NOW, ...over,
  }))

const publish = (db: Db, over: Partial<Parameters<typeof publishDraft>[1]> = {}, context = ctx) =>
  withTx(db, (tx) => publishDraft(tx, {
    workflowId: 'wf1', revision: over.revision ?? 1, baseVersion: over.baseVersion ?? 0, actor: 'human:me', now: NOW, ...over,
  }, context))

describe('workflow.create / update 保存层', () => {
  it('建工作流与 revision=1 的草稿，返回图语义提示', () => {
    const { db } = freshLedger()
    const out = create(db)
    expect(out).toMatchObject({ workflow_id: 'wf1', revision: 1 })
    expect(out.validation.errors).toEqual([])
    const row = withTx(db, (tx) => getWorkflow(tx, 'wf1'))
    expect(row).toMatchObject({ name: '发布流程', scope: 'reusable', current_version: null, draft_revision: 1, draft_published_version: null })
    db.raw.close()
  })

  it('重复 create 与名称不一致都被拒', () => {
    const { db } = freshLedger()
    create(db)
    expect(codeOf(() => create(db))).toBe('WORKFLOW_VERSION_CONFLICT')
    expect(codeOf(() => withTx(db, (tx) => createWorkflow(tx, {
      workflowId: 'wf2', name: '另一个名字', definition: goodDoc(), actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_VALIDATION_FAILED')
    db.raw.close()
  })

  it('update：结构性问题按具体码拒，图语义问题只作提示', () => {
    const { db } = freshLedger()
    create(db)
    const longTitle = { ...goodDoc(), nodes: [node('t', 'trigger'), node('a', 'agent')].map((n, i) => (i === 1 ? { ...n, title: 'x'.repeat(81) } : n)) }
    expect(codeOf(() => withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: longTitle, actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_TITLE_INVALID')

    const noTrigger = { name: '发布流程', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] }
    const ok = withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: noTrigger, actor: 'human:me', now: NOW,
    }))
    expect(ok.revision).toBe(2)
    expect(ok.validation.errors.map((i) => i.code)).toContain('WORKFLOW_NO_TRIGGER')
    db.raw.close()
  })

  it('update：revision 不匹配与草稿已消费分别报对应码', () => {
    const { db } = freshLedger()
    create(db)
    expect(codeOf(() => withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 9, definition: goodDoc(), actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_REVISION_CONFLICT')

    publish(db)
    expect(codeOf(() => withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: goodDoc(), actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_DRAFT_NOT_OPEN')
    db.raw.close()
  })
})

describe('workflow.publish 事务', () => {
  it('成功路径：插版本、上调 current_version、消费草稿、写事件', () => {
    const { db } = freshLedger()
    create(db)
    const out = publish(db)
    expect(out).toMatchObject({ workflow_id: 'wf1', version: '1', based_on_version: null })
    expect(out.definition_hash).toMatch(/^[0-9a-f]{64}$/)

    const wf = withTx(db, (tx) => getWorkflow(tx, 'wf1'))
    expect(wf.current_version).toBe('1')
    expect(wf.draft_published_version).toBe('1')
    const version = db.raw.prepare("SELECT doc_json, definition_json, based_on_version FROM workflow_versions WHERE workflow_id = 'wf1' AND version = '1'").get() as
      { doc_json: string; definition_json: string; based_on_version: string | null }
    expect(JSON.parse(version.doc_json).nodes).toHaveLength(2) // 文档保留 trigger
    const runtime = JSON.parse(version.definition_json)
    expect(runtime.nodes.map((n: { node_id: string }) => n.node_id)).toEqual(['a']) // 运行面没有 trigger
    expect(runtime.workflow_version).toBe('1')
    expect(version.based_on_version).toBeNull()
    const events = db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.published'").get() as { n: number }
    expect(Number(events.n)).toBe(1)
    db.raw.close()
  })

  it('同一张草稿不能发布两次；已消费后 open_draft 会重置出下一张', () => {
    const { db } = freshLedger()
    create(db)
    publish(db)
    expect(codeOf(() => publish(db))).toBe('WORKFLOW_DRAFT_NOT_OPEN')

    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', actor: 'human:me', now: NOW }))
    expect(reopened.revision).toBe(2)
    expect(reopened.based_on_version).toBe('1')
    const second = publish(db, { revision: 2, baseVersion: 1 })
    expect(second.version).toBe('2')
    expect(second.based_on_version).toBe('1')
    const wf = withTx(db, (tx) => getWorkflow(tx, 'wf1'))
    expect(wf.current_version).toBe('2')
    db.raw.close()
  })

  it('base_version 过期：WORKFLOW_VERSION_CONFLICT，不插版本', () => {
    const { db } = freshLedger()
    create(db)
    publish(db)
    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', actor: 'human:me', now: NOW }))
    expect(codeOf(() => publish(db, { revision: reopened.revision, baseVersion: 0 }))).toBe('WORKFLOW_VERSION_CONFLICT')
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = 'wf1'").get() as { n: number }
    expect(Number(count.n)).toBe(1)
    db.raw.close()
  })

  it('发布层不通过：WORKFLOW_VALIDATION_FAILED，current_version 与版本表都不动', () => {
    const { db } = freshLedger()
    create(db)
    withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1,
      definition: { name: '发布流程', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] },
      actor: 'human:me', now: NOW,
    }))
    expect(codeOf(() => publish(db, { revision: 2 }))).toBe('WORKFLOW_VALIDATION_FAILED')
    const wf = withTx(db, (tx) => getWorkflow(tx, 'wf1'))
    expect(wf.current_version).toBeNull()
    expect(wf.draft_published_version).toBeNull()
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = 'wf1'").get() as { n: number }
    expect(Number(count.n)).toBe(0)
    db.raw.close()
  })

  it('未注册节点：拒绝发布并一次列出全部不支持项', () => {
    const { db } = freshLedger()
    withTx(db, (tx) => createWorkflow(tx, {
      workflowId: 'wf1', name: '发布流程', actor: 'human:me', now: NOW,
      definition: { name: '发布流程', nodes: [node('t', 'trigger'), node('b', 'branch'), node('p', 'approval')], edges: [{ from: 't', to: 'b' }] },
    }))
    try {
      publish(db)
      throw new Error('本应抛错')
    } catch (err) {
      expect((err as OrchError).code).toBe('WORKFLOW_VALIDATION_FAILED')
      const details = (err as OrchError).details as { errors: { code: string }[] }
      expect(details.errors.filter((e) => e.code === 'NODE_NOT_SUPPORTED')).toHaveLength(2)
    }
    db.raw.close()
  })

  it('open_draft：不存在 / 从未发布 / 已有未消费草稿', () => {
    const { db } = freshLedger()
    expect(codeOf(() => withTx(db, (tx) => openDraft(tx, { workflowId: 'nope', actor: 'a', now: NOW })))).toBe('WORKFLOW_NOT_FOUND')
    create(db)
    expect(codeOf(() => withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', actor: 'a', now: NOW })))).toBe('WORKFLOW_DRAFT_EXISTS')
    db.raw.close()
  })

  it('列表按 owner 过滤，task_local 归属可查', () => {
    const { db } = freshLedger()
    create(db, { workflowId: 'wf_reuse' })
    create(db, { workflowId: 'wf_task', scope: 'task_local', ownerTaskId: 'task_1', definition: goodDoc('任务专属') , name: '任务专属' })
    const all = withTx(db, (tx) => listWorkflows(tx))
    expect(all.map((w) => w.workflow_id)).toEqual(['wf_reuse', 'wf_task'])
    const mine = withTx(db, (tx) => listWorkflows(tx, { ownerTaskId: 'task_1' }))
    expect(mine.map((w) => w.workflow_id)).toEqual(['wf_task'])
    expect(mine[0]).toMatchObject({ scope: 'task_local', owner_task_id: 'task_1' })
    db.raw.close()
  })
})
