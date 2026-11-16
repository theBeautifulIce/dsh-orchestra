// 断链闸门的三个外部入口：上报、执行器迁移、run 收口（S3 r19 P1-1 / S2 r68 P1-1）
import { describe, expect, it } from 'vitest'
import { bindRunVersion, catalogFor, freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { applyReport } from '../../src/service/commands/apply-report.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { transitionNode } from '../../src/service/commands/node-state.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { wakeOnEvent } from '../../src/service/commands/wait.ts'
import { OrchError } from '../../src/core/errors.ts'
import type { Report } from '../../src/core/report.ts'

const NOW = '2026-11-16T06:00:00.000Z'
const CATALOG = catalogFor(['n_x'])

/** 打断哈希链：事件表只追加，只能卸触发器后改内容 */
function breakChain(db: Db, nodeRunId: string): void {
  withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, nodeRunId, 'started', { seed: true }))
  for (const t of ['trg_node_run_events_no_update', 'trg_node_run_events_chain_guard', 'trg_node_run_chain_heads_update_guard']) {
    db.raw.exec('DROP TRIGGER IF EXISTS ' + t)
  }
  db.raw.prepare("UPDATE node_run_events SET hash = 'tampered' WHERE node_run_id = ? AND seq = 1").run(nodeRunId)
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

function setupNode(db: Db, status: string): void {
  bindRunVersion(db, CATALOG)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_x', 'r1', 'n_x', 30, 'agent', 1, ?, 0, ?, ?)", [status, NOW, NOW])
  })
}

const CMD_HASH = 'c'.repeat(64)
const EXEC_ID = 'tex_exec_guard'

const report = (): Report => ({
  report_id: 'rep_x', node_run_id: 'nr_x', attempt: 1, status: 'done',
  evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'h', hashes: {}, producedAt: NOW, tool: 'ro.echo', commandHash: CMD_HASH },
  output: { evidence_trace: [{ tool: 'ro.echo', toolSeq: 1, executionId: EXEC_ID, exitCode: 0, stdoutHash: 'h', stderrHash: null, commandHash: CMD_HASH }] },
})

/** 与 apply-report.spec 一致的有效上报形态：先拿租约（此时链还完整），再伪造状态与工具痕迹 */
function setupVerifying(db: Db): void {
  bindRunVersion(db, CATALOG)
  withTx(db, (tx) => {
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_x', 'r1', 'n_x', 30, 'agent', 1, 'queued', 0, ?, ?)", [NOW, NOW])
  })
  withTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr_x', ownerEpoch: 1, leaseTtlMs: 600_000, now: NOW }))
  withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET status = 'verifying' WHERE node_run_id = 'nr_x'")
    tx.run(
      "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_x', 1, 1, 'ro.echo', ?, 0, 'h', NULL, ?, ?, ?)",
      [EXEC_ID, CMD_HASH, NOW, NOW],
    )
    appendNodeRunEvent(tx, TEST_SECRET, 'nr_x', 'tool_finished', {
      tool: 'ro.echo', attempt: 1, tool_seq: 1, execution_id: EXEC_ID,
      exit_code: 0, stdout_hash: 'h', stderr_hash: null, command_hash: CMD_HASH,
    })
  })
}

describe('断链节点的外部写入闸门', () => {
  it('上报主干：链断时拒绝，节点与链头都不变', () => {
    const { db } = freshLedger()
    seed(db)
    setupVerifying(db)
    breakChain(db, 'nr_x')
    const before = db.raw.prepare("SELECT status, revision FROM node_runs WHERE node_run_id = 'nr_x'").get() as { status: string; revision: number }
    const head = db.raw.prepare("SELECT last_seq, last_hash FROM node_run_chain_heads WHERE node_run_id = 'nr_x'").get() as { last_seq: number; last_hash: string }

    expect(codeOf(() => withTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nr_x', attempt: 1, report: report(), expectedStatus: 'verifying', generation: 1, now: NOW,
    }, CATALOG)))).toBe('FORBIDDEN')

    const after = db.raw.prepare("SELECT status, revision FROM node_runs WHERE node_run_id = 'nr_x'").get() as { status: string; revision: number }
    const headAfter = db.raw.prepare("SELECT last_seq, last_hash FROM node_run_chain_heads WHERE node_run_id = 'nr_x'").get() as { last_seq: number; last_hash: string }
    expect(after).toEqual(before)
    expect(headAfter).toEqual(head)
    db.raw.close()
  })

  it('执行器迁移入口 transitionNode：链断时同样拒绝', () => {
    const { db } = freshLedger()
    seed(db)
    setupNode(db, 'dispatched')
    breakChain(db, 'nr_x')
    expect(codeOf(() => withTx(db, (tx) => transitionNode(tx, TEST_SECRET, {
      nodeRunId: 'nr_x', from: 'dispatched', to: 'started', attempt: 1, revision: 0, now: NOW, reason: 'started',
    })))).toBe('FORBIDDEN')
    const row = db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_x'").get() as { status: string }
    expect(row.status).toBe('dispatched')
    db.raw.close()
  })

  it('run 收口：节点全终态但链断了，不写 run.terminal', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status = 'done', side_effect_verified_none = 1 WHERE node_run_id = 'nr1'"))
    breakChain(db, 'nr1')
    expect(withTx(db, (tx) => closeRun(tx, TEST_SECRET, 'r1', NOW))).toBeNull()
    const run = db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r1'").get() as { status: string }
    expect(run.status).toBe('running')
    const terminal = db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'run.terminal'").get() as { n: number }
    expect(Number(terminal.n)).toBe(0)
    db.raw.close()
  })

  it('等待唤醒：断链 wait 节点不被推进，run 也不收口', () => {
    const { db } = freshLedger()
    seed(db)
    withTx(db, (tx) => {
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nr_w', 'r1', 'n_w', 31, 'agent', 1, 'waiting', 0, ?, ?)", [NOW, NOW])
      tx.run(
        "INSERT INTO wait_registrations (node_run_id, run_id, wait_kind, match_json, from_seq, cursor_seq, idempotency_key, state, created_at, updated_at) "
        + "VALUES ('nr_w', 'r1', 'event', ?, 0, 0, 'r1:n_w:1', 'active', ?, ?)",
        [JSON.stringify({ type: 'done_evt' }), NOW, NOW],
      )
    })
    breakChain(db, 'nr_w')
    expect(codeOf(() => withTx(db, (tx) => wakeOnEvent(tx, TEST_SECRET, {
      runId: 'r1', eventType: 'done_evt', payload: {}, now: NOW,
    })))).toBe('FORBIDDEN')
    const node = db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id = 'nr_w'").get() as { status: string }
    expect(node.status).toBe('waiting')
    const run = db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r1'").get() as { status: string }
    expect(run.status).toBe('running')
    db.raw.close()
  })
})
