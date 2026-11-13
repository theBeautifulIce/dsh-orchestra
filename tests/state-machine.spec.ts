import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS, NON_TERMINAL_STATUSES, TERMINAL_STATUSES, canTransition, isTerminal, nextGenerationBump,
} from '../src/core/state-machine.ts'
import { freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { rearmDeadline, transitionNode } from '../src/service/commands/node-state.ts'

const NOW = '2026-11-13T02:00:00.000Z'

function row(db: any, id: string) {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(id) as any
}

function insertQueued(db: any, id: string, revision = 5) {
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, 'r1', ?, 3, 'agent', 2, 'queued', ?, ?, ?)",
      [id, id, revision, NOW, NOW],
    )
  })
}

describe('节点状态机', () => {
  it('13 种非终态、7 种终态；isTerminal 判得对', () => {
    expect(NON_TERMINAL_STATUSES).toHaveLength(13)
    expect(TERMINAL_STATUSES).toHaveLength(7)
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('started')).toBe(false)
    expect(Object.keys(ALLOWED_TRANSITIONS)).toHaveLength(20)
  })

  it('终态没有出边；queued 不能直达 dispatched，leased 可以', () => {
    expect(canTransition('done', 'started')).toBe(false)
    expect(canTransition('queued', 'dispatched')).toBe(false)
    expect(canTransition('leased', 'dispatched')).toBe(true)
  })

  it('CAS 用错 revision → STALE_GENERATION 且行未变；对的 revision → 成功并留 status_changed', () => {
    const { db } = freshLedger(); seed(db)
    insertQueued(db, 'nr_t', 5)
    try {
      withTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nr_t', from: 'queued', to: 'leased', attempt: 2, revision: 4, now: NOW, reason: 'test' }))
      expect.unreachable()
    } catch (e: any) {
      expect(e.code).toBe('STALE_GENERATION')
      expect(e.details.what).toBe('transitionNode')
    }
    expect(row(db, 'nr_t').status).toBe('queued')
    withTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nr_t', from: 'queued', to: 'leased', attempt: 2, revision: 5, now: NOW, reason: 'test' }))
    const r = row(db, 'nr_t')
    expect(r.status).toBe('leased')
    expect(Number(r.revision)).toBe(6)
    const ev = db.raw.prepare("SELECT type FROM node_run_events WHERE node_run_id='nr_t' ORDER BY seq DESC LIMIT 1").get() as { type: string }
    expect(ev.type).toBe('status_changed')
  })

  it('非法目标 queued→dispatched → STALE_GENERATION', () => {
    const { db } = freshLedger(); seed(db)
    insertQueued(db, 'nr_bad')
    expect(() => withTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nr_bad', from: 'queued', to: 'dispatched', attempt: 2, revision: 5, now: NOW, reason: 'x' })))
      .toThrowError(/不在合法迁移表里/)
  })

  it('rearmDeadline 只改 Gr 与截止字段，Ga 不动', () => {
    const { db } = freshLedger(); seed(db)
    insertQueued(db, 'nr_rd')
    withTx(db, (tx) => { tx.run("UPDATE node_runs SET action_generation = 3, rearm_generation = 1 WHERE node_run_id='nr_rd'") })
    withTx(db, (tx) => rearmDeadline(tx, TEST_SECRET, {
      nodeRunId: 'nr_rd', attempt: 2, revision: 5, deadlineAt: '2026-11-13T03:00:00.000Z',
      deadlineBootId: 'boot_1', deadlineMonotonicNs: 12345, rearmGeneration: 2, now: NOW, reason: 'bridge_recovered',
    }))
    const r = row(db, 'nr_rd')
    expect(r.deadline_at).toBe('2026-11-13T03:00:00.000Z')
    expect(Number(r.rearm_generation)).toBe(2)
    expect(Number(r.action_generation)).toBe(3)
    const ev = db.raw.prepare("SELECT type, payload FROM node_run_events WHERE node_run_id='nr_rd' ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string }
    expect(ev.type).toBe('deadline_rearmed')
    expect(JSON.parse(ev.payload).rearm_generation).toBe(2)
  })

  it('nextGenerationBump：两个代不许一起变', () => {
    const current = { actionGeneration: 2, rearmGeneration: 5 }
    expect(nextGenerationBump(current, { kind: 'redispatch', actionGeneration: 3 })).toEqual({ actionGeneration: 3, rearmGeneration: 5 })
    expect(nextGenerationBump(current, { kind: 'rearm', rearmGeneration: 6 })).toEqual({ actionGeneration: 2, rearmGeneration: 6 })
    expect(nextGenerationBump(current, { kind: 'none' })).toEqual(current)
  })
})
