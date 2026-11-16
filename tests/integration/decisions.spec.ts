import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import {
  DECISION_KINDS,
  escalateDecisions,
  openDecision,
  resolveDecision,
} from '../../src/service/commands/decisions.ts'

const SECRET = 'decisions-secret'

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
      resolveDecision(tx, SECRET, {
        decisionId: 'd1', revision: 1, resolution: 'approved', now: NOW,
        actor: { kind: 'human', id: 'human:test' },
      })
    })
    expect(row(db, 'd1').status).toBe('resolved')
    expect(row(db, 'd1').closed_reason).toBe('approved')
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
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 99, resolution: 'rejected', actor: { kind: 'human', id: 'human:test' }, now: NOW })
    })).toThrowError(/CAS 未命中/)
    expect(row(db, 'd1').status).toBe('pending')
  })

  it('continue_wait 只续一版，status 不变', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd1', runId: 'r1', nodeRunId: 'nr1', kind: 'action_overrun', createdAt: NOW })
    })
    withTx(db, (tx) => {
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'continue_wait', actor: { kind: 'human', id: 'human:test' }, now: NOW })
    })
    expect(row(db, 'd1').status).toBe('pending')
    expect(row(db, 'd1').revision).toBe(2)
    expect(row(db, 'd1').decided_at).toBeNull()
  })

  it('2 小时升 blocked_for_human，24 小时 expired；report_contradicted 不参与', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd1', runId: 'r1', nodeRunId: null, kind: 'rule_ambiguous', createdAt: '2026-11-14T00:00:00.000Z' })
      openDecision(tx, { decisionId: 'd2', runId: 'r1', nodeRunId: null, kind: 'report_contradicted', createdAt: '2026-11-14T00:00:00.000Z' })
      tx.run("UPDATE decisions SET status = 'blocked_for_human' WHERE decision_id = 'd2'")
    })
    withTx(db, (tx) => {
      expect(escalateDecisions(tx, 'escalate-secret', { now: '2026-11-14T01:00:00.000Z' })).toEqual({ blocked: 0, expired: 0 })
    })
    expect(row(db, 'd1').status).toBe('pending')

    withTx(db, (tx) => {
      expect(escalateDecisions(tx, 'escalate-secret', { now: '2026-11-14T02:00:00.000Z' })).toEqual({ blocked: 1, expired: 0 })
    })
    expect(row(db, 'd1').status).toBe('blocked_for_human')
    expect(row(db, 'd1').revision).toBe(2)
    expect(row(db, 'd2').status).toBe('blocked_for_human')

    withTx(db, (tx) => {
      expect(escalateDecisions(tx, 'escalate-secret', { now: '2026-11-15T00:00:00.000Z' })).toEqual({ blocked: 0, expired: 1 })
    })
    expect(row(db, 'd1').status).toBe('resolved')
    expect(row(db, 'd1').closed_reason).toBe('expired_final')
    expect(row(db, 'd1').revision).toBe(3)
    expect(row(db, 'd2').status).toBe('blocked_for_human')
  })

  it('escalations 命中时开卡即 confirm_required，未显式确认不许收口', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, escalations_json, created_at, updated_at) VALUES ('t1','升级','running',1,?,?,?)",
        [JSON.stringify([{ kind: 'action_category', value: 'irreversible' }]), NOW, NOW])
      tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1','t1','running',1,?,?)", [NOW, NOW])
      openDecision(tx, {
        decisionId: 'd1', runId: 'r1', nodeRunId: null, kind: 'rule_ambiguous', createdAt: NOW,
        payload: { action_category: 'irreversible' },
      })
    })
    expect(row(db, 'd1').confirm_required).toBe(1)
    expect(() => withTx(db, (tx) => {
      resolveDecision(tx, SECRET, {
        decisionId: 'd1', revision: 1, resolution: 'approved', now: NOW,
        actor: { kind: 'human', id: 'human:test' },
      })
    })).toThrowError(/必须显式确认/)
    withTx(db, (tx) => {
      resolveDecision(tx, SECRET, {
        decisionId: 'd1', revision: 1, resolution: 'approved', now: NOW,
        confirm: true, actor: { kind: 'human', id: 'human:test' },
      })
    })
    expect(row(db, 'd1').status).toBe('resolved')
  })

  it('非纯人工卡不传批准人时拒绝，不能整体跳过校验', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      openDecision(tx, { decisionId: 'd1', runId: 'r1', nodeRunId: null, kind: 'audit_result', createdAt: NOW })
    })
    expect(() => withTx(db, (tx) => {
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'approved', now: NOW })
    })).toThrowError(/必须说明批准人/)
  })
})
