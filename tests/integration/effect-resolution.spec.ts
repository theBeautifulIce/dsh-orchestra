// tests/integration/effect-resolution.spec.ts —— 副作用结算的受控写入口与故障用例
// 真相源：docs/superpowers/specs/2026-11-17-s5-effect-resolution-addendum.md（§0–§13）
// 用例名与附录 §10 给定的英文名一字不差；每条都断言具体错误码。
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { OrchError } from '../../src/core/errors.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import {
  resolveEffect,
  type EffectResolveRequest,
  type EffectResolutionResult,
  type ResolutionBasis,
} from '../../src/service/commands/effects.ts'
import { openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { listUnverifiedEffects } from '../../src/service/queries/effects.ts'
import { verifyLedger } from '../../src/service/queries/verify_ledger.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const CMD = 'c'.repeat(64)
const EXEC_ID = 'tex_exec_effect_0001'
const EXEC_ID_2 = 'tex_exec_effect_0002'

type NodeOverrides = {
  status?: string
  attempt?: number
  policy?: 'pure' | 'compensable' | 'irreversible'
  revision?: number
  verifiedNone?: number
  stopEvidence?: string | null
}

function setup(over: NodeOverrides = {}): any {
  const { db } = freshLedger()
  seed(db)
  withTx(db, (tx) => {
    tx.run(
      'UPDATE node_runs SET status = ?, attempt = ?, revision = ?, side_effect_policy = ?, side_effect_verified_none = ?, stop_evidence = ? WHERE node_run_id = ?',
      [
        over.status ?? 'failed',
        over.attempt ?? 1,
        over.revision ?? 1,
        over.policy ?? 'irreversible',
        over.verifiedNone ?? 0,
        over.stopEvidence ?? null,
        'nr1',
      ],
    )
  })
  return db
}

/** 系统证据：tool_executions 行 + 同一 execution_id 的 tool_finished 节点事件（E1–E3） */
function addEvidence(db: any, over: {
  executionId?: string
  attempt?: number
  toolSeq?: number
  finishedAt?: string | null
  withEvent?: boolean
} = {}): void {
  const executionId = over.executionId ?? EXEC_ID
  const attempt = over.attempt ?? 1
  const toolSeq = over.toolSeq ?? 1
  const finishedAt = over.finishedAt === undefined ? NOW : over.finishedAt
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at)"
      + " VALUES ('nr1', ?, ?, 'ro.echo', ?, 0, 'h', NULL, ?, ?, ?)",
      [attempt, toolSeq, executionId, CMD, NOW, finishedAt],
    )
    if (over.withEvent !== false) {
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_finished', {
        tool: 'ro.echo',
        attempt,
        tool_seq: toolSeq,
        execution_id: executionId,
        exit_code: 0,
        stdout_hash: 'h',
        stderr_hash: null,
        command_hash: CMD,
        finished_at: finishedAt,
      })
    }
  })
}

/** 直接造一张已收口的 decision：状态与 payload 是结算判据要看的字段 */
function addDecision(db: any, over: {
  decisionId?: string
  kind?: string
  status?: string
  closedReason?: string | null
  decidedAt?: string | null
  payload?: Record<string, unknown>
  revision?: number
} = {}): string {
  const decisionId = over.decisionId ?? 'dec_eff_1'
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, closed_reason, payload_json, created_at, decided_at)"
      + " VALUES (?, 'r1', 'nr1', ?, ?, ?, ?, ?, ?, ?)",
      [
        decisionId,
        over.kind ?? 'verify_human',
        over.status ?? 'resolved',
        over.revision ?? 1,
        over.closedReason === undefined ? 'approved' : over.closedReason,
        JSON.stringify(over.payload ?? { effect_verdict: 'applied', evidence_ids: [EXEC_ID] }),
        NOW,
        over.decidedAt === undefined ? NOW : over.decidedAt,
      ],
    )
  })
  return decisionId
}

/** 节点事件链断在一条对不上的事件上（node_run_events 只追加，只能这样造坏账） */
function breakChain(db: any): void {
  withTx(db, (tx) => {
    const head = tx.get<{ last_seq: number; last_hash: string }>(
      'SELECT last_seq, last_hash FROM node_run_chain_heads WHERE node_run_id = ?',
      ['nr1'],
    )
    const seq = Number(head?.last_seq ?? 0) + 1
    // 事件只追加：接在链头之后，但哈希对不上（链头表没有触发器，账本校验会判断链）
    tx.run(
      "INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES ('nr1', ?, 'tool_finished', ?, ?, ?, ?)",
      [seq, head?.last_hash ?? '0'.repeat(64), 'f'.repeat(64), '{}', NOW],
    )
  })
}

function settle(db: any, over: Partial<EffectResolveRequest> & { basis: ResolutionBasis }): EffectResolutionResult {
  return withTx(db, (tx) => resolveEffect(tx, TEST_SECRET, {
    basis: over.basis,
    nodeRunId: over.nodeRunId ?? 'nr1',
    runId: over.runId ?? 'r1',
    evidenceId: over.evidenceId ?? null,
    decisionId: over.decisionId ?? null,
    stopEvidence: over.stopEvidence ?? null,
    expected: over.expected ?? { revision: 1 },
    operationId: over.operationId ?? uuidv7(),
    now: over.now ?? NOW,
    actor: over.actor ?? { kind: 'human', id: 'human:auditor' },
    evidenceSource: over.evidenceSource ?? null,
  }))
}

/** 结算中途失败可以是任何异常（撞唯一键的账本追加），这里只断言「确实失败了」 */
function expectFailure(fn: () => unknown): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeTruthy()
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(OrchError)
  expect((thrown as OrchError).code).toBe(code)
}

const resolutionRows = (db: any): any[] => db.raw.prepare('SELECT * FROM unverified_resolutions').all() as any[]
const nodeRow = (db: any): any => db.raw.prepare("SELECT * FROM node_runs WHERE node_run_id='nr1'").get() as any
const nodeEffectEvents = (db: any): number =>
  Number((db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type='effect.resolved'").get() as { n: number }).n)
const runEffectEvents = (db: any): number =>
  Number((db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE type='effect.resolved'").get() as { n: number }).n)

describe('副作用结算：证据门与作用域（附录 §2、§3、§6）', () => {
  it('rejects_unknown_evidence_id', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: 'tex_not_exist_0001' }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
  })

  it('rejects_stale_attempt_evidence', () => {
    const db = setup({ status: 'done', attempt: 2 })
    addEvidence(db, { attempt: 1 })
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_unfinished_execution', () => {
    const db = setup({ status: 'done' })
    addEvidence(db, { finishedAt: null })
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_missing_tool_finished_event', () => {
    const db = setup({ status: 'done' })
    addEvidence(db, { withEvent: false })
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'EVIDENCE_SOURCE_UNAVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_broken_event_chain', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    breakChain(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'EVIDENCE_SOURCE_UNAVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
  })

  it('rejects_weak_evidence', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID, evidenceSource: 'tool_result' }),
      'VERIFICATION_TOO_WEAK',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_pure_policy_node', () => {
    const db = setup({ status: 'done', policy: 'pure' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'SIDE_EFFECT_UNDECLARED',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_abandon_ack_as_basis', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addEvidence(db)
    addDecision(db, { kind: 'abandon_ack' })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_rejected_decision_as_basis', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addEvidence(db)
    addDecision(db, { closedReason: 'rejected' })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_unresolved_decision_as_basis', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addEvidence(db)
    addDecision(db, { status: 'pending', closedReason: null, decidedAt: null })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_decision_without_evidence', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addDecision(db, { payload: { effect_verdict: 'applied' } })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_attestation_as_evidence', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: 'att_human_attest_0001' }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_ineligible_node_status', () => {
    const db = setup({ status: 'running' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })
})

describe('副作用结算：幂等、冲突与版本（附录 §2.4、§4）', () => {
  it('conflicts_with_existing_resolution', () => {
    const db = setup({ status: 'done' })
    addEvidence(db, { executionId: EXEC_ID, toolSeq: 1 })
    addEvidence(db, { executionId: EXEC_ID_2, toolSeq: 2 })
    settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID_2 }),
      'EFFECT_RESOLUTION_CONFLICT',
    )
    expect(resolutionRows(db)).toHaveLength(1)
    expect(nodeEffectEvents(db)).toBe(1)
  })

  it('replays_same_resolution', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    const first = settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    expect(first.replayed).toBe(false)
    const second = settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    expect(second.replayed).toBe(true)
    expect(resolutionRows(db)).toHaveLength(1)
    expect(nodeEffectEvents(db)).toBe(1)
    expect(runEffectEvents(db)).toBe(1)
  })

  it('operation_id_conflict', () => {
    const db = setup({ status: 'done' })
    addEvidence(db, { executionId: EXEC_ID, toolSeq: 1 })
    addEvidence(db, { executionId: EXEC_ID_2, toolSeq: 2 })
    const operationId = uuidv7()
    settle(db, { basis: 'evidence', evidenceId: EXEC_ID, operationId })
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID_2, operationId }),
      'OPERATION_ID_CONFLICT',
    )
    expect(resolutionRows(db)).toHaveLength(1)
  })

  it('rejects_stale_node_revision', () => {
    const db = setup({ status: 'done', revision: 3 })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID, expected: { revision: 1 } }),
      'STALE_GENERATION',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('rejects_stale_decision_revision', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addEvidence(db)
    addDecision(db, { revision: 2 })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'DECISION_REVISION_CONFLICT',
    )
    expect(resolutionRows(db)).toHaveLength(0)
  })
})

describe('副作用结算：verified_none 分支与事务完整性（附录 §2.3、§4）', () => {
  it('verified_none_requires_identical_stop_evidence', () => {
    const db = setup({ status: 'failed', stopEvidence: 'no_tool_started:nr1:1:3' })
    expectCode(
      () => settle(db, { basis: 'verified_none', stopEvidence: 'no_tool_started:nr1:1:4' }),
      'RESOLUTION_NOT_AVAILABLE',
    )
    expect(nodeRow(db).stop_evidence).toBe('no_tool_started:nr1:1:3')
    expect(Number(nodeRow(db).side_effect_verified_none)).toBe(0)
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
  })

  it('rolls_back_partial_resolution', () => {
    const db = setup({ status: 'failed' })
    // 下一个事件序号已经被占掉：结算写完节点字段与结算行之后，追加 effect.resolved 事件会撞唯一键，
    // 整笔事务必须回滚，不留半成品。
    breakChain(db)
    const operationId = uuidv7()
    expectFailure(() => settle(db, { basis: 'verified_none', stopEvidence: 'no_tool_started:nr1:1:2', operationId }))
    expect(Number(nodeRow(db).side_effect_verified_none)).toBe(0)
    expect(nodeRow(db).stop_evidence).toBeNull()
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
    expect(runEffectEvents(db)).toBe(0)
    const inbox = db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE operation_id = ?').get(operationId) as { n: number }
    expect(Number(inbox.n)).toBe(0)
  })
})

describe('副作用结算：读模型、run 终态与账本（附录 §7）', () => {
  it('settlement_removes_from_unverified_list', () => {
    const db = setup({ status: 'failed' })
    const before = listUnverifiedEffects(db, { run_id: 'r1' })
    expect(before.items.map((item) => item.node_run_id)).toContain('nr1')
    settle(db, { basis: 'verified_none', stopEvidence: 'no_tool_started:nr1:1' })
    const after = listUnverifiedEffects(db, { run_id: 'r1' })
    expect(after.items.map((item) => item.node_run_id)).not.toContain('nr1')
  })

  it('当前 attempt 已启动工具时拒绝按未启动结算', () => {
    const db = setup({ status: 'failed' })
    withTx(db, (tx) => appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_started', { attempt: 1 }))
    expectCode(() => settle(db, { basis: 'verified_none', stopEvidence: 'no_tool_started:nr1:1' }), 'RESOLUTION_NOT_AVAILABLE')
    expect(resolutionRows(db)).toHaveLength(0)
    expect(listUnverifiedEffects(db, { run_id: 'r1' }).items.map((item) => item.node_run_id)).toContain('nr1')
  })

  it('仅提供停止证据字符串且账本无对应确认时拒绝结算', () => {
    const db = setup({ status: 'stopping' })
    expectCode(() => settle(db, { basis: 'verified_none', stopEvidence: 'stopped_confirmed:nr1:1' }), 'RESOLUTION_NOT_AVAILABLE')
    expect(resolutionRows(db)).toHaveLength(0)
  })

  it('run_close_treats_settled_node_as_verified', () => {
    const db = setup({ status: 'done', policy: 'compensable' })
    addEvidence(db)
    settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    const status = withTx(db, (tx) => closeRun(tx, TEST_SECRET, 'r1', NOW))
    expect(status).toBe('succeeded')
  })

  it('forbids_unauthorized_resolution', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    expectCode(
      () => settle(db, { basis: 'evidence', evidenceId: EXEC_ID, actor: { kind: 'agent', id: 'agent:worker' } }),
      'FORBIDDEN',
    )
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
  })

  it('ledger_chain_intact_after_resolution', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    const verified = verifyLedger(db, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.break).toBeNull()
    expect(verified.gaps).toEqual([])
  })

  it('appends_single_effect_resolved_event', () => {
    const db = setup({ status: 'done' })
    addEvidence(db)
    settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
    expect(nodeEffectEvents(db)).toBe(1)
    expect(runEffectEvents(db)).toBe(1)
    const row = resolutionRows(db)[0]
    expect(row.resolution_basis).toBe('evidence')
    expect(row.evidence_id).toBe(EXEC_ID)
    expect(row.decision_id).toBeNull()
  })

  it('human_not_applied_settles_verified_none', () => {
    const db = setup({ status: 'failed' })
    addEvidence(db)
    const decisionId = 'dec_eff_human'
    withTx(db, (tx) => openDecision(tx, {
      decisionId,
      runId: 'r1',
      nodeRunId: 'nr1',
      kind: 'verify_human',
      payload: {},
      createdAt: NOW,
    }))
    const out = withTx(db, (tx) => resolveDecision(tx, TEST_SECRET, {
      decisionId,
      revision: 1,
      resolution: 'approved',
      confirm: true,
      payload: { effect_verdict: 'not_applied', evidence_ids: [EXEC_ID] },
      actor: { kind: 'human', id: 'human:auditor' },
      now: NOW,
    }))
    expect(out.closedReason).toBe('approved')
    const row = resolutionRows(db)[0]
    expect(row.resolution_basis).toBe('verified_none')
    expect(row.stop_evidence).toBe(EXEC_ID)
    expect(row.evidence_id).toBeNull()
    expect(row.decision_id).toBeNull()
    expect(Number(nodeRow(db).side_effect_verified_none)).toBe(1)
    const ev = db.raw
      .prepare("SELECT payload FROM node_run_events WHERE node_run_id='nr1' AND type='effect.resolved'")
      .get() as { payload: string }
    expect(JSON.parse(ev.payload).decision_id).toBe(decisionId)
  })

  it('weak_evidence_cannot_settle', () => {
    const db = setup({ status: 'failed_with_unverified' })
    addEvidence(db)
    addDecision(db, {
      payload: { effect_verdict: 'applied', evidence_ids: [EXEC_ID], evidence_source: 'tool_result' },
    })
    expectCode(
      () => settle(db, { basis: 'decision', decisionId: 'dec_eff_1', expected: { revision: 1, decisionRevision: 1 } }),
      'VERIFICATION_TOO_WEAK',
    )
    expect(resolutionRows(db)).toHaveLength(0)
    expect(nodeEffectEvents(db)).toBe(0)
  })
})
