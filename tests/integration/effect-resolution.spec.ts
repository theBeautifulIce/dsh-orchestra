// tests/integration/effect-resolution.spec.ts —— 副作用结算的受控写入口与故障用例
// 真相源：docs/superpowers/specs/2026-11-17-s5-effect-resolution-addendum.md（§0–§13）
// 用例名与附录 §10 给定的英文名一字不差；每条都断言具体错误码。
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { OrchError } from '../../src/core/errors.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import { ReadOnlyToolRunner, ToolRegistry, type EffectVerdict } from '../../src/executor/tools.ts'
import {
  resolveEffect,
  inspectEffectEvidence,
  type EffectResolveRequest,
  type EffectResolutionResult,
  type ResolutionBasis,
} from '../../src/service/commands/effects.ts'
import { openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { listUnverifiedEffects } from '../../src/service/queries/effects.ts'
import { getNodeSnapshot } from '../../src/service/queries/nodes.ts'
import { getEvidenceSnapshot } from '../../src/service/queries/evidence.ts'
import { getAttestationSnapshot } from '../../src/service/queries/attestations.ts'
import { confirmStartup } from '../../src/service/commands/confirm-start.ts'
import { createWorkflow, publishDraft, publishContextFor } from '../../src/service/commands/workflows.ts'
import { verifyLedger } from '../../src/service/queries/verify_ledger.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const CMD = 'c'.repeat(64)
const EXEC_ID = 'tex_exec_effect_0001'
const EXEC_ID_2 = 'tex_exec_effect_0002'
const WORKFLOW_HASH = 'a'.repeat(64)

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
    tx.run('UPDATE runs SET workflow_definition_hash = ? WHERE run_id = ?', [WORKFLOW_HASH, 'r1'])
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
  verdict?: EffectVerdict | null
  exitCode?: number
  proofRunId?: string
} = {}): void {
  const executionId = over.executionId ?? EXEC_ID
  const attempt = over.attempt ?? 1
  const toolSeq = over.toolSeq ?? 1
  const finishedAt = over.finishedAt === undefined ? NOW : over.finishedAt
  const exitCode = over.exitCode ?? 0
  withTx(db, (tx) => {
    tx.run(
      "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at)"
      + " VALUES ('nr1', ?, ?, 'ro.echo', ?, ?, 'h', NULL, ?, ?, ?)",
      [attempt, toolSeq, executionId, exitCode, CMD, NOW, finishedAt],
    )
    if (over.withEvent !== false) {
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_finished', {
        tool: 'ro.echo',
        attempt,
        tool_seq: toolSeq,
        execution_id: executionId,
        exit_code: exitCode,
        stdout_hash: 'h',
        stderr_hash: null,
        command_hash: CMD,
        finished_at: finishedAt,
        ...(over.verdict === null ? {} : { effect_proof: {
          workflow_definition_hash: WORKFLOW_HASH, node_id: 'n1', node_run_id: 'nr1', run_id: over.proofRunId ?? 'r1', attempt,
          verifier_id: 'read-transaction/v1', verdict: over.verdict ?? 'applied', reference_hash: 'b'.repeat(64),
        } }),
      })
    }
  })
}

it('只把可用于结算的当前尝试证据提供给面板', () => {
  const db = setup({ status: 'done' })
  addEvidence(db)
  addEvidence(db, { executionId: EXEC_ID_2, toolSeq: 2, withEvent: false })
  expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item).toMatchObject({
    revision: 1, evidence: [{ evidence_id: EXEC_ID, tool: 'ro.echo' }],
  })
  settle(db, { basis: 'evidence', evidenceId: EXEC_ID })
  expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item.evidence).toEqual([])
})

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
    addEvidence(db, { verdict: 'not_applied' })
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

it('拒绝非零退出、无业务结论及错误动作实例，人工裁决也不能用自报结论结算', () => {
  const db = setup({ status: 'failed_with_unverified' })
  addEvidence(db, { verdict: null })
  addEvidence(db, { executionId: EXEC_ID_2, toolSeq: 2, exitCode: 1 })
  addEvidence(db, { executionId: 'tex_wrong', toolSeq: 3, proofRunId: 'another-run' })
  const notApplied = 'tex_not_applied'
  addEvidence(db, { executionId: notApplied, toolSeq: 4, verdict: 'not_applied' })
  expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item.evidence).toMatchObject([{ evidence_id: notApplied, verdict: 'not_applied' }])
  for (const evidenceId of [EXEC_ID, EXEC_ID_2, 'tex_wrong', notApplied]) {
    expectCode(() => settle(db, { basis: 'evidence', evidenceId }), 'RESOLUTION_NOT_AVAILABLE')
  }
  const decisionId = addDecision(db, { payload: { effect_verdict: 'applied', evidence_ids: [notApplied] } })
  expectCode(() => settle(db, { basis: 'decision', decisionId, expected: { revision: 1, decisionRevision: 1 } }), 'RESOLUTION_NOT_AVAILABLE')
  expect(resolutionRows(db)).toHaveLength(0)
  expect(listUnverifiedEffects(db).items).toHaveLength(1)
  expect(settle(db, { basis: 'verified_none', stopEvidence: notApplied })).toMatchObject({ resolution_basis: 'verified_none' })
})

it('宿主只能从固定动作的真实成功输出为当前尝试签发业务证据', async () => {
  const db = setup({ status: 'failed_with_unverified' })
  try {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read-transaction', capability: 'read_only', command: { bin: 'check-reference', args: ['--lookup'] },
      effectVerifier: {
        id: 'transaction-receipt/v1', workflowDefinitionHash: WORKFLOW_HASH, nodeId: 'n1',
        verify: (target, { stdout }) => {
          const record = JSON.parse(stdout) as { reference: string; state: string }
          const reference = `${target.run_id}/${target.node_run_id}/${target.attempt}`
          return record.reference === reference && record.state === 'committed' ? { verdict: 'applied', reference } : null
        },
      },
    })
    let reference = 'r1/other-node/1'
    let exitCode = 0
    const runner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      async run({ bin, args }) {
        expect([bin, ...args]).toEqual(['check-reference', '--lookup'])
        return { exitCode, stdout: JSON.stringify({ reference, state: 'committed' }), stderr: '' }
      },
    }, '.')
    const collector = new EvidenceCollector({ db, secret: TEST_SECRET, registry, runner, policy: { allow: ['read-transaction'] },
      allowedTools: ['read-transaction'], nodeRunId: 'nr1', attempt: 1, executorAgentId: 'verifier-host', nowAt: () => NOW })
    const collect = (callId: string, cwd = '.') => collector.collect({ callId, tool: 'read-transaction', args: ['--untrusted'], cwd, timeoutMs: 100 })
    await collect('foreign')
    reference = 'r1/nr1/1'
    await collect('other-cwd', './other')
    exitCode = 3
    await collect('failed')
    expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item.evidence).toEqual([])
    exitCode = 0
    const receipt = await collect('matched')
    const evidenceId = receipt.trace!.executionId
    expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item.evidence).toMatchObject([{ evidence_id: evidenceId, verdict: 'applied' }])
    expect(settle(db, { basis: 'evidence', evidenceId })).toMatchObject({ resolution_basis: 'evidence', evidence_id: evidenceId })
  } finally {
    db.raw.close()
  }
})

it('Q-08 / Q-30 投影关联版本的外部操作声明、既有结算及决定，并保留证据缺失事实', () => {
  const db = setup({ status: 'done' })
  try {
    addEvidence(db, { verdict: null })
    const workflowId = 'effect-projection'
    const title = '外部操作'
    const user = 'human:owner'
    withTx(db, (tx) => {
      createWorkflow(tx, { workflowId, name: title, actor: user, now: NOW, definition: { name: title, nodes: [
        { node_id: 'start', type: 'trigger', title: '入口', position: { x: 0, y: 0 } },
        { node_id: 'n1', type: 'agent', title, position: { x: 100, y: 0 }, contract: { declared_effect: 'not_applied' } },
      ], edges: [{ from: 'start', to: 'n1' }] } })
      const published = publishDraft(tx, { workflowId, revision: 1, baseVersion: 0, actor: user, now: NOW, note: title },
        publishContextFor(tx, new Set(['agent'])))
      tx.run('UPDATE runs SET workflow_id = ?, workflow_version = ?, workflow_definition_hash = ? WHERE run_id = ?',
        [workflowId, published.version, published.definition_hash, 'r1'])
    })
    expect(getNodeSnapshot(db, 'nr1').item).toMatchObject({
      declared_effect: 'not_applied', verified_effect: null, evidence_state: 'none', evidence_strength: null, execution_ids: [EXEC_ID],
    })
    expect(getNodeSnapshot(db, 'nr1').item.evidence_state_reason).toBeTruthy()
    withTx(db, (tx) => tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE node_run_id = 'nr1'"))
    expect(getNodeSnapshot(db, 'nr1').item).toMatchObject({ evidence_state: 'not_required', evidence_strength: null })
    const decision = addDecision(db)
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET side_effect_policy = 'irreversible' WHERE node_run_id = 'nr1'")
      tx.run("INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, evidence_id, resolved_at) VALUES ('nr1','r1','evidence',?,?)",
        [EXEC_ID, NOW])
    })
    expect(getNodeSnapshot(db, 'nr1').item).toMatchObject({
      declared_effect: 'not_applied', verified_effect: 'applied', evidence_state: 'settled', evidence_strength: null, effect_decision_id: decision,
    })
    expect(settle(db, { basis: 'evidence', evidenceId: EXEC_ID })).toMatchObject({ replayed: true, evidence_id: EXEC_ID })
  } finally {
    db.raw.close()
  }
})

it.each(['applied', 'not_applied'] as const)('Q-32 人工裁决用宿主确认的 %s 证据同事务结算', async (verdict) => {
  const db = setup({ status: 'failed_with_unverified' })
  try {
    const registry = new ToolRegistry()
    const reference = 'r1/nr1/1'
    registry.register({
      name: 'read-transaction', capability: 'read_only', command: { bin: 'receipt-check', args: [] },
      effectVerifier: {
        id: 'transaction-receipt/v1', workflowDefinitionHash: WORKFLOW_HASH, nodeId: 'n1',
        verify: (target, { stdout }) => {
          const [observedReference, state] = stdout.split(' ')
          if (observedReference !== `${target.run_id}/${target.node_run_id}/${target.attempt}`) return null
          if (state === 'committed') return { verdict: 'applied', reference: observedReference }
          if (state === 'cancelled-before-commit') return { verdict: 'not_applied', reference: observedReference }
          return null
        },
      },
    })
    const runner = new ReadOnlyToolRunner(registry, {
      readonlyAvailable: () => true,
      run: async () => ({ exitCode: 0, stdout: reference + ' ' + (verdict === 'applied' ? 'committed' : 'cancelled-before-commit'), stderr: '' }),
    }, '.')
    const collector = new EvidenceCollector({ db, secret: TEST_SECRET, registry, runner, policy: { allow: ['read-transaction'] },
      allowedTools: ['read-transaction'], nodeRunId: 'nr1', attempt: 1, executorAgentId: 'verifier-host', nowAt: () => NOW })
    const receipt = await collector.collect({ callId: 'check', tool: 'read-transaction', args: [], cwd: '.', timeoutMs: 100 })
    const evidenceId = receipt.trace!.executionId
    const decisionId = 'dec-effect'
    withTx(db, (tx) => openDecision(tx, { decisionId, runId: 'r1', nodeRunId: 'nr1', kind: 'verify_human', createdAt: NOW }))
    const approve = (declared: EffectVerdict) => withTx(db, (tx) => resolveDecision(tx, TEST_SECRET, {
      decisionId, revision: 1, resolution: 'approved', confirm: true, now: NOW, actor: { kind: 'human', id: 'human:auditor' },
      payload: { effect_verdict: declared, evidence_ids: [evidenceId] },
    }))
    expectCode(() => approve(verdict === 'applied' ? 'not_applied' : 'applied'), 'RESOLUTION_NOT_AVAILABLE')
    expect(db.raw.prepare('SELECT status, revision FROM decisions WHERE decision_id = ?').get(decisionId))
      .toMatchObject({ status: 'pending', revision: 1 })
    expect(resolutionRows(db)).toHaveLength(0)
    expect(listUnverifiedEffects(db).items).toHaveLength(1)
    expect(approve(verdict)).toMatchObject({ closedReason: 'approved' })
    if (verdict === 'applied') {
      expect(resolutionRows(db)).toMatchObject([{ resolution_basis: 'decision', decision_id: decisionId, evidence_id: null, stop_evidence: null }])
      expect(JSON.parse(String(db.raw.prepare('SELECT payload_json FROM decisions WHERE decision_id = ?').get(decisionId)?.payload_json)))
        .toMatchObject({ evidence_ids: [evidenceId] })
    } else {
      expect(resolutionRows(db)).toMatchObject([{ resolution_basis: 'verified_none', decision_id: null, evidence_id: null, stop_evidence: evidenceId }])
      expect(nodeRow(db)).toMatchObject({ side_effect_verified_none: 1, stop_evidence: evidenceId })
    }
    expect(listUnverifiedEffects(db).items).toHaveLength(0)
    expect(getNodeSnapshot(db, 'nr1').item).toMatchObject({ effect_decision_id: decisionId, verified_effect: verdict })
  } finally {
    db.raw.close()
  }
})

it('Q-33 真实人工启动确认只由人证读取入口返回，不进入业务证据或结算', () => {
  const db = setup({ status: 'startup_unknown' })
  try {
    const result = confirmStartup(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, now: NOW, attested: true, actor: 'human:auditor' })
    expect(result.trigger).toBe('confirm-started-attested')
    const id = result.attestation_id!
    expect(getAttestationSnapshot(db, id).item).toMatchObject({ attestation_id: id, action_start_source: 'human_attested',
      classification: '人证，不是系统证据' })
    expectCode(() => getEvidenceSnapshot(db, TEST_SECRET, id), 'NOT_FOUND')
    expect(getNodeSnapshot(db, 'nr1').item).toMatchObject({
      attestation_id: id, action_start_source: 'human_attested', evidence_strength: null, evidence_state: 'none', verified_effect: null,
    })
    expect(inspectEffectEvidence(db, TEST_SECRET, 'nr1').item.evidence).toEqual([])
    expectCode(() => settle(db, { basis: 'evidence', evidenceId: id, expected: { revision: nodeRow(db).revision } }), 'RESOLUTION_NOT_AVAILABLE')
    expect(resolutionRows(db)).toHaveLength(0)
    expect(listUnverifiedEffects(db).items).toHaveLength(1)
  } finally {
    db.raw.close()
  }
})
