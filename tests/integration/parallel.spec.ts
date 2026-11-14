import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import {
  assertIrreversibleChildrenAllowed, assertRunCanTerminal, cancelDisposition, deriveGroupState,
  isGroupSettled, pendingIrreversibleChildren, refreshRunSettling,
  type ParallelChild, type ParallelGroup,
} from '../../src/service/commands/parallel.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'parallel-secret'

function child(nodeRunId: string, status: string, sideEffectPolicy: 'pure' | 'compensable' | 'irreversible'): ParallelChild {
  return { nodeRunId, status, sideEffectPolicy }
}

function group(overrides: Partial<ParallelGroup> = {}): ParallelGroup {
  return {
    nodeRunId: 'nr-parent',
    mode: 'all',
    childNodeRunIds: ['nr1', 'nr2'],
    allowIrreversibleChildren: false,
    ...overrides,
  }
}

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '并行', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, created_at, updated_at) " +
        "VALUES ('nr-parent', 'r1', 'p', 1, 'parallel', 'started', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, parent_node_run_id, side_effect_policy, created_at, updated_at) " +
        "VALUES ('nr1', 'r1', 'a', 2, 'agent', 'started', 1, 'nr-parent', 'irreversible', ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, parent_node_run_id, side_effect_policy, created_at, updated_at) " +
        "VALUES ('nr2', 'r1', 'b', 3, 'agent', 'started', 1, 'nr-parent', 'compensable', ?, ?)",
      [NOW, NOW],
    )
  })
  return db
}

function run(db: Db): any {
  return db.raw.prepare("SELECT * FROM runs WHERE run_id = 'r1'").get()
}

function node(db: Db, id: string): any {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(id)
}

describe('并行汇聚', () => {
  it('all 要全部终态；any 首个 done 即收敛；quorum 只认 done', () => {
    expect(isGroupSettled(group(), [child('nr1', 'done', 'pure'), child('nr2', 'failed', 'pure')])).toBe(true)
    expect(isGroupSettled(group(), [child('nr1', 'done', 'pure'), child('nr2', 'started', 'pure')])).toBe(false)
    expect(isGroupSettled(group({ mode: 'any' }), [child('nr1', 'done', 'pure'), child('nr2', 'started', 'pure')])).toBe(true)
    expect(isGroupSettled(group({ mode: 'any' }), [child('nr1', 'failed', 'pure'), child('nr2', 'started', 'pure')])).toBe(false)
    expect(isGroupSettled(
      group({ mode: 'quorum', childNodeRunIds: ['nr1', 'nr2', 'nr3'], quorum: 2 }),
      [child('nr1', 'done', 'pure'), child('nr2', 'failed', 'pure'), child('nr3', 'done', 'pure')],
    )).toBe(true)
    expect(isGroupSettled(
      group({ mode: 'quorum', childNodeRunIds: ['nr1', 'nr2', 'nr3'] }),
      [child('nr1', 'done', 'pure'), child('nr2', 'failed', 'pure'), child('nr3', 'started', 'pure')],
    )).toBe(false)
  })

  it('未收口的不可逆子节点留在派生集合，any 先收敛也不消失', () => {
    const children = [
      child('nr1', 'started', 'irreversible'),
      child('nr2', 'done', 'compensable'),
    ]
    const state = deriveGroupState(group({ mode: 'any' }), children)
    expect(state.settled).toBe(true)
    expect(state.settling).toBe(true)
    expect(pendingIrreversibleChildren(group({ mode: 'any' }), children)).toEqual(['nr1'])
    expect(pendingIrreversibleChildren(group({ mode: 'any' }), [
      child('nr1', 'done', 'irreversible'),
      child('nr2', 'done', 'compensable'),
    ])).toEqual([])
  })

  it('不可逆子节点默认不许进组；取消分级不碰不可逆', () => {
    const children = [child('nr1', 'started', 'irreversible'), child('nr2', 'started', 'pure')]
    expect(() => assertIrreversibleChildrenAllowed(group(), children)).toThrowError(/不可逆子节点/)
    expect(() => assertIrreversibleChildrenAllowed(group({ allowIrreversibleChildren: true }), children)).not.toThrow()
    expect(cancelDisposition(children[0]!)).toEqual({ cancel: false, reason: 'irreversible' })
    expect(cancelDisposition(children[1]!)).toEqual({ cancel: true, reason: 'cancellable' })
    expect(cancelDisposition(child('nr3', 'done', 'pure'))).toEqual({ cancel: false, reason: 'terminal' })
  })
})

describe('运行 settling 派生与取消闸', () => {
  it('不可逆子节点在跑：settling=1 且 pending 非空，收口前清空后才放行', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      expect(refreshRunSettling(tx, 'r1', NOW)).toEqual({ settling: true, pending: ['nr1'] })
      expect(run(db).settling).toBe(1)
      expect(JSON.parse(run(db).pending_irreversible_children_json)).toEqual(['nr1'])
      expect(() => assertRunCanTerminal(tx, 'r1')).toThrowError(/不可逆子节点/)
    })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'done' WHERE node_run_id = 'nr1'")
      expect(refreshRunSettling(tx, 'r1', NOW)).toEqual({ settling: false, pending: [] })
      expect(run(db).settling).toBe(0)
      expect(() => assertRunCanTerminal(tx, 'r1')).not.toThrow()
    })
  })

  it('applyCancel 对不可逆子节点直接拒，状态和账本都不动', () => {
    const db = memoryDb()
    const before = node(db, 'nr1')
    expect(() => withTx(db, (tx) => applyCancel(tx, SECRET, {
      nodeRunId: 'nr1', attempt: 1, revision: 1, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))).toThrowError(/不可逆子节点/)
    expect(node(db, 'nr1')).toMatchObject({ status: before.status, revision: before.revision, cancel_result: null })
  })

  it('可补偿子节点仍可取消：interrupted 进 timing_out 并立围栏', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const outcome = applyCancel(tx, SECRET, {
        nodeRunId: 'nr2', attempt: 1, revision: 1, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
      })
      expect(outcome).toMatchObject({ cancel_result: 'interrupted', next_status: 'timing_out', fence_state: 'armed' })
    })
    expect(node(db, 'nr2')).toMatchObject({ status: 'timing_out', fence_state: 'armed' })
  })
})
