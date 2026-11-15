import { describe, expect, it } from 'vitest'
import { applyReport } from '../../src/service/commands/apply-report.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { assertDefinitionAllowed } from '../../src/core/workflow-def.ts'
import { MonotonicClock } from '../../src/core/clock.ts'
import { transitionNode } from '../../src/service/commands/node-state.ts'
import { inTx } from '../../src/infra/db/tx.ts'
import { bindRunVersion, catalogFor, freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import type { Db } from '../../src/infra/sqlite/driver.ts'
import { TEST_CLOCK } from '../fixtures/clock.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const CMD_HASH = 'c'.repeat(64)

function seedQueued(db: Db, nodeRunId: string): void {
  inTx(db, (tx) => {
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nodeRunId, 'r1', 'node_a', 1, 'agent', 1, 'queued', 0, 0, 0, NOW, NOW],
    )
  })
}

function lease(db: Db, nodeRunId: string): void {
  inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId, ownerEpoch: 1, leaseTtlMs: 30000, now: NOW }))
}

function rowOf(db: Db, nodeRunId: string): Record<string, any> {
  return db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as Record<string, any>
}

function countOf(db: Db, sql: string, params: any[]): number {
  return Number((db.raw.prepare(sql).get(...(params as any[])) as { n: number }).n)
}

function goodReport(nodeRunId: string, reportId: string, status: string) {
  return {
    report_id: reportId,
    node_run_id: nodeRunId,
    attempt: 1,
    status,
    evidence: { source: 'run_tool' as const, exitCode: 0, stdoutHash: HASH_A, stderrHash: HASH_B, hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD_HASH },
  }
}

const CATALOG = catalogFor(['node_a'])

// M5：判定条件从 run 绑定的工作流版本取，每个用例先把 run 绑上版本
function seedV(db: Db): void { seed(db); bindRunVersion(db, CATALOG) }

describe('G2 门必过项', () => {
  it('单节点 queued 到终态一条路径', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_01')
    lease(db, 'nrun_g2_01')
    // 工具执行痕迹：done 报告的证据要对得上它（审计 R3-03）
    inTx(db, (tx) => {
      tx.run("INSERT INTO tool_executions (node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nrun_g2_01', 1, 'ro.echo', 0, ?, ?, ?, ?, ?)", [HASH_A, HASH_B, CMD_HASH, NOW, NOW])
      appendNodeRunEvent(tx, TEST_SECRET, 'nrun_g2_01', 'tool_finished', {
        tool: 'ro.echo', attempt: 1, exit_code: 0, stdout_hash: HASH_A, stderr_hash: HASH_B, command_hash: CMD_HASH,
      })
    })
    let expected = 'dispatched'
    for (const target of ['started', 'verifying', 'done']) {
      const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_01', attempt: 1, expectedStatus: expected, generation: 1, now: NOW,
        report: goodReport('nrun_g2_01', 'rpt_g2_01_' + target, target),
      }, CATALOG))
      expect(res.registry_state).toBe('applied')
      expected = target
    }
    expect(rowOf(db, 'nrun_g2_01').status).toBe('done')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'report_applied'", ['nrun_g2_01'])).toBe(3)
  })

  it('重复上报只落一次', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_02'); lease(db, 'nrun_g2_02')
    const report = goodReport('nrun_g2_02', 'rpt_g2_02', 'started')
    const args = { nodeRunId: 'nrun_g2_02', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW } as const
    expect(inTx(db, (tx) => applyReport(tx, TEST_SECRET, { ...args, report }, CATALOG)).accepted).toBe(true)
    const second = inTx(db, (tx) => applyReport(tx, TEST_SECRET, { ...args, report }, CATALOG))
    expect(second.accepted).toBe(false)
    expect(second.registry_state).toBe('replayed')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'report_applied'", ['nrun_g2_02'])).toBe(1)
  })

  it('租约过期迟到上报被拒', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_03'); lease(db, 'nrun_g2_03')
    db.raw.prepare("UPDATE node_runs SET lease_expires_at = '2026-11-11T00:00:00.000Z' WHERE node_run_id = 'nrun_g2_03'").run()
    let code = ''
    try {
      inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_03', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
        report: goodReport('nrun_g2_03', 'rpt_g2_03', 'started'),
      }, CATALOG))
    } catch (err) { code = (err as { code?: string }).code ?? '' }
    expect(code).toBe('LEASE_EXPIRED')
    expect(rowOf(db, 'nrun_g2_03').status).toBe('dispatched')
  })

  it('取消后不产生新 attempt', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_04'); lease(db, 'nrun_g2_04')
    const revision = Number(rowOf(db, 'nrun_g2_04').revision)
    const outcome = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, { clock: TEST_CLOCK,
      nodeRunId: 'nrun_g2_04', attempt: 1, revision, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    expect(outcome.next_status).toBe('timing_out')
    expect(rowOf(db, 'nrun_g2_04').attempt).toBe(1)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = ? AND attempt > ?', ['nrun_g2_04', 1])).toBe(0)
  })

  it('终态必带证据：走到 verifying 再报 done，没证据就拒在证据门', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_05'); lease(db, 'nrun_g2_05')
    // 先从 dispatched 走到 verifying：只有站在 verifying 上，done 才真的走到证据门
    let expected = 'dispatched'
    for (const target of ['started', 'verifying']) {
      const step = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_05', attempt: 1, expectedStatus: expected, generation: 1, now: NOW,
        report: goodReport('nrun_g2_05', 'rpt_g2_05_' + target, target),
      }, CATALOG))
      expect(step.registry_state).toBe('applied')
      expected = target
    }
    expect(rowOf(db, 'nrun_g2_05').status).toBe('verifying')
    const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_05', attempt: 1, expectedStatus: 'verifying', generation: 1, now: NOW,
      report: { report_id: 'rpt_g2_05_done', node_run_id: 'nrun_g2_05', attempt: 1, status: 'done' },
    }, CATALOG))
    expect(res.accepted).toBe(false)
    expect(res.registry_state).toBe('rejected')
    expect(res.reason).toBe('evidence_missing')
    expect(rowOf(db, 'nrun_g2_05').status).toBe('verifying')
  })

  it('无裸 blocked：没凭据的阻塞上报被拒，节点状态不动', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_06'); lease(db, 'nrun_g2_06')
    inTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_06', from: 'dispatched', to: 'started', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_06').revision), now: NOW, reason: 'executor_started' }))
    const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_06', attempt: 1, expectedStatus: 'started', generation: 1, now: NOW,
      report: { report_id: 'rpt_g2_06', node_run_id: 'nrun_g2_06', attempt: 1, status: 'blocked_post' },
    }, CATALOG))
    expect(res.accepted).toBe(false)
    expect(res.registry_state).toBe('rejected')
    expect(res.reason).toBe('decision_required')
    expect(rowOf(db, 'nrun_g2_06').status).toBe('started')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'verify_human'", ['nrun_g2_06'])).toBe(0)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_runs WHERE status = ?', ['blocked'])).toBe(0)
    const unknown = countOf(db, "SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id LIKE 'nrun_%' AND status NOT IN ('queued','leased','dispatched','started','waiting','verifying','timing_out','stopping','startup_unknown','paused_bridge_missing','blocked_pre','blocked_post','indeterminate_side_effect','done','failed','timeout','abandoned_unverified','failed_with_unverified','orphaned','superseded')", [])
    expect(unknown).toBe(0)
  })

  it('带凭据的阻塞才算数：blocked_post 必须挂 verify_human 事件', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_06b'); lease(db, 'nrun_g2_06b')
    inTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_06b', from: 'dispatched', to: 'started', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_06b').revision), now: NOW, reason: 'executor_started' }))
    const res = inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g2_06b', attempt: 1, expectedStatus: 'started', generation: 1, now: NOW,
      report: { report_id: 'rpt_g2_06b', node_run_id: 'nrun_g2_06b', attempt: 1, status: 'blocked_post', output: { request: { reason: '证据不足', missing: ['artifact'] } } },
    }, CATALOG))
    expect(res.accepted).toBe(true)
    expect(rowOf(db, 'nrun_g2_06b').status).toBe('blocked_post')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'verify_human'", ['nrun_g2_06b'])).toBe(1)
    // 不变量：账本里每个 blocked_post 节点都挂着 verify_human 凭据
    const blocked = db.raw.prepare("SELECT node_run_id FROM node_runs WHERE status = 'blocked_post'").all() as { node_run_id: string }[]
    expect(blocked.length).toBeGreaterThan(0)
    for (const row of blocked) {
      expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'verify_human'", [row.node_run_id])).toBe(1)
    }
  })

  it('S2 加载 parallel 被拒', () => {
    let code = ''
    try {
      assertDefinitionAllowed({ workflow_version: 'v1', nodes: [{ node_id: 'n1', type: 'parallel' }] }, 'S2')
    } catch (err) { code = (err as { code?: string }).code ?? '' }
    expect(code).toBe('FORBIDDEN')
  })

  it('G-03 同一个 report_id 上报两次只落一次', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_07'); lease(db, 'nrun_g2_07')
    const report = goodReport('nrun_g2_07', 'rpt_g2_07', 'started')
    const args = { nodeRunId: 'nrun_g2_07', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW } as const
    for (let i = 0; i < 2; i += 1) inTx(db, (tx) => applyReport(tx, TEST_SECRET, { ...args, report }, CATALOG))
    expect((db.raw.prepare("SELECT state FROM report_registry WHERE report_id = 'rpt_g2_07'").get() as { state: string }).state).toBe('replayed')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'report_applied'", ['nrun_g2_07'])).toBe(1)
  })

  it('G-04 租约到期后原执行器迟到上报被拒', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_08'); lease(db, 'nrun_g2_08')
    db.raw.prepare("UPDATE node_runs SET lease_expires_at = '2026-11-11T00:00:00.000Z' WHERE node_run_id = 'nrun_g2_08'").run()
    let code = ''
    try {
      inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
        nodeRunId: 'nrun_g2_08', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: NOW,
        report: goodReport('nrun_g2_08', 'rpt_g2_08', 'started'),
      }, CATALOG))
    } catch (err) { code = (err as { code?: string }).code ?? '' }
    expect(code).toBe('LEASE_EXPIRED')
    expect(rowOf(db, 'nrun_g2_08').status).toBe('dispatched')
  })

  it('G-05 工具执行中取消只立一次围栏', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_09'); lease(db, 'nrun_g2_09')
    const revision = Number(rowOf(db, 'nrun_g2_09').revision)
    const outcome = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, { clock: TEST_CLOCK,
      nodeRunId: 'nrun_g2_09', attempt: 1, revision, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    expect(outcome.fence_state).toBe('armed')
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = 'fence_armed'", ['nrun_g2_09'])).toBe(1)
    expect(countOf(db, "SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = ? AND status IN ('done','failed','timeout')", ['nrun_g2_09'])).toBe(0)
  })

  it('G-07 墙钟跳十分钟不误判截止', () => {
    const clock = new MonotonicClock('boot_a', { wallClockMs: 1000, monotonicNs: 0 })
    clock.sample(1000 + 600000, 1000)
    const decision = clock.decide(
      { bootId: 'boot_a', monotonicNs: 60e9, wallClockMs: 1000 + 60000 },
      { bootId: 'boot_a', monotonicNs: 10e9, wallClockMs: 1000 + 600000 + 10000 },
    )
    expect(decision.kind).toBe('uncertain')
    expect(decision.kind === 'uncertain' ? decision.reason : '').toBe('clock_drift')
  })

  it('G2-06 阻塞必须挂裁决卡：没卡不许卡住，有卡才落 blocked_post', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_10'); lease(db, 'nrun_g2_10')
    inTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_10', from: 'dispatched', to: 'started', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_10').revision), now: NOW, reason: 'executor_started' }))
    let code = ''
    try {
      inTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_10', from: 'started', to: 'blocked_post', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_10').revision), now: NOW, reason: 'need_human' }))
    } catch (err) { code = (err as { code?: string }).code ?? '' }
    expect(code).toBe('DECISION_REQUIRED')
    expect(rowOf(db, 'nrun_g2_10').status).toBe('started')
    inTx(db, (tx) => transitionNode(tx, TEST_SECRET, { nodeRunId: 'nrun_g2_10', from: 'started', to: 'blocked_post', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_10').revision), now: NOW, reason: 'need_human', decisionId: 'dec_g2_10' }))
    expect(rowOf(db, 'nrun_g2_10').status).toBe('blocked_post')
    const payload = JSON.parse((db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id = 'nrun_g2_10' AND type = 'status_changed' ORDER BY seq DESC LIMIT 1").get() as { payload: string }).payload)
    expect(payload.decision_id).toBe('dec_g2_10')
  })

  it('G2-04 已完节点取消不动状态、不产生新 attempt', () => {
    const { db } = freshLedger(); seedV(db)
    seedQueued(db, 'nrun_g2_11'); lease(db, 'nrun_g2_11')
    db.raw.prepare("UPDATE node_runs SET status = 'done', revision = revision + 1 WHERE node_run_id = 'nrun_g2_11'").run()
    const outcome = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, { clock: TEST_CLOCK,
      nodeRunId: 'nrun_g2_11', attempt: 1, revision: Number(rowOf(db, 'nrun_g2_11').revision), cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    expect(outcome.next_status).toBe('done')
    const row = rowOf(db, 'nrun_g2_11')
    expect(row.status).toBe('done')
    expect(row.attempt).toBe(1)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM node_runs WHERE node_run_id = ?', ['nrun_g2_11'])).toBe(1)
  })
})