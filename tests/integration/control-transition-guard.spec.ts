// 控制节点的迁移守卫：同一对状态有多条规则时，必须显式点名走哪条（G3 r11 P1-1）。
import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { applyTransition } from '../../src/service/commands/nodes.ts'

const NOW = '2026-11-14T12:00:00.000Z'

function memoryDb(status = 'waiting'): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '控制节点', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) "
      + "VALUES ('nr1', 'r1', 'sub', 1, ?, 1, ?, 1, ?, ?)",
      [status === 'waiting' ? 'subworkflow' : 'agent', status, NOW, NOW],
    )
  })
  return db
}

const controlContext = { hasToolCall: false, cancelResult: null as null, hangReason: null as null, sideEffectVerifiedNone: true, controlCompletion: true }

describe('控制节点迁移守卫', () => {
  it('waiting → failed 不写 ruleId：拒绝，不能再借 M-48 放行', () => {
    const db = memoryDb()
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'failed', attempt: 1, now: NOW, context: controlContext,
    }))).toThrowError(/必须显式给出 ruleId/)
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('waiting')
  })

  it('waiting → failed 走 M-64 且 controlCompletion=true：允许', () => {
    const db = memoryDb()
    withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'failed', ruleId: 'M-64', attempt: 1, now: NOW, context: controlContext,
    }))
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('failed')
  })

  it('waiting → failed 走 M-64 但缺少控制完成事实：拒绝', () => {
    const db = memoryDb()
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'failed', ruleId: 'M-64', attempt: 1, now: NOW,
      context: { ...controlContext, controlCompletion: false },
    }))).toThrowError(/前提不成立/)
  })

  it('waiting → done 走 M-63；没有控制完成事实时同样拒绝', () => {
    const db = memoryDb()
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'done', ruleId: 'M-63', attempt: 1, now: NOW,
      context: { ...controlContext, controlCompletion: false },
    }))).toThrowError(/前提不成立/)
    withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'done', ruleId: 'M-63', attempt: 1, now: NOW, context: controlContext,
    }))
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('done')
  })

  it('started → failed：普通失败边与 M-29 共存，不写 ruleId 也要拒绝', () => {
    const db = memoryDb('started')
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['started'], to: 'failed', attempt: 1, now: NOW,
      context: { hasToolCall: false, cancelResult: 'already_stopped', hangReason: null, sideEffectVerifiedNone: true },
    }))).toThrowError(/必须显式给出 ruleId/)
    // liveness 恢复自己有一条明确规则，不借用控制节点出口
    withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['started'], to: 'failed', ruleId: 'M-48', attempt: 1, now: NOW,
      context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
    }))
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('failed')
  })

  it('显式 ruleId 与来源状态不匹配：拒绝且不改行', () => {
    const db = memoryDb()
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['waiting'], to: 'done', ruleId: 'M-64', attempt: 1, now: NOW, context: controlContext,
    }))).toThrowError(/显式规则与来源\/目标不匹配/)
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('waiting')
  })
})

describe('同状态写也必须校验显式规则', () => {
  it('stopping → stopping 带不匹配的 ruleId：拒绝，规则不能形同虚设', () => {
    const db = memoryDb('stopping')
    expect(() => withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['stopping'], to: 'stopping', ruleId: 'M-48', attempt: 1, now: NOW,
      context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true },
    }))).toThrowError(/显式规则与来源\/目标不匹配/)
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('stopping')
  })

  it('同状态写不写 ruleId 仍然允许（挂起/清挂起补丁不受影响）', () => {
    const db = memoryDb('stopping')
    withTx(db, (tx) => applyTransition(tx, {
      nodeRunId: 'nr1', from: ['stopping'], to: 'stopping', attempt: 1, now: NOW, patch: { hang_reason: 'action_overrun' },
    }))
    expect((db.raw.prepare('SELECT hang_reason FROM node_runs WHERE node_run_id = ?').get('nr1') as { hang_reason: string }).hang_reason).toBe('action_overrun')
  })
})

describe('控制节点不能走执行器迁移入口', () => {
  it('transitionNode 对 wait/subworkflow 节点直接拒绝', async () => {
    const { transitionNode } = await import('../../src/service/commands/node-state.ts')
    const db = memoryDb()
    expect(() => withTx(db, (tx) => transitionNode(tx, 's', {
      nodeRunId: 'nr1', from: 'waiting', to: 'failed', attempt: 1, revision: 1, now: NOW, reason: 'executor_report',
    }))).toThrowError(/控制节点迁移必须走 applyTransition/)
    expect((db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get('nr1') as { status: string }).status).toBe('waiting')
  })
})
