import { describe, expect, it } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { applyTransition, createNodeRun } from '../../src/service/commands/nodes.ts'

const SECRET = 'node-runs-secret'

const NOW = '2026-11-14T12:00:00.000Z'

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
  })
  return db
}

function insertNode(db: Db, id: string, attempt = 1, status = 'queued'): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [id, 'r1', 'n1', 1, 'agent', attempt, status, NOW, NOW],
    )
  })
}

function row(db: Db, id: string): any {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(id)
}

describe('node_run 单条 CAS 迁移执行器', () => {
  it('命中一次只改一行，revision 前进', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    withTx(db, (tx) => {
      applyTransition(tx, SECRET, {
        nodeRunId: 'nr1',
        from: ['queued'],
        to: 'leased',
        attempt: 1,
        now: NOW,
        patch: { verify_remaining_ns: 120_000_000_000 },
      })
    })
    expect(row(db, 'nr1').status).toBe('leased')
    expect(row(db, 'nr1').revision).toBe(2)
    expect(row(db, 'nr1').verify_remaining_ns).toBe(120_000_000_000)
  })

  it('旧 attempt 的迟到写影响 0 行并抛 STALE_GENERATION，事务内其他写回滚', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    expect(() => withTx(db, (tx) => {
      applyTransition(tx, SECRET, { nodeRunId: 'nr1', from: ['queued'], to: 'leased', attempt: 99, now: NOW })
    })).toThrowError(/CAS 未命中/)
    expect(row(db, 'nr1').status).toBe('queued')
    expect(row(db, 'nr1').revision).toBe(1)

    expect(() => withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'paused' WHERE run_id = 'r1'")
      applyTransition(tx, SECRET, { nodeRunId: 'nr1', from: ['queued'], to: 'leased', attempt: 99, now: NOW })
    })).toThrowError(/CAS 未命中/)
    expect((db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r1'").get() as any).status).toBe('running')
  })

  it('hang_reason 非空时普通出口被拒，allowHung 才放行', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET hang_reason = 'report_contradicted' WHERE node_run_id = 'nr1'")
    })
    expect(() => withTx(db, (tx) => {
      applyTransition(tx, SECRET, { nodeRunId: 'nr1', from: ['queued'], to: 'leased', attempt: 1, now: NOW })
    })).toThrowError(/CAS 未命中/)
    expect(row(db, 'nr1').status).toBe('queued')

    withTx(db, (tx) => {
      applyTransition(tx, SECRET, {
        nodeRunId: 'nr1', from: ['queued'], to: 'leased', attempt: 1, now: NOW,
        allowHung: true, patch: { hang_reason: null },
      })
    })
    expect(row(db, 'nr1').status).toBe('leased')
    expect(row(db, 'nr1').hang_reason).toBeNull()
  })

  it('patch 只收登记列，未知列拒绝', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    expect(() => withTx(db, (tx) => {
      applyTransition(tx, SECRET, {
        nodeRunId: 'nr1', from: ['queued'], to: 'leased', attempt: 1, now: NOW,
        patch: { status: 'done' } as any,
      })
    })).toThrowError(OrchError)
  })

  it('同一 (run,node,attempt) 换 node_run_id 插入被唯一索引拒', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    expect(() => insertNode(db, 'nr2', 1, 'running')).toThrowError(/UNIQUE|constraint/i)
  })

  it('新 attempt 记录来源，旧行只被接班一次', () => {
    const db = memoryDb()
    insertNode(db, 'nr-old', 1, 'dispatched')
    withTx(db, (tx) => {
      createNodeRun(tx, {
        newNodeRunId: 'nr-new', runId: 'r1', nodeId: 'n1', seq: 2, nodeType: 'agent',
        attempt: 2, originNodeRunId: 'nr-old', now: NOW,
      })
    })
    expect(row(db, 'nr-new').status).toBe('queued')
    expect(row(db, 'nr-new').attempt).toBe(2)
    expect(row(db, 'nr-old').replacement_node_run_id).toBe('nr-new')

    expect(() => withTx(db, (tx) => {
      createNodeRun(tx, {
        newNodeRunId: 'nr-new-2', runId: 'r1', nodeId: 'n1', seq: 3, nodeType: 'agent',
        attempt: 2, originNodeRunId: 'nr-old', now: NOW,
      })
    })).toThrowError(/不能.*接班|UNIQUE|constraint/i)
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = 'nr-new-2'").get()).toEqual({ n: 0 })
  })
})
