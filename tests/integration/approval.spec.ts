import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { enterBlockedPre, resumeFromBlockedPre } from '../../src/service/commands/nodes.ts'
import { ensurePreExecutionDecision, openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const LATER = '2026-11-14T13:00:00.000Z'
const SECRET = 'a'.repeat(64)
const HUMAN = { kind: 'human' as const, id: 'human:requester' }

function memoryDb(): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '审批样本', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
    tx.run(
      "INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)",
      [NOW, NOW],
    )
  })
  return db
}

function insertNode(db: Db, id: string, nodeId = 'n1'): void {
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, created_at, updated_at) ' +
        "VALUES (?, 'r1', ?, 1, 'tool', 1, 'leased', 1, 3, ?, ?)",
      [id, nodeId, NOW, NOW],
    )
    tx.run(
      "UPDATE node_runs SET lease_id = 'lease-old', lease_expires_at = ? WHERE node_run_id = ?",
      [LATER, id],
    )
  })
}

function row(db: Db, id: string): any {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(id)
}

function openApproval(db: Db, decisionId: string, id: string, opts: { contentHash?: string; expiresAt?: string } = {}): void {
  withTx(db, (tx) => {
    openDecision(tx, {
      decisionId,
      runId: 'r1',
      nodeRunId: id,
      kind: 'pre_execution',
      contentHash: opts.contentHash ?? null,
      expiresAt: opts.expiresAt ?? null,
      createdAt: NOW,
    })
  })
}

describe('审批往返与不可逆动作前置审批', () => {
  it('进入 blocked_pre 收回租约、记 resume_state，批准后回 queued 且 attempt 不变', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1', { contentHash: 'h1', expiresAt: LATER })
    withTx(db, (tx) => {
      enterBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', actionGeneration: 3, now: NOW,
      })
    })
    const blocked = row(db, 'nr1')
    expect(blocked.status).toBe('blocked_pre')
    expect(blocked.lease_id).toBeNull()
    expect(blocked.lease_expires_at).toBeNull()
    expect(blocked.resume_state).toBe('queued')
    expect(blocked.blocked_decision_id).toBe('d1')

    withTx(db, (tx) => {
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'approved', actor: HUMAN, now: NOW })
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: true, now: NOW, contentHash: 'h1',
      })
    })
    const resumed = row(db, 'nr1')
    expect(resumed.status).toBe('queued')
    expect(resumed.attempt).toBe(1)
    expect(resumed.lease_id).toBeNull()
    expect(resumed.resume_state).toBeNull()
    expect(resumed.blocked_decision_id).toBeNull()

    const events = db.raw.prepare("SELECT type, payload FROM node_run_events WHERE node_run_id = 'nr1' ORDER BY seq").all() as any[]
    expect(events.map((e) => e.type)).toEqual(['status_changed', 'status_changed'])
    expect(JSON.parse(events[1].payload).resolution).toBe('approved')
  })

  it('拒绝落 failed，审批卡 id 留在节点上备查', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1')
    withTx(db, (tx) => {
      enterBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', actionGeneration: 3, now: NOW,
      })
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'rejected', actor: HUMAN, now: NOW })
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: false, now: NOW,
      })
    })
    const failed = row(db, 'nr1')
    expect(failed.status).toBe('failed')
    expect(failed.blocked_decision_id).toBe('d1')
  })

  it('带旧租约的 blocked_pre 不许重新排队', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1')
    withTx(db, (tx) => {
      enterBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', actionGeneration: 3, now: NOW,
      })
      tx.run("UPDATE node_runs SET lease_id = 'lease-stale' WHERE node_run_id = 'nr1'")
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'approved', actor: HUMAN, now: NOW })
    })
    expect(() => withTx(db, (tx) => {
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: true, now: NOW,
      })
    })).toThrowError(/旧租约/)
    expect(row(db, 'nr1').status).toBe('blocked_pre')
  })

  it('内容哈希不一致时批准失效，节点留在 blocked_pre', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1', { contentHash: 'h1' })
    withTx(db, (tx) => {
      enterBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', actionGeneration: 3, now: NOW,
      })
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'approved', actor: HUMAN, now: NOW })
    })
    expect(() => withTx(db, (tx) => {
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: true, now: NOW, contentHash: 'h2',
      })
    })).toThrowError(/内容已变化/)
    expect(row(db, 'nr1').status).toBe('blocked_pre')
  })

  it('过期后批准不放行；超时按拒绝落 failed', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1', { expiresAt: LATER })
    withTx(db, (tx) => {
      enterBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', actionGeneration: 3, now: NOW,
      })
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'expired', actor: HUMAN, now: LATER })
    })
    expect(() => withTx(db, (tx) => {
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: true, now: LATER,
      })
    })).toThrowError(/已过期/)
    withTx(db, (tx) => {
      resumeFromBlockedPre(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 1, decisionId: 'd1', approved: false, now: LATER,
      })
    })
    expect(row(db, 'nr1').status).toBe('failed')
  })

  it('只有 irreversible 自动开前置审批，重复调用复用同一张卡', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    withTx(db, (tx) => {
      expect(ensurePreExecutionDecision(tx, {
        decisionId: 'd-pure', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution', policy: 'pure',
      })).toBeNull()
    })
    let first: string | null = null
    withTx(db, (tx) => {
      first = ensurePreExecutionDecision(tx, {
        decisionId: 'd1', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution', policy: 'irreversible',
      })
    })
    expect(first).toBe('d1')
    let again: string | null = null
    withTx(db, (tx) => {
      again = ensurePreExecutionDecision(tx, {
        decisionId: 'd2', runId: 'r1', nodeRunId: 'nr1', kind: 'pre_execution', policy: 'irreversible',
      })
    })
    expect(again).toBe('d1')
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'pre_execution'").get() as any).n).toBe(1)
  })

  it('同一 revision 只有一个赢家，第二次收口冲突', () => {
    const db = memoryDb()
    insertNode(db, 'nr1')
    openApproval(db, 'd1', 'nr1')
    withTx(db, (tx) => {
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'approved', actor: HUMAN, now: NOW })
    })
    expect(() => withTx(db, (tx) => {
      resolveDecision(tx, SECRET, { decisionId: 'd1', revision: 1, resolution: 'rejected', actor: HUMAN, now: NOW })
    })).toThrowError(/CAS 未命中/)
    const decision = db.raw.prepare("SELECT status, closed_reason FROM decisions WHERE decision_id = 'd1'").get() as any
    expect(decision).toEqual({ status: 'resolved', closed_reason: 'approved' })
  })
})
