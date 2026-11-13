import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from './fixtures/ledger.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { acquireLease } from '../src/service/commands/lease.ts'
import { applyReport, type ApplyPolicy } from '../src/service/commands/apply-report.ts'
import type { Report } from '../src/core/report.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const POLICY: ApplyPolicy = { passConditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] }

function setup(opts: { ttl?: number; now?: string; trace?: boolean } = {}) {
  const { db } = freshLedger(); seed(db)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_ar', 'r1', 'n_ar', 5, 'agent', 2, 'queued', 10, ?, ?)", [NOW, NOW])
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_ar', ownerEpoch: 1, leaseTtlMs: opts.ttl ?? 600000, now: opts.now ?? NOW }))
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='verifying' WHERE node_run_id='nr_ar'"))
  // 工具执行痕迹：done 报告的证据要对得上这条痕迹，伪造的 done 才分得开（审计 R3-03）
  if (opts.trace !== false) {
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 'ro.echo', 0, 'h', NULL, 'cmdhash', ?, ?)",
        [NOW, NOW],
      )
    })
  }
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

  it('generation 不符 → 抛 STALE_GENERATION，账本不落', () => {
    const db = setup()
    expect(() => apply(db, {}, 'verifying', 9)).toThrowError(/动作代对不上/)
    expect(registry(db)).toBeUndefined()
    expect(nodeRow(db).status).toBe('verifying')
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

  it('第六步之前不许有副作用：工具失败时 revision 不变、无 report_applied', () => {
    const db = setup()
    const before = Number(nodeRow(db).revision)
    const out = apply(db, { evidence: { source: 'run_tool', exitCode: 1, hashes: {} } })
    expect(out.reason).toContain('tool_execution_failed')
    expect(Number(nodeRow(db).revision)).toBe(before)
    expect(events(db, 'report_applied')).toBe(0)
    expect(events(db, 'report_rejected')).toBe(1)
  })
})

describe('报告身份与跨节点（审计 N-05 / N-06 / N-07）', () => {
  it('report.attempt 与请求不一致 → attempt_mismatch，节点不动', () => {
    const db = setup()
    const out = withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 2, report: rep({ attempt: 999 }), expectedStatus: 'verifying', generation: 1, now: NOW }, POLICY))
    expect(out.registry_state).toBe('rejected')
    expect(out.reason).toBe('attempt_mismatch')
    expect(nodeRow(db).status).toBe('verifying')
    expect(events(db, 'report_applied')).toBe(0)
  })

  it('report_id 已属于别的节点 → 跨节点重放按结构错拒', () => {
    const db = setup()
    apply(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_other', 'r1', 'n_other', 6, 'agent', 2, 'verifying', 3, ?, ?)", [NOW, NOW])
    })
    expect(() => withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_other', attempt: 2, report: rep({ node_run_id: 'nr_other' }), expectedStatus: 'verifying', generation: 1, now: NOW }, POLICY))).toThrowError(/别的节点/)
    const other = db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='nr_other'").get() as { status: string }
    expect(other.status).toBe('verifying')
  })

  it('同一条已 applied 报告反复重发：report_replayed 只留一条', () => {
    const db = setup()
    apply(db)
    const afterFirst = Number(nodeRow(db).revision)
    apply(db)
    apply(db)
    expect(events(db, 'report_replayed')).toBe(1)
    expect(Number(nodeRow(db).revision)).toBe(afterFirst)
  })
})

describe('围栏与重放（审计 F-04 / F-05）', () => {
  const rejected = (db: any, id: string) => {
    db.raw.prepare("INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, 'nr_ar', 2, (SELECT COALESCE(MAX(report_seq),0)+1 FROM report_registry), 'rejected', ?, ?)").run(id, NOW, NOW)
  }

  it('围栏 armed 时上报一律 rejected，reason=fence_armed，节点不动', () => {
    const db = setup()
    db.raw.prepare("UPDATE node_runs SET status='timing_out', fence_state='armed', fence_grace_until='2026-11-13T03:00:30.000Z' WHERE node_run_id='nr_ar'").run()
    const out = apply(db, {}, 'timing_out')
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('fence_armed')
    expect(nodeRow(db).status).toBe('timing_out')
  })

  it('重放不是队头 → replay_not_head，保持 rejected', () => {
    const db = setup()
    rejected(db, 'rep_1')
    rejected(db, 'rep_2')
    const out = apply(db, { report_id: 'rep_2' })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('replay_not_head')
    expect(registry(db, 'rep_2').state).toBe('rejected')
  })

  it('重放队头 → applied，且只落一次', () => {
    const db = setup()
    rejected(db, 'rep_1')
    rejected(db, 'rep_2')
    const first = apply(db, { report_id: 'rep_1' })
    expect(first.accepted).toBe(true)
    expect(registry(db, 'rep_1').state).toBe('applied')
    expect(events(db, 'report_applied')).toBe(1)
    const again = apply(db, { report_id: 'rep_1' })
    expect(again.accepted).toBe(false)
    expect(again.registry_state).toBe('replayed')
    expect(events(db, 'report_applied')).toBe(1)
  })

  it('账本链断了 → replay_chain_broken，绝不重放', () => {
    const db = setup()
    rejected(db, 'rep_1')
    db.raw.prepare("UPDATE node_run_events SET payload = '{\"tampered\":true}' WHERE seq = (SELECT MIN(seq) FROM node_run_events)").run()
    const out = apply(db, { report_id: 'rep_1' })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('replay_chain_broken')
    expect(registry(db, 'rep_1').state).toBe('rejected')
  })

  it('同一条报告重复被拒只更新 registry，不再追加事件', () => {
    const db = setup()
    apply(db, {}, 'started')
    const n = events(db, 'report_rejected')
    apply(db, {}, 'started')
    expect(events(db, 'report_rejected')).toBe(n)
  })
})

describe('阻塞凭据：卡住必须挂 verify_human（审计 N-01）', () => {
  it('blocked_post 带请求理由 → 落 blocked_post 并留 verify_human 事件', () => {
    const db = setup()
    const out = apply(db, { status: 'blocked_post', output: { request: { reason: '证据不足', missing: ['artifact'] } } })
    expect(out.accepted).toBe(true)
    expect(out.next_status).toBe('blocked_post')
    expect(nodeRow(db).status).toBe('blocked_post')
    expect(events(db, 'verify_human')).toBe(1)
  })

  it('blocked_post 什么理由都没有 → rejected + decision_required，节点留在 verifying', () => {
    const db = setup()
    const out = apply(db, { status: 'blocked_post' })
    expect(out.accepted).toBe(false)
    expect(out.registry_state).toBe('rejected')
    expect(out.reason).toBe('decision_required')
    expect(nodeRow(db).status).toBe('verifying')
    expect(events(db, 'verify_human')).toBe(0)
  })

  it('blocked_post 只带 error_code → 凭据成立，卡住时留 verify_human', () => {
    const db = setup()
    const out = apply(db, { status: 'blocked_post', error_code: 'TOOL_FAILED' })
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('blocked_post')
    expect(events(db, 'verify_human')).toBe(1)
    const ev = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr_ar' AND type='verify_human'").get() as { payload: string }
    expect(JSON.parse(ev.payload).reason).toBe('TOOL_FAILED')
  })
})

describe('同一 report_id 的同类事件只留一条（审计 R3-04）', () => {
  it('成功落账后反复重投：report_replayed 只留一条，节点不二次迁移', () => {
    const db = setup()
    apply(db)
    const afterFirst = Number(nodeRow(db).revision)
    for (let i = 0; i < 3; i += 1) {
      const out = apply(db)
      expect(out.accepted).toBe(false)
    }
    expect(events(db, 'report_applied')).toBe(1)
    expect(events(db, 'report_replayed')).toBe(1)
    expect(Number(nodeRow(db).revision)).toBe(afterFirst)
  })

  it('反复重投同一条被拒的报告：事件与登记都不许膨胀', () => {
    const db = setup()
    for (let i = 0; i < 4; i += 1) {
      const out = apply(db, {}, 'dispatched')
      expect(out.accepted).toBe(false)
      expect(out.reason).toBe('status_mismatch')
    }
    expect(events(db, 'report_rejected')).toBe(1)
    expect(events(db, 'report_replayed')).toBe(1)
    expect(events(db, 'report_applied')).toBe(0)
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM report_registry WHERE report_id='rep_1'").get() as { n: number }
    expect(rows.n).toBe(1)
    expect(Number(registry(db).report_seq)).toBe(1)
    expect(nodeRow(db).status).toBe('verifying')
  })
})

describe('系统级证据门与痕迹绑定（审计 R3-03）', () => {
  it('伪造的 done：账本里没有工具执行痕迹 → evidence_unverifiable，节点不动', () => {
    const db = setup({ trace: false })
    const out = apply(db)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
    expect(events(db, 'report_applied')).toBe(0)
  })

  it('弱证据（模型侧 tool_result）→ verification_too_weak', () => {
    const db = setup()
    const out = apply(db, { evidence: { source: 'tool_result', exitCode: 0, stdoutHash: 'h', hashes: {} } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('工具 exitCode 不是 0 → tool_execution_failed', () => {
    const db = setup()
    const out = apply(db, { evidence: { source: 'run_tool', exitCode: 2, stdoutHash: 'h', hashes: {} } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('tool_execution_failed')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('痕迹里的 stdout_hash 对不上 → evidence_unverifiable', () => {
    const db = setup()
    const out = apply(db, { evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'other', hashes: {} } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })
})
