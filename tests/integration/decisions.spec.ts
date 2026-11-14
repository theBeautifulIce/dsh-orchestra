import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import {
  DECISION_KINDS,
  openDecision,
  resolveDecision,
} from '../../src/service/commands/decisions.ts'

const NOW = '2026-11-14T12:00:00.000Z'

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}

function row(db: Db, id: string): any {
  return db.raw.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(id)
}

describe('八种 decision 与活跃唯一性', () => {
  it('八种 kind 都能建一行，初始 pending、revision=1', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      for (const [index, kind] of DECISION_KINDS.entries()) {
        openDecision(tx, {
          decisionId: `d${index}`,
          runId: 'r1',
          nodeRunId: null,
          kind,
          createdAt: NOW,
        })
      }
    })
    for (const [index, kind] of DECISION_KINDS.entries()) {
      expect(row(db, `d${index}`).kind).toBe(kind)
      expect(row(db, `d${index}`).status).toBe('pending')
      expect(row(db, `d${index}`).revision).toBe(1)
    }
  })

  it('同 run 同 kind 的活跃卡只留一张；收口后可以再开', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd1', runId: 'r1', nodeRunId: null, kind: 'rule_ambiguous', createdAt: NOW })
    })
    expect(() => withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd2', runId: 'r1', nodeRunId: null, kind: 'rule_ambiguous', createdAt: NOW })
    })).toThrowError(/已有活跃 decision/)

    withTx(db, (tx) => {
      resolveDecision(tx, {
        decisionId: 'd1', revision: 1, status: 'resolved', closedReason: '已裁决', now: NOW,
      })
    })
    expect(row(db, 'd1').status).toBe('resolved')
    expect(row(db, 'd1').revision).toBe(2)

    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd2', runId: 'r1', nodeRunId: null, kind: 'rule_ambiguous', createdAt: NOW })
    })
    expect(row(db, 'd2').status).toBe('pending')
  })

  it('run 级与节点级各自由不同索引约束，两个节点互不挡', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'run-level', runId: 'r1', nodeRunId: null, kind: 'audit_result', createdAt: NOW })
      openDecision(tx, { decisionId: 'node-a', runId: 'r1', nodeRunId: 'nr-a', kind: 'verify_human', createdAt: NOW })
      openDecision(tx, { decisionId: 'node-b', runId: 'r1', nodeRunId: 'nr-b', kind: 'verify_human', createdAt: NOW })
    })
    expect(row(db, 'run-level').node_run_id).toBeNull()
    expect(row(db, 'node-a').node_run_id).toBe('nr-a')

    expect(() => withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'node-a2', runId: 'r1', nodeRunId: 'nr-a', kind: 'verify_human', createdAt: NOW })
    })).toThrowError(/已有活跃 decision/)
  })

  it('收口 CAS 带 revision，旧 revision 冲突且不改行', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd1', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution', createdAt: NOW })
    })
    expect(() => withTx(db, (tx) => {
      resolveDecision(tx, { decisionId: 'd1', revision: 99, status: 'resolved', closedReason: '旧', now: NOW })
    })).toThrowError(/CAS 未命中/)
    expect(row(db, 'd1').status).toBe('pending')
  })
})
