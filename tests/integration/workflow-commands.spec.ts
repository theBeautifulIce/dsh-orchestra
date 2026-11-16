// 四条工作流命令：草稿分流、发布事务、版本固定（S4 计划 Task 5–8 / Q-37…Q-42）
import { describe, expect, it } from 'vitest'
import { freshLedger } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import {
  createWorkflow, createWorkflowCommand, getWorkflow, listWorkflows, openDraft, openDraftCommand,
  publishDraft, publishWorkflowCommand, updateDraft, updateDraftCommand,
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
    workflowId: 'wf1', revision: over.revision ?? 1, baseVersion: over.baseVersion ?? 0, note: '发布说明', actor: 'human:me', now: NOW, ...over,
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

    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 1, actor: 'human:me', now: NOW }))
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
    const reopened = withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 1, actor: 'human:me', now: NOW }))
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
    expect(codeOf(() => withTx(db, (tx) => openDraft(tx, { workflowId: 'nope', baseVersion: 0, actor: 'a', now: NOW })))).toBe('WORKFLOW_NOT_FOUND')
    create(db)
    expect(codeOf(() => withTx(db, (tx) => openDraft(tx, { workflowId: 'wf1', baseVersion: 0, actor: 'a', now: NOW })))).toBe('WORKFLOW_DRAFT_EXISTS')
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

describe('发布幂等与回执（Task 9）', () => {
  it('同一个 operation_id 重放：回执原样返回，不产生第二个版本', () => {
    const { db } = freshLedger()
    create(db)
    const first = withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '2b6a1165-5922-7bfd-814b-5b6d48eac59d', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(first.replayed).toBe(false)
    expect(first.version).toBe('1')

    const replay = withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '2b6a1165-5922-7bfd-814b-5b6d48eac59d', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(replay.replayed).toBe(true)
    expect(replay.version).toBe('1')

    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = 'wf1'").get() as { n: number }
    expect(Number(count.n)).toBe(1)
    const row = db.raw.prepare("SELECT status, receipt_json FROM inbox WHERE operation_id = '2b6a1165-5922-7bfd-814b-5b6d48eac59d'").get() as { status: string; receipt_json: string }
    expect(row.status).toBe('applied')
    expect(JSON.parse(row.receipt_json).result.version).toBe('1')
    const applied = db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'command.applied'").get() as { n: number }
    expect(Number(applied.n)).toBe(1)
    db.raw.close()
  })

  it('同一个 operation_id 换请求：OPERATION_ID_CONFLICT', () => {
    const { db } = freshLedger()
    create(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'c3fe93d4-8f92-755b-8b26-4c7a2be92b41', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(codeOf(() => withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 2, baseVersion: 1, operationId: 'c3fe93d4-8f92-755b-8b26-4c7a2be92b41', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))).toBe('OPERATION_ID_CONFLICT')
    db.raw.close()
  })

  it('业务失败时整笔回滚：inbox 不留 running 行，可换 operation_id 重试', () => {
    const { db } = freshLedger()
    create(db)
    withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1,
      definition: { name: '发布流程', nodes: [node('a')], edges: [] },
      actor: 'human:me', now: NOW,
    }))
    expect(codeOf(() => withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 2, baseVersion: 0, operationId: '9366fa2c-9bec-7b9a-80c9-27f9bbacc8b5', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))).toBe('WORKFLOW_VALIDATION_FAILED')
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM inbox WHERE operation_id = '9366fa2c-9bec-7b9a-80c9-27f9bbacc8b5'").get() as { n: number }
    expect(Number(row.n)).toBe(0)
    db.raw.close()
  })
})

describe('四写命令统一幂等（规格 3.7）', () => {
  const createCmd = (db: Db, over: Record<string, unknown> = {}) => withTx(db, (tx) => createWorkflowCommand(tx, {
    workflowId: 'wf1', name: '发布流程', definition: goodDoc(), operationId: '20e3a34a-8002-7f34-8eee-adb9bae660fa', actor: 'human:me', now: NOW, ...over,
  } as Parameters<typeof createWorkflowCommand>[1]))

  it('create 重放：同一个 operation_id 不重复建工作流', () => {
    const { db } = freshLedger()
    expect(createCmd(db).replayed).toBe(false)
    expect(createCmd(db).replayed).toBe(true)
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number }
    expect(Number(rows.n)).toBe(1)
    db.raw.close()
  })

  it('失败后用同一个 operation_id 重试能成功（inbox 行随事务回滚）', () => {
    const { db } = freshLedger()
    const bad = { name: '发布流程', nodes: [node('t', 'trigger')], edges: [] }
    expect(codeOf(() => createCmd(db, { operationId: '5cf6f0bd-d9ff-729b-8262-18e7322f2e5a', definition: { ...bad, name: '别的名字' } })))
      .toBe('WORKFLOW_VALIDATION_FAILED')
    const ok = createCmd(db, { operationId: '5cf6f0bd-d9ff-729b-8262-18e7322f2e5a', definition: bad })
    expect(ok.replayed).toBe(false)
    expect(ok.revision).toBe(1)
    db.raw.close()
  })

  it('open_draft 与 update 也回放各自回执', () => {
    const { db } = freshLedger()
    createCmd(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '432ff817-af14-7032-8f1c-be936d6ac560', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    const opened = withTx(db, (tx) => openDraftCommand(tx, {
      workflowId: 'wf1', baseVersion: 1, operationId: '9ae08d54-821e-75ae-8729-1dea9addb6c2', actor: 'human:me', now: NOW,
    }))
    expect(opened.replayed).toBe(false)
    const again = withTx(db, (tx) => openDraftCommand(tx, {
      workflowId: 'wf1', baseVersion: 1, operationId: '9ae08d54-821e-75ae-8729-1dea9addb6c2', actor: 'human:me', now: NOW,
    }))
    expect(again.replayed).toBe(true)
    expect(again.revision).toBe(opened.revision)

    const updated = withTx(db, (tx) => updateDraftCommand(tx, {
      workflowId: 'wf1', revision: opened.revision, definition: goodDoc(), operationId: '222bdb97-9a4b-7cde-86bf-4e57b95ed98a', actor: 'human:me', now: NOW,
    }))
    expect(updated.replayed).toBe(false)
    const updatedReplay = withTx(db, (tx) => updateDraftCommand(tx, {
      workflowId: 'wf1', revision: opened.revision, definition: goodDoc(), operationId: '222bdb97-9a4b-7cde-86bf-4e57b95ed98a', actor: 'human:me', now: NOW,
    }))
    expect(updatedReplay.replayed).toBe(true)
    expect(updatedReplay.revision).toBe(updated.revision)
    db.raw.close()
  })

  it('open_draft 的 base_version 不符：WORKFLOW_VERSION_CONFLICT', () => {
    const { db } = freshLedger()
    createCmd(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: '787af932-e54f-7397-822c-5c76eff8a436', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    expect(codeOf(() => withTx(db, (tx) => openDraft(tx, {
      workflowId: 'wf1', baseVersion: 0, actor: 'human:me', now: NOW,
    })))).toBe('WORKFLOW_VERSION_CONFLICT')
    db.raw.close()
  })

  it('回执过期：OPERATION_EXPIRED，不再回放', () => {
    const { db } = freshLedger()
    createCmd(db)
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'a642027f-52c8-7ac8-826b-417d78ad5289', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx))
    // 模拟 sweepInboxReceipts 的真实状态：清掉回执正文、只留过期标记
    withTx(db, (tx) => tx.run(
      "UPDATE inbox SET receipt_json = NULL, receipt_expired_at = ? WHERE operation_id = 'a642027f-52c8-7ac8-826b-417d78ad5289'",
      ['2026-11-16T15:00:00.000Z']))
    expect(codeOf(() => withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf1', revision: 1, baseVersion: 0, operationId: 'a642027f-52c8-7ac8-826b-417d78ad5289', note: '发布说明', actor: 'human:me', now: NOW,
    }, ctx)))).toBe('OPERATION_EXPIRED')
    db.raw.close()
  })
})

describe('update.changed=false 与 task_local 归属（P2 收口）', () => {
  it('create 时 scope 与 owner 必须成对：task_local 无 owner / reusable 带 owner 都拒', () => {
    const { db } = freshLedger()
    expect(codeOf(() => create(db, { workflowId: 'wf_bad1', scope: 'task_local', ownerTaskId: null, definition: goodDoc('缺 owner'), name: '缺 owner' })))
      .toBe('PAYLOAD_SCHEMA_INVALID')
    expect(codeOf(() => create(db, { workflowId: 'wf_bad2', scope: 'reusable', ownerTaskId: 'task_9', definition: goodDoc('多余 owner'), name: '多余 owner' })))
      .toBe('PAYLOAD_SCHEMA_INVALID')
    db.raw.close()
  })

  it('旧格式草稿 hash 兼容：同内容 update 仍是 changed=false', async () => {
    const { definitionHashOf } = await import('../../src/service/workflows.ts')
    const { db } = freshLedger()
    create(db)
    // 模拟升级前落库的草稿：definition_hash 用旧算法（runtime 投影哈希）
    withTx(db, (tx) => tx.run(
      "UPDATE workflow_drafts SET definition_hash = ? WHERE workflow_id = 'wf1'",
      [definitionHashOf({ workflow_id: 'draft', workflow_version: '0', nodes: [{ node_id: 'a', type: 'agent' }] })],
    ))
    const out = withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: goodDoc(), actor: 'human:me', now: NOW,
    }))
    expect(out.changed).toBe(false)
    expect(out.revision).toBe(1)
    db.raw.close()
  })

  it('内容没变：不递增 revision，返回 changed=false', () => {
    const { db } = freshLedger()
    create(db)
    const first = withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: goodDoc(), actor: 'human:me', now: NOW,
    }))
    expect(first.changed).toBe(false)
    expect(first.revision).toBe(1)
    const again = withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1, definition: goodDoc(), actor: 'human:me', now: NOW,
    }))
    expect(again.changed).toBe(false)
    // 真改动才 bump
    const real = withTx(db, (tx) => updateDraft(tx, {
      workflowId: 'wf1', revision: 1,
      definition: { ...goodDoc('改过的名字'), name: '改过的名字' },
      actor: 'human:me', now: NOW,
    }))
    expect(real.changed).toBe(true)
    expect(real.revision).toBe(2)
    db.raw.close()
  })

  it('task_local 不许当根工作流起；reusable 不受归属影响', async () => {
    const { createRun } = await import('../../src/service/runs.ts')
    const { WorkflowCatalog } = await import('../../src/service/workflows.ts')
    const { db } = freshLedger()
    const catalog = new WorkflowCatalog('S2', db)
    create(db, { workflowId: 'wf_task', scope: 'task_local', ownerTaskId: 'task_1', definition: goodDoc('任务专属'), name: '任务专属' })
    withTx(db, (tx) => publishWorkflowCommand(tx, {
      workflowId: 'wf_task', revision: 1, baseVersion: 0, note: '发布说明', operationId: '4f0b1a10-1111-7aaa-8bbb-000000000001', actor: 'human:me', now: NOW,
    }, ctx))
    catalog.hydrate()
    // 根入口一律不许起 task_local：只允许经子流程引用（owner 由父 run 的 task_id 对账）
    expect(codeOf(() => createRun(db, catalog, {
      taskTitle: 'x', workflowId: 'wf_task', workflowVersion: '1', now: NOW,
    }))).toBe('FORBIDDEN')
    expect(codeOf(() => createRun(db, catalog, {
      taskTitle: 'x', workflowId: 'wf_task', workflowVersion: '1', ownerTaskId: 'task_1', now: NOW,
    }))).toBe('FORBIDDEN')
    db.raw.close()
  })
})
