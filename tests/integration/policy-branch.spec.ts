import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import {
  chooseBranch, evaluatePolicy, validateBranchEdges, validatePolicy,
  type BranchEdge, type PolicyCondition,
} from '../../src/core/policy.ts'
import { applyBranchRoute, recordPolicyEvaluation } from '../../src/service/commands/nodes.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'policy-branch-secret'

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '样本', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) ' +
        "VALUES ('nr1', 'r1', 'n1', 1, 'branch', 1, 'started', 1, ?, ?)",
      [NOW, NOW],
    )
  })
  return db
}

function node(db: Db): any {
  return db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id = 'nr1'").get()
}

function eventCount(db: Db): number {
  return (db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nr1'").get() as any).n
}

describe('policy 九算子与固定输出', () => {
  const input = { a: 1, b: ['x', 'y'], s: 'abc', nested: { ok: true } }
  const cases: Array<[string, PolicyCondition, boolean]> = [
    ['eq', { path: 'a', op: 'eq', value: 1 }, true],
    ['ne', { path: 'a', op: 'ne', value: 2 }, true],
    ['in', { path: 'a', op: 'in', value: [0, 1] }, true],
    ['gt', { path: 'a', op: 'gt', value: 0 }, true],
    ['gte', { path: 'a', op: 'gte', value: 1 }, true],
    ['lt', { path: 'a', op: 'lt', value: 2 }, true],
    ['lte', { path: 'a', op: 'lte', value: 1 }, true],
    ['exists', { path: 'nested.ok', op: 'exists' }, true],
    ['match', { path: 's', op: 'match', value: '^a.c$' }, true],
  ]

  for (const [name, condition, expected] of cases) {
    it(`${name} 求值`, () => {
      expect(evaluatePolicy(condition, input).matched).toBe(expected)
    })
  }

  it('all/any/not 与数组根条件按 all 求值', () => {
    const root: PolicyCondition = {
      all: [
        { path: 'a', op: 'eq', value: 1 },
        { any: [{ path: 's', op: 'eq', value: 'no' }, { path: 's', op: 'eq', value: 'abc' }] },
        { not: { path: 'a', op: 'eq', value: 2 } },
      ],
    }
    expect(evaluatePolicy(root, input).matched).toBe(true)
    expect(evaluatePolicy([
      { path: 'a', op: 'eq', value: 1 },
      { path: 'a', op: 'eq', value: 2 },
    ], input).matched).toBe(false)
  })

  it('输出固定形状，不带 artifact，artifact 由门定义固定为 none', () => {
    const out = evaluatePolicy({ path: 'a', op: 'eq', value: 1 }, input, {
      ruleId: 'pol-1',
      evidenceIds: ['ev-1'],
    })
    expect(out).toEqual({
      schema_version: 1,
      matched: true,
      ruleId: 'pol-1',
      decision: 'pass',
      must_pass_items: [{ id: 'pol-1', result: 'pass', evidence_ids: ['ev-1'] }],
      failed_items: [],
      evidence_ids: ['ev-1'],
      reason: '全部必过项通过',
    })
    expect('artifact' in out).toBe(false)
    expect(evaluatePolicy({ path: 'a', op: 'eq', value: 2 }, input, { ruleId: 'pol-2' })).toMatchObject({
      matched: false,
      ruleId: null,
      decision: 'fail',
      failed_items: ['pol-2'],
      reason: '必过项未通过：pol-2',
    })
  })

  it('非白名单算子、非法正则、空 all、非数字比较都被编译期拒绝', () => {
    expect(() => validatePolicy({ path: 'a', op: 'eval' as any })).toThrowError(/算子不在白名单/)
    expect(() => validatePolicy({ path: 's', op: 'match', value: '(' })).toThrowError(/正则非法/)
    expect(() => validatePolicy({ all: [] })).toThrowError(/非空数组/)
    expect(() => evaluatePolicy({ path: 's', op: 'gt', value: 1 }, input)).toThrowError(/只接受数字/)
  })
})

describe('branch 路由', () => {
  const edges: readonly BranchEdge[] = [
    { to: 'fast', when: { path: 'score', op: 'gte', value: 90 }, priority: 0 },
    { to: 'slow', when: { path: 'score', op: 'lt', value: 90 }, priority: 1 },
  ]

  it('单命中选中，无命中走 default', () => {
    expect(chooseBranch(edges, { score: 95 })).toEqual({ kind: 'selected', to: 'fast', ruleId: 'fast' })
    expect(chooseBranch([...edges, { to: 'fallback', default: true }], { score: 1 })).toMatchObject({
      kind: 'selected', to: 'slow',
    })
    expect(chooseBranch([{ to: 'fallback', default: true }], { score: 1 })).toMatchObject({
      kind: 'selected', to: 'fallback',
    })
  })

  it('多命中 ambiguous，不按 priority 猜', () => {
    const ambiguous: readonly BranchEdge[] = [
      { to: 'a', when: { path: 'score', op: 'gte', value: 0 }, priority: 0 },
      { to: 'b', when: { path: 'score', op: 'gte', value: 0 }, priority: 1 },
    ]
    expect(chooseBranch(ambiguous, { score: 1 })).toEqual({
      kind: 'blocked', reason: 'ambiguous', matched: ['a', 'b'],
    })
  })

  it('静态校验：重复 to、priority/default 二选一、default 带条件、priority 越界', () => {
    expect(() => validateBranchEdges([
      { to: 'a', priority: 0 },
      { to: 'a', priority: 1 },
    ])).toThrowError(/重复/)
    expect(() => validateBranchEdges([{ to: 'a' }])).toThrowError(/二选一/)
    expect(() => validateBranchEdges([
      { to: 'a', priority: 0 },
      { to: 'b', default: true, when: { path: 'x', op: 'exists' } },
    ])).toThrowError(/default 出边不能带条件/)
    expect(() => validateBranchEdges([
      { to: 'a', default: true, when: { path: 'x', op: 'exists' } },
    ])).toThrowError(/default 出边不能带条件/)
    expect(() => validateBranchEdges([{ to: 'a', priority: 1000 }])).toThrowError(/0–999/)
  })

  it('无 default 全不命中：落 blocked_post 并开 rule_ambiguous，求值事件进 node_run_events', () => {
    const db = memoryDb()
    const before = eventCount(db)
    withTx(db, (tx) => {
      const choice = applyBranchRoute(tx, SECRET, {
        nodeRunId: 'nr1',
        attempt: 1,
        from: ['started'],
        edges: [
          { to: 'a', when: { path: 'score', op: 'gt', value: 100 }, priority: 0 },
          { to: 'b', when: { path: 'score', op: 'lt', value: 0 }, priority: 1 },
        ],
        input: { score: 50 },
        now: NOW,
      })
      expect(choice).toEqual({ kind: 'blocked', reason: 'no_match', matched: [] })
    })
    expect(node(db).status).toBe('blocked_post')
    const card = db.raw.prepare("SELECT kind, node_run_id, status FROM decisions WHERE node_run_id = 'nr1'").get() as any
    expect(card).toMatchObject({ kind: 'rule_ambiguous', node_run_id: 'nr1', status: 'pending' })
    expect(eventCount(db)).toBe(before + 2)
    const payload = db.raw.prepare(
      "SELECT payload FROM node_run_events WHERE node_run_id = 'nr1' AND type = 'policy.evaluated' ORDER BY seq DESC LIMIT 1",
    ).get() as any
    expect(JSON.parse(payload.payload)).toMatchObject({ matched: false, decision: 'fail', reason: 'branch 无命中' })
  })

  it('多命中抛 BRANCH_AMBIGUOUS，节点不动也不落事件', () => {
    const db = memoryDb()
    const before = eventCount(db)
    expect(() => withTx(db, (tx) => {
      applyBranchRoute(tx, SECRET, {
        nodeRunId: 'nr1',
        attempt: 1,
        from: ['started'],
        edges: [
          { to: 'a', when: { path: 'score', op: 'gte', value: 0 }, priority: 0 },
          { to: 'b', when: { path: 'score', op: 'gte', value: 0 }, priority: 1 },
        ],
        input: { score: 1 },
        now: NOW,
      })
    })).toThrowError(/多命中/)
    expect(node(db).status).toBe('started')
    expect(eventCount(db)).toBe(before)
  })

  it('recordPolicyEvaluation 只追加 policy.evaluated', () => {
    const db = memoryDb()
    const before = eventCount(db)
    withTx(db, (tx) => {
      const out = recordPolicyEvaluation(tx, SECRET, 'nr1', { path: 'a', op: 'eq', value: 1 }, { a: 1 }, { ruleId: 'p1' })
      expect(out.matched).toBe(true)
    })
    expect(eventCount(db)).toBe(before + 1)
    const row = db.raw.prepare(
      "SELECT type FROM node_run_events WHERE node_run_id = 'nr1' ORDER BY seq DESC LIMIT 1",
    ).get() as any
    expect(row.type).toBe('policy.evaluated')
  })
})
