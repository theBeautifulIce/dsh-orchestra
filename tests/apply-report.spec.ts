import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { acquireLease } from '../src/service/commands/lease.ts'
import { applyReport, type ApplyPolicy } from '../src/service/commands/apply-report.ts'
import type { Report } from '../src/core/report.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const POLICY: ApplyPolicy = { passConditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] }

function setup(opts: { ttl?: number; now?: string } = {}) {
  const { db } = freshLedger(); seed(db)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_ar', 'r1', 'n_ar', 5, 'agent', 2, 'queued', 10, ?, ?)", [NOW, NOW])
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_ar', ownerEpoch: 1, leaseTtlMs: opts.ttl ?? 600000, now: opts.now ?? NOW }))
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='verifying' WHERE node_run_id='nr_ar'"))
  return db
}

const rep = (over: Partial<Report> = {}): Report => ({
  report_id: 'rep_1', node_run_id: 'nr_ar', attempt: 2, status: 'done',
  evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {} },
  ...over,
})

function apply(db: any, over: Partial<Report> = {}, expectedStatus = 'verifying', generation = 1, now = NOW, policy = POLICY) {
  return withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 2, report: rep(over), expectedStatus, generation, now }, policy))
}

const nodeRow = (db: any) => db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id='nr_ar'").get() as any
const events = (db: any, type: string) => (db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id='nr_ar' AND type=?").get(type) as { n: number }).n
const registry = (db: any, id = 'rep_1') => db.raw.prepare('SELECT * FROM report_registry WHERE report_id=?').get(id) as any

describe('applyReport 六步收口', () => {
  it('正常上报：accepted、applied、节点换状态、留 report_applied 带 evidence_digest', () => {
    const db = setup()
    const out = apply(db)
    expect(out).toEqual({ accepted: true, next_status: 'done', registry_state: 'applied' })
    expect(nodeRow(db).status).toBe('done')
    expect(registry(db).state).toBe('applied')
    const ev = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_ar' AND type='report_applied'").get() as { payload: string }
    expect(JSON.parse(ev.payload).evidence_digest.length).toBe(64)
  })

  it('同一 report_id 二次上报：replayed、只落一次、revision 只加一', () => {
    const db = setup()
    const before = Number(nodeRow(db).revision)
    apply(db)
    const afterFirst = Number(nodeRow(db).revision)
    const second = apply(db)
    expect(second.accepted).toBe(false)
    expect(second.reason).toBe('already_applied')
    expect(second.registry_state).toBe('replayed')
    expect(events(db, 'report_applied')).toBe(1)
    expect(Number(nodeRow(db).revision)).toBe(afterFirst)
    expect(afterFirst).toBe(before + 1)
  })

  it('attempt 不符 → rejected + attempt_mismatch + report_rejected', () => {
    const db = setup()
    const out = withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 1, report: rep(), expectedStatus: 'verifying', generation: 1, now: NOW }, POLICY))
    expect(out.registry_state).toBe('rejected')
    expect(out.reason).toBe('attempt_mismatch')
    expect(events(db, 'report_rejected')).toBe(1)
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('expectedStatus 不符 → status_mismatch', () => {
    const db = setup()
    expect(apply(db, {}, 'started').reason).toBe('status_mismatch')
  })

  it('generation 不符 → generation_mismatch', () => {
    const db = setup()
    expect(apply(db, {}, 'verifying', 9).reason).toBe('generation_mismatch')
  })

  it('租约已过期 → 抛 LEASE_EXPIRED 且节点未变', () => {
    const db = setup({ ttl: 1000 })
    expect(() => apply(db, {}, 'verifying', 1, '2026-11-13T03:00:05.000Z')).toThrowError(/租约已过期/)
    expect(nodeRow(db).status).toBe('verifying')
    expect(registry(db)).toBeUndefined()
  })

  it('report_id 空 / node_run_id 不符 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const db = setup()
    expect(() => apply(db, { report_id: '' })).toThrowError(/report_id 不能为空/)
    expect(() => apply(db, { node_run_id: 'other' })).toThrowError(/与请求不一致/)
  })

  it('证据不足（不可逆节点只给 exitCode）→ rejected 且 reason 含 verification_too_weak', () => {
    const db = setup()
    const out = apply(db, {}, 'verifying', 1, NOW, { passConditions: POLICY.passConditions, requiredHashes: ['artifact'] })
    expect(out.registry_state).toBe('rejected')
    expect(out.reason).toContain('verification_too_weak')
    expect(events(db, 'report_applied')).toBe(0)
  })

  it('第六步之前不许有副作用：判定不通过时 revision 不变、无 report_applied', () => {
    const db = setup()
    const before = Number(nodeRow(db).revision)
    const out = apply(db, { evidence: { source: 'run_tool', exitCode: 1, hashes: {} } })
    expect(out.reason).toContain('verdict_unmet')
    expect(Number(nodeRow(db).revision)).toBe(before)
    expect(events(db, 'report_applied')).toBe(0)
    expect(events(db, 'report_rejected')).toBe(1)
  })
})
