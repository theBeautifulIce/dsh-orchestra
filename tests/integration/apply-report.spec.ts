import { describe, expect, it } from 'vitest'
import { bindRunVersion, catalogFor, freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { createNodeRun } from '../../src/service/commands/nodes.ts'
import { applyReport, raiseReportContradiction } from '../../src/service/commands/apply-report.ts'
import { escalateDecisions } from '../../src/service/commands/decisions.ts'
import type { Report } from '../../src/core/report.ts'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const CATALOG = catalogFor(['n_ar', 'n_other'])
const CMD = 'c'.repeat(64)
// 工具执行的唯一身份：痕迹行、tool_finished 事件与报告回执都绑它
const EXEC_ID = 'tex_exec_0001'
const EXEC_SECOND = 'tex_exec_0002'
const ARTIFACT = { file: 'build/app.tar', size: 3 }
const ARTIFACT_HASH = sha256Hex(canonicalJson(ARTIFACT))

function setup(opts: { ttl?: number; now?: string; trace?: boolean; eventExecId?: string } = {}) {
  const { db } = freshLedger(); seed(db); bindRunVersion(db, CATALOG)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_ar', 'r1', 'n_ar', 5, 'agent', 2, 'queued', 10, ?, ?)", [NOW, NOW])
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_ar', ownerEpoch: 1, leaseTtlMs: opts.ttl ?? 600000, now: opts.now ?? NOW }))
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='verifying' WHERE node_run_id='nr_ar'"))
  // 工具执行痕迹：done 报告的证据要对得上这条痕迹，伪造的 done 才分得开（审计 R3-03）
  if (opts.trace !== false) {
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 1, 'ro.echo', ?, 0, 'h', NULL, ?, ?, ?)",
        [EXEC_ID, CMD, NOW, NOW],
      )
      appendNodeRunEvent(tx, TEST_SECRET, 'nr_ar', 'tool_finished', {
        tool: 'ro.echo', attempt: 2, tool_seq: 1, execution_id: opts.eventExecId ?? EXEC_ID,
        exit_code: 0, stdout_hash: 'h', stderr_hash: null, command_hash: CMD,
      })
    })
  }
  return db
}

// 报告里的工具执行回执：执行器把 execution_id 写进 output.evidence_trace，收口按它认哪一次执行
const traceEntry = (over: Record<string, unknown> = {}) => ({
  tool: 'ro.echo', toolSeq: 1, executionId: EXEC_ID, exitCode: 0, stdoutHash: 'h', stderrHash: null, commandHash: CMD, ...over,
})

const rep = (over: Partial<Report> = {}): Report => ({
  report_id: 'rep_1', node_run_id: 'nr_ar', attempt: 2, status: 'done',
  evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
  output: { evidence_trace: [traceEntry()] },
  ...over,
})

function apply(db: any, over: Partial<Report> = {}, expectedStatus = 'verifying', generation = 1, now = NOW, catalog = CATALOG) {
  return withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 2, report: rep(over), expectedStatus, generation, now }, catalog))
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
    const out = withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 1, report: rep(), expectedStatus: 'verifying', generation: 1, now: NOW }, CATALOG))
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
    const custom = catalogFor(['n_ar'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, custom)
    const out = apply(db, {}, 'verifying', 1, NOW, custom)
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
    const out = withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_ar', attempt: 2, report: rep({ attempt: 999 }), expectedStatus: 'verifying', generation: 1, now: NOW }, CATALOG))
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
    expect(() => withTx(db, (tx) => applyReport(tx, TEST_SECRET, { nodeRunId: 'nr_other', attempt: 2, report: rep({ node_run_id: 'nr_other' }), expectedStatus: 'verifying', generation: 1, now: NOW }, CATALOG))).toThrowError(/别的节点/)
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
    // 账本只追加（迁移 007）：篡改改成「多插一条内容对不上的事件」，链一样断
    withTx(db, (tx) => {
      const last = tx.get<{ seq: number; hash: string }>('SELECT seq, hash FROM node_run_events WHERE node_run_id = ? ORDER BY seq DESC LIMIT 1', ['nr_ar'])
      tx.run(
        'INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['nr_ar', Number(last?.seq ?? 0) + 1, 'tampered', last?.hash ?? '0'.repeat(64), 'f'.repeat(64), '{"tampered":true}', NOW],
      )
    })
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

  // 第三十四轮审计 P1-1：report_id 带引号时 JSON 会转义，按 JSON 文本拼模式的判重会失效
  it('report_id 带引号时重复上报仍判为 replayed，事件只落一条', () => {
    const db = setup()
    const quoted = 'rep_"quote'
    const first = apply(db, { report_id: quoted })
    expect(first.accepted).toBe(true)
    expect(events(db, 'report_applied')).toBe(1)
    const again = apply(db, { report_id: quoted })
    expect(again.accepted).toBe(false)
    expect(again.registry_state).toBe('replayed')
    expect(events(db, 'report_replayed')).toBe(1)
    expect(events(db, 'report_applied')).toBe(1)
  })

  it('report_id 带引号时重复被拒只落一条 report_rejected', () => {
    const db = setup()
    const quoted = 'rep_"rej'
    apply(db, { report_id: quoted }, 'started')
    const n = events(db, 'report_rejected')
    expect(n).toBe(1)
    apply(db, { report_id: quoted }, 'started')
    apply(db, { report_id: quoted }, 'started')
    expect(events(db, 'report_rejected')).toBe(1)
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

describe('跨重启定义绑定（第六轮审计 P1-1）', () => {
  it('run 绑定的定义哈希与当前目录不一致时拒绝收口', () => {
    const db = setup()
    withTx(db, (tx) => tx.run("UPDATE runs SET workflow_definition_hash = ? WHERE run_id = 'r1'", ['f'.repeat(64)]))
    expect(() => apply(db)).toThrowError(/工作流定义与当前版本不一致/)
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('run 没有绑定定义哈希时不许收口', () => {
    const db = setup()
    withTx(db, (tx) => tx.run("UPDATE runs SET workflow_definition_hash = NULL WHERE run_id = 'r1'"))
    expect(() => apply(db)).toThrowError(/没有绑定工作流定义哈希/)
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
    const out = apply(db, { evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'other', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('同一 attempt 已有失败工具行 → 整次尝试不许 done（S2 第二十三轮 P0-2）', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 2, 'ro.fail', ?, 2, 'bad', NULL, ?, ?, ?)",
        [EXEC_SECOND, CMD, NOW, NOW],
      )
    })
    const out = apply(db)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('tool_execution_failed')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('证据的 commandHash 与痕迹行对不上 → evidence_unverifiable（S2 第二十三轮 P0-4）', () => {
    const db = setup()
    const out = apply(db, {
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: 'f'.repeat(64) },
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('required_hashes 只给键名、值不是 sha256 → verification_too_weak（S2 第二十三轮 P0-4）', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: 'not-a-real-hash' }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('required_hashes 的 64 位伪造值不在服务端可核验集合 → verification_too_weak（S2 第二十四轮 P1-1）', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: 'a'.repeat(64) }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('required_hashes 的值等于 output 同名产物的哈希 → 正常收口（S2 第二十五轮 P1-1 阳性对照）', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      output: { artifact: ARTIFACT },
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: ARTIFACT_HASH }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('done')
  })

  it('required_hashes 填命令哈希冒充产物 → verification_too_weak', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      output: { artifact: ARTIFACT },
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: CMD }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
  })

  it('required_hashes 的键在 output 里不存在 → verification_too_weak', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      output: {},
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: ARTIFACT_HASH }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
  })

  it('两个 required key 不能共用同一个产物哈希 → verification_too_weak', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact', 'bundle'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      output: { artifact: ARTIFACT, bundle: { file: 'build/bundle.zip' } },
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: ARTIFACT_HASH, bundle: ARTIFACT_HASH }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
  })

  it('required_hashes 的产物为 null 时不能拿 sha256(null) 通过（S2 第二十六轮 P2-1）', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact'] })
    bindRunVersion(db, catalog)
    const out = apply(db, {
      output: { artifact: null },
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: sha256Hex(canonicalJson(null)) }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('verification_too_weak')
  })

  it('两个 required key 各自绑定独立产物 → 正常收口（S2 第二十六轮 P2-2 阳性对照）', () => {
    const db = setup()
    const catalog = catalogFor(['n_ar', 'n_other'], { requiredHashes: ['artifact', 'bundle'] })
    bindRunVersion(db, catalog)
    const bundle = { file: 'build/bundle.zip' }
    const out = apply(db, {
      output: { artifact: ARTIFACT, bundle },
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: { artifact: ARTIFACT_HASH, bundle: sha256Hex(canonicalJson(bundle)) }, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'verifying', 1, NOW, catalog)
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('done')
  })

  it('失败终态缺证据 → evidence_missing（S2 第二十三轮 P1-1）', () => {
    const db = setup()
    const out = apply(db, { status: 'failed', evidence: undefined })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_missing')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('失败终态的证据与轨迹退出码矛盾 → evidence_unverifiable（S2 第二十四轮 P1-2）', () => {
    const db = setup()
    const out = apply(db, {
      status: 'failed',
      evidence: { source: 'run_tool', exitCode: 2, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('失败终态没有工具痕迹 → evidence_unverifiable（S2 第二十四轮 P1-2）', () => {
    const db = setup({ trace: false })
    const out = apply(db, {
      status: 'failed',
      evidence: { source: 'run_tool', exitCode: 2, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('failed 只有成功行 → tool_execution_failed（S2 第二十五轮 P1-2）', () => {
    const db = setup()
    const out = apply(db, {
      status: 'failed',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('tool_execution_failed')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('failed 同 attempt 另有失败行时，不能拿成功行收口', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run(
        "UPDATE tool_executions SET exit_code = 2, stdout_hash = 'bad' WHERE node_run_id = 'nr_ar' AND attempt = 2 AND tool = 'ro.echo'",
      )
    })
    const out = apply(db, {
      status: 'failed',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('timeout 只有成功行 → tool_execution_failed（S2 第二十八轮 P2-1）', () => {
    const db = setup()
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status='timing_out', cancel_result='interrupted' WHERE node_run_id='nr_ar'"))
    const out = apply(db, {
      status: 'timeout',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'timing_out')
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('tool_execution_failed')
    expect(nodeRow(db).status).toBe('timing_out')
  })

  it('timeout 同 attempt 另有失败行时，也不能拿成功行收口', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='timing_out', cancel_result='interrupted' WHERE node_run_id='nr_ar'")
      tx.run(
        "UPDATE tool_executions SET exit_code = 2, stdout_hash = 'bad' WHERE node_run_id = 'nr_ar' AND attempt = 2 AND tool = 'ro.echo'",
      )
    })
    const out = apply(db, {
      status: 'timeout',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
    }, 'timing_out')
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('timing_out')
  })

  it('失败终态的失败行与 tool_finished 对齐 → 正常收口（S2 第二十四轮 P1-2 阳性对照）', () => {
    const db = setup({ trace: false })
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 1, 'ro.echo', ?, 2, 'bad', NULL, ?, ?, ?)",
        [EXEC_SECOND, CMD, NOW, NOW],
      )
      appendNodeRunEvent(tx, TEST_SECRET, 'nr_ar', 'tool_finished', {
        tool: 'ro.echo', attempt: 2, tool_seq: 1, execution_id: EXEC_SECOND, exit_code: 2, stdout_hash: 'bad', stderr_hash: null, command_hash: CMD,
      })
    })
    const out = apply(db, {
      status: 'failed',
      evidence: { source: 'run_tool', exitCode: 2, stdoutHash: 'bad', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD },
      output: { evidence_trace: [traceEntry({ toolSeq: 1, executionId: EXEC_SECOND, exitCode: 2, stdoutHash: 'bad' })] },
    })
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('failed')
  })
})

// 工具执行唯一身份（评审《第二次意见.md》P1：同一个工具不能在一次节点执行中重复执行）
describe('工具执行唯一身份（第二次意见 P1）', () => {
  it('报告带 execution_id：按它认到那一次工具执行，收口通过', () => {
    const db = setup()
    const out = apply(db)
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('done')
    const row = db.raw.prepare("SELECT execution_id, tool_seq FROM tool_executions WHERE node_run_id='nr_ar' AND attempt=2").get() as { execution_id: string; tool_seq: number }
    expect(row.execution_id).toBe(EXEC_ID)
    expect(Number(row.tool_seq)).toBe(1)
  })

  it('execution_id 被篡改 → evidence_unverifiable', () => {
    const db = setup()
    const out = apply(db, { output: { evidence_trace: [traceEntry({ executionId: 'tex_bogus' })] } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('回执里的 tool_seq 与痕迹行对不上 → evidence_unverifiable', () => {
    const db = setup()
    const out = apply(db, { output: { evidence_trace: [traceEntry({ toolSeq: 7 })] } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
  })

  it('回执里的哈希与证据对不上 → evidence_unverifiable', () => {
    const db = setup()
    const out = apply(db, { output: { evidence_trace: [traceEntry({ stdoutHash: 'other' })] } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
  })

  it('tool_finished 事件的 execution_id 与报告绑定不一致 → evidence_unverifiable', () => {
    const db = setup({ eventExecId: 'tex_other' })
    const out = apply(db)
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
    expect(nodeRow(db).status).toBe('verifying')
  })

  it('同一 attempt 两次同名工具：按第二次执行的 execution_id 收口，通过', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 2, 'ro.echo', ?, 0, 'h', NULL, ?, ?, ?)",
        [EXEC_SECOND, CMD, NOW, NOW],
      )
      appendNodeRunEvent(tx, TEST_SECRET, 'nr_ar', 'tool_finished', {
        tool: 'ro.echo', attempt: 2, tool_seq: 2, execution_id: EXEC_SECOND, exit_code: 0, stdout_hash: 'h', stderr_hash: null, command_hash: CMD,
      })
    })
    const out = apply(db, { output: { evidence_trace: [traceEntry({ toolSeq: 2, executionId: EXEC_SECOND })] } })
    expect(out.accepted).toBe(true)
    expect(nodeRow(db).status).toBe('done')
  })

  it('同名工具两次执行：绑到没有 tool_finished 留痕的那一次 → evidence_unverifiable', () => {
    const db = setup()
    withTx(db, (tx) => {
      tx.run(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_ar', 2, 2, 'ro.echo', ?, 0, 'h', NULL, ?, ?, ?)",
        [EXEC_SECOND, CMD, NOW, NOW],
      )
    })
    const out = apply(db, { output: { evidence_trace: [traceEntry({ toolSeq: 2, executionId: EXEC_SECOND })] } })
    expect(out.accepted).toBe(false)
    expect(out.reason).toBe('evidence_unverifiable')
  })
})

describe('applyReport 报告冲突与 uphold 收口', () => {
  function errorCode(fn: () => unknown): string | null {
    try { fn(); return null } catch (error) { return (error as { code?: string }).code ?? null }
  }
  function hang(db: any) {
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status='startup_unknown' WHERE node_run_id='nr_ar'"))
    return withTx(db, (tx) => raiseReportContradiction(tx, TEST_SECRET, {
      nodeRunId: 'nr_ar', attempt: 2, runId: 'r1', reportId: 'rep_conflict', now: NOW,
    }))
  }
  function applyUphold(db: any, decision: { decisionId: string; revision: number; resolution: 'uphold_report' | 'uphold_decision' }) {
    return withTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nr_ar', attempt: 2, report: rep({ report_id: 'rep_conflict' }),
      expectedStatus: 'startup_unknown', generation: 1, now: NOW, decision,
    }, CATALOG))
  }

  it('普通出口在挂起状态下报 STALE_HANG，节点与账本不动', () => {
    const db = setup()
    hang(db)
    const before = nodeRow(db)
    expect(errorCode(() => apply(db, { report_id: 'rep_conflict' }, 'startup_unknown'))).toBe('STALE_HANG')
    const after = nodeRow(db)
    expect(after.status).toBe('startup_unknown')
    expect(after.revision).toBe(before.revision)
    expect(events(db, 'report_applied')).toBe(0)
  })

  it('uphold_report：清 hang 与启动未知闸，节点落 done，裁决收口 approved', () => {
    const db = setup()
    const { decisionId } = hang(db)
    const card = db.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as any
    const out = applyUphold(db, { decisionId, revision: card.revision, resolution: 'uphold_report' })
    expect(out).toEqual({ accepted: true, next_status: 'done', registry_state: 'applied' })
    const row = nodeRow(db)
    expect(row.status).toBe('done')
    expect(row.hang_reason).toBeNull()
    expect(row.contradiction_decision_id).toBeNull()
    expect(row.startup_unknown_deadline_at).toBeNull()
    const closed = db.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as any
    expect(closed.status).toBe('resolved')
    expect(closed.closed_reason).toBe('approved')
  })

  it('uphold_decision：旧行 superseded，新 attempt queued 接班，迟到报告标 stale', () => {
    const db = setup()
    const { decisionId } = hang(db)
    const card = db.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as any
    const out = applyUphold(db, { decisionId, revision: card.revision, resolution: 'uphold_decision' })
    expect(out).toEqual({ accepted: false, reason: 'uphold_decision', next_status: 'superseded', registry_state: 'stale' })
    const old = nodeRow(db)
    expect(old.status).toBe('superseded')
    expect(old.replacement_node_run_id).toBeTruthy()
    const next = db.raw.prepare("SELECT * FROM node_runs WHERE origin_node_run_id='nr_ar'").get() as any
    expect(next.status).toBe('queued')
    expect(next.attempt).toBe(3)
    expect(registry(db, 'rep_conflict').state).toBe('stale')
    const closed = db.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as any
    expect(closed.closed_reason).toBe('uphold_decision')
  })

  it('裁决 revision 过期：DECISION_REVISION_CONFLICT，节点一个字节不动', () => {
    const db = setup()
    const { decisionId } = hang(db)
    const before = nodeRow(db)
    expect(errorCode(() => applyUphold(db, { decisionId, revision: 999, resolution: 'uphold_report' }))).toBe('DECISION_REVISION_CONFLICT')
    const after = nodeRow(db)
    expect(after.status).toBe(before.status)
    expect(after.revision).toBe(before.revision)
    expect(after.hang_reason).toBe('report_contradicted')
  })

  it('挂起状态不许开新 attempt：createNodeRun 报 STALE_HANG，子行不落库', () => {
    const db = setup()
    hang(db)
    const before = db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get() as { n: number }
    expect(errorCode(() => withTx(db, (tx) => createNodeRun(tx, {
      newNodeRunId: 'nr_ar_attempt3', runId: 'r1', nodeId: 'n_ar', seq: 5, nodeType: 'agent',
      attempt: 3, originNodeRunId: 'nr_ar', now: NOW,
    })))).toBe('STALE_HANG')
    const after = db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('报告冲突卡不参与按时间自动升级/过期', () => {
    const db = setup()
    const { decisionId } = hang(db)
    withTx(db, (tx) => escalateDecisions(tx, { now: '2026-11-20T00:00:00.000Z' }))
    const card = db.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as any
    expect(card.status).toBe('pending')
    expect(card.closed_reason).toBeNull()
  })
})