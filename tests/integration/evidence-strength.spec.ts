import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../../src/core/errors.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { getEvidenceSnapshot } from '../../src/service/queries/evidence.ts'

const SECRET = 'evidence-secret'
const NOW = '2026-11-17T10:00:00.000Z'
const STARTED_AT = '2026-11-17T09:00:00.000Z'
const FINISHED_AT = '2026-11-17T09:00:05.000Z'
const EXECUTION_ID = 'tex_evidence_1'

const dirs: string[] = []
const closers: { close: () => void }[] = []

afterEach(() => {
  for (const db of closers.splice(0)) {
    try { db.close() } catch { /* 已经关过 */ }
  }
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ }
  }
})

function ledger(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'orch-evidence-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}

/** 账本里那条 tool_finished 事件：字段与 tool_executions 行完全一致。 */
function matchingPayload(): Record<string, unknown> {
  return {
    tool: 'shell',
    attempt: 1,
    tool_seq: 1,
    execution_id: EXECUTION_ID,
    call_id: 'call_1',
    exit_code: 0,
    stdout_hash: 'out_hash',
    stderr_hash: 'err_hash',
    command_hash: 'cmd_hash',
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    duration_ns: 5000000,
  }
}

/**
 * 造一条工具执行记录。
 * eventPayload 为 undefined 时写入与记录完全一致的事件；给 null 表示根本没有 tool_finished 事件。
 */
function seedToolExecution(db: Db, eventPayload?: Record<string, unknown> | null): void {
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, workflow_id, workflow_version, status, display_status, current_run_id, revision, created_at, updated_at)"
      + " VALUES ('t1', '证据任务', 'wf1', 1, 'running', 'running', 'r1', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at)"
      + " VALUES ('r1', 't1', 'wf1', 1, 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at)"
      + " VALUES ('nr1', 'r1', 'n1', 1, 'agent', 1, 'done', 1, 'compensable', ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at)"
      + " VALUES ('nr1', 1, 1, 'shell', ?, 0, 'out_hash', 'err_hash', 'cmd_hash', ?, ?)",
      [EXECUTION_ID, STARTED_AT, FINISHED_AT])
    const payload = eventPayload === undefined ? matchingPayload() : eventPayload
    if (payload !== null) appendNodeRunEvent(tx, SECRET, 'nr1', 'tool_finished', payload)
  })
}

function evidenceError(db: Db, evidenceId: string): { code: string; reason: string; evidenceId: string } {
  try {
    getEvidenceSnapshot(db, SECRET, evidenceId)
  } catch (err) {
    if (err instanceof OrchError) {
      return {
        code: err.code,
        reason: String(err.details.reason),
        evidenceId: String(err.details.evidence_id),
      }
    }
    throw err
  }
  throw new Error('本来该拒绝这条证据，却读成功了')
}

describe('系统证据的强度判定', () => {
  it('事件链完整且字段一致：证据可读且强度是 strong', () => {
    const db = ledger()
    seedToolExecution(db)

    const snapshot = getEvidenceSnapshot(db, SECRET, EXECUTION_ID)
    expect(snapshot.item.strength).toBe('strong')
    expect(snapshot.item.source).toBe('run_tool')
    expect(snapshot.item.evidence_id).toBe(EXECUTION_ID)
    expect(snapshot.item.node_run_id).toBe('nr1')
    expect(snapshot.item.run_id).toBe('r1')
    expect(snapshot.item.attempt).toBe(1)
    expect(snapshot.item.tool).toBe('shell')
    expect(snapshot.item.exit_code).toBe(0)
    expect(snapshot.item.stdout_hash).toBe('out_hash')
    expect(snapshot.item.stderr_hash).toBe('err_hash')
    expect(snapshot.item.command_hash).toBe('cmd_hash')
    expect(snapshot.item.observed_at).toBe(FINISHED_AT)
    expect(snapshot.item.artifact_id).toBeNull()
    expect(snapshot.item.summary).toContain('exit_code=0')
  })

  it('没有 tool_finished 事件：拿不到 strong，理由是没找到对应事件', () => {
    const db = ledger()
    seedToolExecution(db, null)

    const err = evidenceError(db, EXECUTION_ID)
    expect(err.code).toBe('EVIDENCE_SOURCE_UNAVAILABLE')
    expect(err.reason).toBe('tool execution has no matching tool_finished event')
    expect(err.evidenceId).toBe(EXECUTION_ID)
  })

  it('事件链被改坏：拿不到 strong，理由是事件链无效', () => {
    const db = ledger()
    seedToolExecution(db)
    // 既有测试的先例：临时卸掉不可变触发器，改掉事件内容，让链哈希对不上。
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_update')
    withTx(db, (tx) => {
      tx.run("UPDATE node_run_events SET payload = ? WHERE node_run_id = 'nr1' AND seq = 1",
        [JSON.stringify({ tool: 'shell', execution_id: EXECUTION_ID })])
    })

    const err = evidenceError(db, EXECUTION_ID)
    expect(err.code).toBe('EVIDENCE_SOURCE_UNAVAILABLE')
    expect(err.reason).toBe('node run event chain is invalid')
    expect(err.evidenceId).toBe(EXECUTION_ID)
  })

  it('记录字段与账本事件不一致：拿不到 strong，理由是两边对不上', () => {
    const db = ledger()
    const mismatched = matchingPayload()
    mismatched.exit_code = 1
    seedToolExecution(db, mismatched)

    const err = evidenceError(db, EXECUTION_ID)
    expect(err.code).toBe('EVIDENCE_SOURCE_UNAVAILABLE')
    expect(err.reason).toBe('tool execution row differs from its ledger event')
    expect(err.evidenceId).toBe(EXECUTION_ID)
  })

  it('证据记录不存在：报找不到，不是证据不可用', () => {
    const db = ledger()
    seedToolExecution(db)

    try {
      getEvidenceSnapshot(db, SECRET, 'tex_missing')
      throw new Error('本来该报找不到，却读成功了')
    } catch (err) {
      expect(err).toBeInstanceOf(OrchError)
      const orch = err as OrchError
      expect(orch.code).toBe('NOT_FOUND')
    }
  })
})
