// S5-D 工作流管理屏（服务端侧）：草稿编辑 → 保存 → 发布 → 已发布版本不可变 → 并发修订冲突可见
import { describe, expect, it } from 'vitest'
import { freshLedger } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import {
  createWorkflowCommand, openDraftCommand, publishContextFor, publishWorkflowCommand, updateDraftCommand,
} from '../../src/service/commands/workflows.ts'
import { getWorkflowSnapshot } from '../../src/service/queries/workflows.ts'
import { getOperation } from '../../src/service/queries/get_operation.ts'
import { OrchError } from '../../src/core/errors.ts'

const NOW = '2026-11-17T12:00:00.000Z'
const RUNTIME = new Set(['agent', 'parallel', 'subworkflow', 'decision', 'wait'])

// 命令层强制 UUIDv7：版本位 7、变体位 8-b
const opId = (n: number) => `2b6a1165-5922-7bfd-814b-${String(n).padStart(12, '0')}`

const node = (id: string, type: string, title: string) => ({ node_id: id, type, title, position: { x: 0, y: 0 } })
const doc = (name: string, title = '第二步') => ({
  name,
  nodes: [node('t', 'trigger', '开始'), node('a', 'agent', title)],
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

const create = (db: Db, operationId: string) => withTx(db, (tx) => createWorkflowCommand(tx, {
  workflowId: 'wf-edit',
  name: '编辑流程',
  definition: doc('编辑流程'),
  actor: 'human:me',
  now: NOW,
  operationId,
}))

const publish = (db: Db, revision: number, baseVersion: number, note: string, operationId: string) =>
  withTx(db, (tx) => publishWorkflowCommand(tx, {
    workflowId: 'wf-edit',
    revision,
    baseVersion,
    note,
    actor: 'human:me',
    now: NOW,
    operationId,
  }, publishContextFor(tx, RUNTIME)))

const update = (db: Db, revision: number, title: string, operationId: string) => withTx(db, (tx) => updateDraftCommand(tx, {
  workflowId: 'wf-edit',
  revision,
  definition: doc('编辑流程', title),
  actor: 'human:me',
  now: NOW,
  operationId,
}))

describe('S5-D 草稿编辑与发布', () => {
  it('编辑草稿只改草稿：已发布版本原样不动', () => {
    const { db } = freshLedger()
    create(db, opId(1))
    const published = publish(db, 1, 0, '第一次发布', opId(2))
    expect(published).toMatchObject({ workflow_id: 'wf-edit', version: '1', based_on_version: null, replayed: false })

    const before = getWorkflowSnapshot(db, 'wf-edit').item
    expect(before.current?.version).toBe(1)
    expect(before.versions).toHaveLength(1)

    const opened = withTx(db, (tx) => openDraftCommand(tx, {
      workflowId: 'wf-edit', baseVersion: 1, actor: 'human:me', now: NOW, operationId: opId(3),
    }))
    expect(opened).toMatchObject({ revision: 2, based_on_version: '1', created: true })

    const updated = update(db, opened.revision, '改过的第二步', opId(4))
    expect(updated).toMatchObject({ revision: 3, changed: true })

    const after = getWorkflowSnapshot(db, 'wf-edit').item
    expect(after.draft?.revision).toBe(3)
    expect(JSON.stringify(after.draft?.definition)).toContain('改过的第二步')
    // 已发布版本一个字节都没动
    expect(after.current?.version).toBe(1)
    expect(JSON.stringify(after.current?.definition)).toBe(JSON.stringify(before.current?.definition))
    expect(after.versions).toHaveLength(1)
    db.raw.close()
  })

  it('重复发布同一 revision 被拒：版本表不落第二条，回执也不留', () => {
    const { db } = freshLedger()
    create(db, opId(1))
    publish(db, 1, 0, '第一次发布', opId(2))

    expect(codeOf(() => publish(db, 1, 0, '重复发布', opId(3)))).toBe('WORKFLOW_DRAFT_NOT_OPEN')

    const versions = db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?').get('wf-edit') as { n: number }
    expect(Number(versions.n)).toBe(1)
    const snapshot = getWorkflowSnapshot(db, 'wf-edit').item
    expect(snapshot.workflow.current_version).toBe(1)
    expect(snapshot.versions).toHaveLength(1)
    // 业务失败整笔回滚：失败命令的 inbox 行不留
    const receipt = db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE operation_id = ?').get(opId(3)) as { n: number }
    expect(Number(receipt.n)).toBe(0)
    db.raw.close()
  })

  it('并发修订冲突抛错：后到的保存不覆盖先到的', () => {
    const { db } = freshLedger()
    create(db, opId(1))

    const first = update(db, 1, '甲', opId(2))
    expect(first).toMatchObject({ revision: 2, changed: true })

    expect(codeOf(() => update(db, 1, '乙', opId(3)))).toBe('WORKFLOW_REVISION_CONFLICT')

    const snapshot = getWorkflowSnapshot(db, 'wf-edit').item
    expect(snapshot.draft?.revision).toBe(2)
    expect(JSON.stringify(snapshot.draft?.definition)).toContain('甲')
    expect(JSON.stringify(snapshot.draft?.definition)).not.toContain('乙')
    db.raw.close()
  })

  it('发布返回回执信息：同笔事务里 inbox 记 applied', () => {
    const { db } = freshLedger()
    create(db, opId(1))
    const published = publish(db, 1, 0, '第一次发布', opId(2))
    expect(published.version).toBe('1')

    const receipt = getOperation(db, opId(2))
    expect(receipt).toMatchObject({ operation_id: opId(2), kind: 'workflow.publish', status: 'applied' })
    const body = JSON.parse(receipt.receipt_json ?? '{}') as { operation_id: string; kind: string; result: { version: string } }
    expect(body.operation_id).toBe(opId(2))
    expect(body.kind).toBe('workflow.publish')
    expect(body.result.version).toBe('1')
    db.raw.close()
  })
})
