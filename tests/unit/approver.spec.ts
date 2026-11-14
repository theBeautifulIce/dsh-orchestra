// Task 15：批准人三档、审计能力位与证据产出者冲突。
import { describe, expect, it } from 'vitest'
import { freshLedger, seed } from '../fixtures/ledger.ts'
import { openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { assertApprover, defaultApprover, validateApprover } from '../../src/service/decision/approver.ts'
import { inTx } from '../../src/infra/db/tx.ts'

const NOW = '2026-11-13T03:00:00.000Z'

describe('decision approver', () => {
  it('agent:<role> 缺 orchestra.audit 被拒', () => {
    expect(() => assertApprover({
      approver: 'agent:auditor',
      actor: { kind: 'agent', id: 'agent_1', capabilities: [] },
    })).toThrowError(/orchestra\.audit/)
  })

  it('Agent 不能批准自己产出的证据', () => {
    expect(() => assertApprover({
      approver: 'agent:auditor',
      actor: { kind: 'agent', id: 'agent_1', capabilities: ['orchestra.audit'] },
      evidenceProducers: ['agent_1'],
    })).toThrowError(/自己产出的证据/)
  })

  it('human 档拒绝审计 Agent 提交', () => {
    expect(() => assertApprover({
      approver: 'human',
      actor: { kind: 'agent', id: 'agent_1', capabilities: ['orchestra.audit'] },
    })).toThrowError(/只能由人批准/)
  })

  it('either 先到先收口，resolved_by 落库', () => {
    const { db } = freshLedger(); seed(db)
    inTx(db, (tx) => openDecision(tx, {
      decisionId: 'dec_1', runId: 'r1', nodeRunId: null, kind: 'audit_result',
      approver: 'either', createdAt: NOW,
    }))
    inTx(db, (tx) => resolveDecision(tx, {
      decisionId: 'dec_1', revision: 1, resolution: 'approved', now: NOW,
      actor: { kind: 'human', id: 'human_1' },
    }))
    const row = db.raw.prepare('SELECT status, resolved_by FROM decisions WHERE decision_id = ?').get('dec_1')
    expect(row).toEqual({ status: 'resolved', resolved_by: 'human_1' })
  })

  it('默认分工：不可逆到人，审计结论 either', () => {
    expect(defaultApprover('pre_execution', 'irreversible')).toBe('human')
    expect(defaultApprover('audit_result')).toBe('either')
    expect(validateApprover('agent:auditor')).toBe('agent:auditor')
    expect(() => validateApprover('robot')).toThrowError(/未知的批准人档位/)
  })
})
