import { expect, it } from 'vitest'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { encodeCursor, makeCursor } from '../../src/service/queries/cursor.ts'
import { listDecisions } from '../../src/service/queries/decisions.ts'
import { ensurePreExecutionDecision, openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { createWorkflow, openDraft, publishContextFor, publishDraft, testWorkflowDraft } from '../../src/service/commands/workflows.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const OLD = '2026-11-18T01:00:00.000Z'
const NEW = '2026-11-18T02:00:00.000Z'
const CLOCK = Date.parse(NEW) + 1000

type Card = [id: string, priority: string | null, createdAt: string, status?: string]

function addCards(db: Db, cards: Card[]) {
  withTx(db, (tx) => {
    for (const [id, priority, createdAt, status = 'pending'] of cards) {
      const nodeId = 'node-' + id
      tx.run(`INSERT INTO node_runs (node_run_id, run_id, node_id, node_type, seq, status, created_at, updated_at)
        VALUES (?, 'r1', ?, 'agent', 1, 'queued', ?, ?)`, [nodeId, nodeId, createdAt, createdAt])
      tx.run(`INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, created_at, priority)
        VALUES (?, 'r1', ?, 'pre_execution', ?, 1, '{}', ?, ?)`, [id, nodeId, status, createdAt, priority])
    }
  })
}

it('Q-10 审批优先级应用于整个收件箱，跨页保留相同优先级和时间的稳定次序', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    const newer = Array.from({ length: 55 }, (_, i) => `new-${String(i).padStart(2, '0')}`)
    addCards(db, [
      ...newer.map((id): Card => [id, 'normal', NEW]),
      ['critical-a', 'critical', OLD, 'blocked_for_human'],
      ['critical-b', 'critical', OLD, 'acknowledged'],
      ['urgent', 'urgent', OLD],
      ['high', 'high', OLD],
      ['normal-old', 'normal', OLD],
      ['low', 'low', OLD],
      ['unranked', null, NEW],
      ['unknown-priority', 'toString', OLD],
      ['closed', 'critical', NEW, 'resolved'],
    ])
    const first = listDecisions(db, { now: CLOCK })
    expect(first.items.slice(0, 5).map((item) => item.decision_id)).toEqual(['critical-a', 'critical-b', 'urgent', 'high', 'normal-old'])
    expect(first.next_cursor).toBeTruthy()
    const second = listDecisions(db, { cursor: first.next_cursor!, now: CLOCK })
    const combined = [...first.items, ...second.items].map((item) => item.decision_id)
    expect(combined).toEqual(['critical-a', 'critical-b', 'urgent', 'high', 'normal-old', ...newer, 'low', 'unknown-priority', 'unranked'])
    expect(second.next_cursor).toBeNull()
    expect(() => listDecisions(db, { status: 'resolved', cursor: first.next_cursor!, now: CLOCK }))
      .toThrow(/过滤条件/)
    expect(listDecisions(db, { status: 'resolved', now: CLOCK }).items.map((item) => item.decision_id)).toEqual(['closed'])
  } finally {
    db.raw.close()
  }
})

it('Q-10 生产开卡根据不可逆节点策略落最高优先级，实际阻止同工作流发布', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    const workflowId = 'decision-priority-publish'
    const actor = { kind: 'human', id: 'human:owner' } as const
    const params = { workflowId, actor: actor.id, now: NEW }
    const runtime = new Set(['agent'])
    const policy = { requireTest: true }
    const nextRevision = withTx(db, (tx) => {
      createWorkflow(tx, { ...params, name: '批准运营操作', definition: { name: '批准运营操作', nodes: [
        { node_id: 'start', type: 'trigger', title: '入口', position: { x: 0, y: 0 } },
        { node_id: 'n1', type: 'agent', title: '运营操作', position: { x: 100, y: 0 } },
      ], edges: [{ from: 'start', to: 'n1' }] } })
      const context = publishContextFor(tx, runtime)
      testWorkflowDraft(tx, { ...params, revision: 1 }, context)
      const published = publishDraft(tx, { ...params, revision: 1, baseVersion: 0, note: '首版' }, context, policy)
      tx.run('UPDATE runs SET workflow_id = ?, workflow_version = ?, workflow_definition_hash = ? WHERE run_id = ?',
        [workflowId, published.version, published.definition_hash, 'r1'])
      tx.run("UPDATE node_runs SET status = 'queued', side_effect_policy = 'irreversible' WHERE node_run_id = 'nr1'")
      ensurePreExecutionDecision(tx, { decisionId: 'require-owner', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution',
        policy: 'irreversible', createdAt: OLD, payload: { priority: 'low', priority_reason: '自报' } })
      openDecision(tx, { decisionId: 'report-conflict', runId: 'r1', nodeRunId: 'nr1', kind: 'report_contradicted',
        createdAt: NEW, payload: { priority: 'critical' } })
      const { revision } = openDraft(tx, { ...params, baseVersion: 1 })
      testWorkflowDraft(tx, { ...params, revision }, context)
      return revision
    })
    expect(listDecisions(db, { now: CLOCK }).items).toMatchObject([
      { decision_id: 'require-owner', priority: 'critical', priority_reason: '不可逆操作需要人工审批或核实。' },
      { decision_id: 'report-conflict', priority: 'high', expiry_effect: 'none' },
    ])
    const publishNext = () => withTx(db, (tx) => publishDraft(tx, { ...params, revision: nextRevision, baseVersion: 1, note: '下一版' },
      publishContextFor(tx, runtime), policy))
    expect(publishNext).toThrow(/最高优先级审批/)
    withTx(db, (tx) => resolveDecision(tx, TEST_SECRET, { decisionId: 'require-owner', revision: 1, resolution: 'approved', actor, now: NEW }))
    expect(publishNext()).toMatchObject({ version: '2' })
  } finally {
    db.raw.close()
  }
})

it('旧游标保留时间分页直到末页，刷新回到全局优先级排序', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    addCards(db, [
      ['new-b', 'normal', NEW],
      ['new-a', 'normal', NEW],
      ['old-critical', 'critical', OLD],
    ])
    const legacyCursor = encodeCursor(makeCursor('decisions', { run_id: null, status: null }, NEW, 'new-b', 0, CLOCK))
    const tail = listDecisions(db, { cursor: legacyCursor, limit: 1, now: CLOCK })
    expect(tail.items.map((item) => item.decision_id)).toEqual(['new-a'])
    expect(tail.next_cursor).toBeTruthy()
    const last = listDecisions(db, { cursor: tail.next_cursor!, limit: 1, now: CLOCK })
    expect(last.items.map((item) => item.decision_id)).toEqual(['old-critical'])
    expect(last.next_cursor).toBeNull()
    expect(listDecisions(db, { limit: 1, now: CLOCK }).items.map((item) => item.decision_id)).toEqual(['old-critical'])
  } finally {
    db.raw.close()
  }
})
