// src/service/commands/effects.ts —— 副作用结算的唯一受控写入口（规格附录 §1–§5）
//
// 结算 = unverified_resolutions 落一行。三条路径互斥：
//   verified_none —— 已确认没发生；依据 stop_evidence（与 node_runs.stop_evidence 逐字节相同）
//   evidence       —— 系统证据证明已发生；evidence_id = tool_executions.execution_id
//   decision       —— 人工裁决认定已发生；decision_id（证据引用留在 decisions.payload_json）
// 真相源是表：unverified_resolutions 有行就算已结算；结算只 INSERT，不 UPDATE 不 DELETE。
// 人证（attestations 行、人的 claim、模型自述）永远不是结算依据（附录 §8）。

import { OrchError } from '../../core/errors.ts'
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { appendEvent, appendNodeRunEvent, chainBreakOf, readChain } from '../../infra/db/ledger.ts'
import { assertOperationId, runIdempotentCommand } from './idempotency.ts'
import { type Tx } from '../../infra/sqlite/driver.ts'
import { type Actor } from '../decision/approver.ts'

/** 幂等回执里的命令身份（附录 §4 步骤 1、§11） */
const COMMAND_KIND = 'effect.resolve'
/** 结算事件类型固定这一个（附录 §11） */
const EVENT_TYPE = 'effect.resolved'
/** 审计能力位：带它或有人的身份才许结算（附录 §5） */
const AUDIT_CAPABILITY = 'orchestra.audit'

/** 状态 × basis 相容矩阵（附录 §3）：不在集内一律不收 */
const BASIS_STATUSES: Record<ResolutionBasis, readonly string[]> = {
  verified_none: ['failed', 'stopping', 'indeterminate_side_effect', 'abandoned_unverified', 'failed_with_unverified'],
  evidence: ['stopping', 'indeterminate_side_effect', 'failed_with_unverified', 'done'],
  decision: ['stopping', 'indeterminate_side_effect', 'failed_with_unverified'],
}

/** stop_evidence 的 N1 前缀（附录 §2.3 V3）；N2 是 tex_ 开头的执行 ID */
const N1_PREFIXES = ['no_tool_started:', 'stopped_confirmed:'] as const

export type ResolutionBasis = 'verified_none' | 'evidence' | 'decision'

/** 证据来源声明：模型侧 tool_result 是弱证据，不能结算（附录 §2.1 E5） */
export type EvidenceSource = 'run_tool' | 'tool_result'

export type EffectResolveRequest = {
  basis: ResolutionBasis
  nodeRunId: string
  runId?: string | null
  evidenceId?: string | null
  decisionId?: string | null
  stopEvidence?: string | null
  expected: { revision: number; decisionRevision?: number | null }
  operationId: string
  now: string
  actor: Actor
  evidenceSource?: EvidenceSource | null
}

export type EffectResolutionResult = {
  node_run_id: string
  resolution_basis: ResolutionBasis
  resolved_at: string
  node_revision: number
  evidence_id: string | null
  decision_id: string | null
  stop_evidence: string | null
  replayed: boolean
}

type SettlementNode = {
  node_run_id: string
  run_id: string
  node_id: string
  attempt: number
  status: string
  revision: number
  side_effect_policy: string
  side_effect_verified_none: number
  stop_evidence: string | null
}

type ResolutionRow = {
  node_run_id: string
  run_id: string
  resolution_basis: ResolutionBasis
  evidence_id: string | null
  decision_id: string | null
  stop_evidence: string | null
  resolved_at: string
}

type DecisionRow = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  revision: number
  closed_reason: string | null
  decided_at: string | null
  payload_json: string
}

type ToolExecution = {
  execution_id: string
  node_run_id: string
  attempt: number
  tool: string
  exit_code: number
  stdout_hash: string | null
  stderr_hash: string | null
  command_hash: string | null
  finished_at: string | null
}

type GateFailure = {
  code: 'RESOLUTION_NOT_AVAILABLE' | 'EVIDENCE_SOURCE_UNAVAILABLE' | 'VERIFICATION_TOO_WEAK'
  message: string
  details?: Record<string, unknown>
}

type GateResult = { ok: true; row: ToolExecution } | { ok: false; failure: GateFailure }

function fail(code: GateFailure['code'], message: string, details?: Record<string, unknown>): { ok: false; failure: GateFailure } {
  return { ok: false, failure: { code, message, details } }
}

function loadNode(tx: Tx, nodeRunId: string): SettlementNode | undefined {
  return tx.get<SettlementNode>(
    'SELECT node_run_id, run_id, node_id, attempt, status, revision, side_effect_policy, side_effect_verified_none, stop_evidence'
    + ' FROM node_runs WHERE node_run_id = ?',
    [nodeRunId],
  )
}

function loadResolution(tx: Tx, nodeRunId: string): ResolutionRow | undefined {
  return tx.get<ResolutionRow>(
    'SELECT node_run_id, run_id, resolution_basis, evidence_id, decision_id, stop_evidence, resolved_at'
    + ' FROM unverified_resolutions WHERE node_run_id = ?',
    [nodeRunId],
  )
}

function loadDecision(tx: Tx, decisionId: string): DecisionRow | undefined {
  return tx.get<DecisionRow>(
    'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, decided_at, payload_json'
    + ' FROM decisions WHERE decision_id = ?',
    [decisionId],
  )
}

function parsePayload(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return {}
  }
  return {}
}

/**
 * 证据门 E1–E5：系统证据 = tool_executions 行 + 同 attempt 的 tool_finished 节点事件 + 有效事件链。
 * 判定口径只有这一份，人工裁决也走它（附录 §0、§2.1）。
 */
function checkSystemEvidence(
  tx: Tx,
  secret: string,
  node: SettlementNode,
  executionId: string,
  source: EvidenceSource | null | undefined,
): GateResult {
  const row = tx.get<ToolExecution>(
    'SELECT execution_id, node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, finished_at'
    + ' FROM tool_executions WHERE execution_id = ?',
    [executionId],
  )
  // E1：证据 ID 必须命中 tool_executions.execution_id（人证 ID 落不到这里）
  if (!row) {
    return fail('RESOLUTION_NOT_AVAILABLE', '这条系统证据不存在', { execution_id: executionId })
  }
  // E2：同一个节点、同一个 run、当前代次、并且已经结束
  if (row.node_run_id !== node.node_run_id) {
    return fail('RESOLUTION_NOT_AVAILABLE', '这条系统证据不属于目标节点', {
      execution_id: executionId,
      node_run_id: node.node_run_id,
    })
  }
  if (row.attempt !== node.attempt) {
    return fail('RESOLUTION_NOT_AVAILABLE', '这条系统证据不是节点的当前代次', {
      execution_id: executionId,
      attempt: row.attempt,
      current_attempt: node.attempt,
    })
  }
  if (!row.finished_at) {
    return fail('RESOLUTION_NOT_AVAILABLE', '这条系统证据还没有结束时间', { execution_id: executionId })
  }
  // E3：节点事件里要有同一 execution_id 的 tool_finished，七项逐字相符
  const events = tx.all<{ payload: string }>(
    "SELECT payload FROM node_run_events WHERE node_run_id = ? AND type = 'tool_finished' ORDER BY seq ASC",
    [node.node_run_id],
  )
  let matched: Record<string, unknown> | null = null
  for (const ev of events) {
    let parsed: unknown
    try {
      parsed = JSON.parse(ev.payload)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && (parsed as { execution_id?: unknown }).execution_id === executionId) {
      matched = parsed as Record<string, unknown>
      break
    }
  }
  if (!matched) {
    return fail('EVIDENCE_SOURCE_UNAVAILABLE', '这条系统证据没有对应的 tool_finished 事件', {
      execution_id: executionId,
    })
  }
  const pairs: Array<[string, unknown, unknown]> = [
    ['tool', matched['tool'], row.tool],
    ['attempt', matched['attempt'], row.attempt],
    ['exit_code', matched['exit_code'], row.exit_code],
    ['stdout_hash', matched['stdout_hash'] ?? null, row.stdout_hash ?? null],
    ['stderr_hash', matched['stderr_hash'] ?? null, row.stderr_hash ?? null],
    ['command_hash', matched['command_hash'] ?? null, row.command_hash ?? null],
    ['finished_at', matched['finished_at'] ?? null, row.finished_at ?? null],
  ]
  for (const [field, fromEvent, fromRow] of pairs) {
    if (fromEvent !== fromRow) {
      return fail('EVIDENCE_SOURCE_UNAVAILABLE', '执行记录与它的 tool_finished 事件对不上', {
        execution_id: executionId,
        field,
      })
    }
  }
  // E4：节点事件链必须完整（账本密钥在写事务里可用）
  const brk = chainBreakOf(secret, readChain(tx, node.node_run_id))
  if (brk) {
    return fail('EVIDENCE_SOURCE_UNAVAILABLE', '节点事件链已断，不能拿它当结算依据', {
      node_run_id: node.node_run_id,
      seq: brk.seq,
    })
  }
  // E5：强度必须是宿主签发的强证据；模型侧 tool_result 是弱证据
  if (source === 'tool_result') {
    return fail('VERIFICATION_TOO_WEAK', '模型侧 tool_result 不是系统证据，不能结算', {
      execution_id: executionId,
      source,
    })
  }
  return { ok: true, row }
}

/** 结算写入口只放行人，或带 orchestra.audit 能力位的 Agent（附录 §5） */
function assertSettlementActor(actor: Actor | null | undefined): void {
  if (!actor) {
    throw new OrchError('FORBIDDEN', '结算必须说明是谁在结算', {})
  }
  if (actor.kind === 'human') return
  if (actor.kind === 'agent' && (actor.capabilities ?? []).includes(AUDIT_CAPABILITY)) return
  throw new OrchError('FORBIDDEN', '普通 Agent 没有副作用结算权限', { actor: actor.id })
}

/** stop_evidence 只能是 N1 前缀或 N2 执行 ID，禁止自由文本（附录 §2.3 V3、§11） */
function assertStopEvidenceShape(value: string): void {
  if (value.trim() === '') {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'stop_evidence 不能是空串', {})
  }
  if (value.trim() !== value) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'stop_evidence 前后不许有空白', { stop_evidence: value })
  }
  if (N1_PREFIXES.some((p) => value.startsWith(p))) return
  if (value.startsWith('tex_')) return
  throw new OrchError('PAYLOAD_SCHEMA_INVALID',
    'stop_evidence 只能是 no_tool_started: / stopped_confirmed: 前缀，或者一条 tex_ 开头的执行 ID', { stop_evidence: value })
}

/** N1 的尾部必须逐字对上这个节点：<node_run_id>:<attempt>[:<event_seq>] */
function assertStopEvidenceNodeShape(node: SettlementNode, value: string): void {
  const prefix = N1_PREFIXES.find((p) => value.startsWith(p))
  if (!prefix) return
  const parts = value.slice(prefix.length).split(':')
  const ok = parts[0] === node.node_run_id
    && parts[1] === String(node.attempt)
    && parts.length <= 3
    && (parts.length < 3 || /^\d+$/.test(parts[2] ?? ''))
  if (!ok) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID',
      'stop_evidence 必须是 <node_run_id>:<attempt>[:<event_seq>]', { stop_evidence: value })
  }
}

function assertLedgerStopEvidence(tx: Tx, secret: string, node: SettlementNode, value: string): void {
  const chain = readChain(tx, node.node_run_id)
  if (chainBreakOf(secret, chain)) {
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '节点事件链断裂，不能证明动作未生效')
  }
  if (value.startsWith('stopped_confirmed:')) {
    if (node.side_effect_verified_none === 1 && node.stop_evidence === value) return
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '账本未记录执行器确认动作停止且未生效')
  }
  const [, , seq] = value.slice('no_tool_started:'.length).split(':')
  const started = chain.some((event) => {
    if (event.type !== 'tool_started' && event.type !== 'tool_finished') return false
    const attempt = parsePayload(event.payload).attempt
    return !Number.isInteger(attempt) || attempt === node.attempt
  })
  const execution = tx.get('SELECT 1 FROM tool_executions WHERE node_run_id = ? AND attempt = ? LIMIT 1',
    [node.node_run_id, node.attempt])
  const memoryWrite = tx.get('SELECT 1 FROM memory_batches WHERE apply_node_run_id = ? LIMIT 1', [node.node_run_id])
  if (node.status === 'stopping' || started || execution || memoryWrite
    || (seq !== undefined && !chain.some((event) => event.seq === Number(seq)))) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '账本无法证明这个 attempt 没有启动工具')
  }
}

/** 同一 basis 且依据完全相同 = 幂等重放；依据不同 = 冲突（附录 §2.4） */
function sameBasis(existing: ResolutionRow, req: EffectResolveRequest): boolean {
  if (existing.resolution_basis !== req.basis) return false
  if (req.basis === 'evidence') return existing.evidence_id === req.evidenceId
  if (req.basis === 'decision') return existing.decision_id === req.decisionId
  return existing.stop_evidence === req.stopEvidence
}

/**
 * 落库 + 事件：结算行只 INSERT；节点字段（verified_none）先写，触发器才看得到一致状态。
 * 事件固定 effect.resolved：节点链一条、run 级一条。
 */
function writeResolution(tx: Tx, secret: string, input: {
  node: SettlementNode
  basis: ResolutionBasis
  evidenceId: string | null
  decisionId: string | null
  stopEvidence: string | null
  eventDecisionId?: string | null
  now: string
  expectedRevision: number
}): EffectResolutionResult {
  const { node, basis } = input
  let nodeRevision = node.revision
  if (basis === 'verified_none') {
    // 节点上已有的停证据必须与这次一致；不一致就没有事实依据（附录 §2.3 V4）
    if (node.stop_evidence && node.stop_evidence !== input.stopEvidence) {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '节点上已有的 stop_evidence 与这次的不一样', {
        node_run_id: node.node_run_id,
      })
    }
    const allowed = BASIS_STATUSES.verified_none
    const res = tx.run(
      'UPDATE node_runs SET side_effect_verified_none = 1, stop_evidence = ?, revision = revision + 1, updated_at = ?'
      + ' WHERE node_run_id = ? AND revision = ? AND status IN (' + allowed.map(() => '?').join(', ') + ')',
      [input.stopEvidence, input.now, node.node_run_id, input.expectedRevision, ...allowed],
    )
    if (res.changes !== 1) {
      throw new OrchError('STALE_GENERATION', '节点结算 CAS 未命中', { node_run_id: node.node_run_id })
    }
    nodeRevision = node.revision + 1
  }
  tx.run(
    'INSERT INTO unverified_resolutions (node_run_id, run_id, resolution_basis, evidence_id, decision_id, stop_evidence, resolved_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [node.node_run_id, node.run_id, basis, input.evidenceId, input.decisionId, input.stopEvidence, input.now],
  )
  const payload = {
    node_run_id: node.node_run_id,
    run_id: node.run_id,
    resolution_basis: basis,
    resolved_at: input.now,
    revision: nodeRevision,
    evidence_id: input.evidenceId,
    decision_id: input.eventDecisionId ?? input.decisionId,
    stop_evidence: input.stopEvidence,
  }
  appendNodeRunEvent(tx, secret, node.node_run_id, EVENT_TYPE, payload)
  appendEvent(tx, { runId: node.run_id, nodeRunId: node.node_run_id, type: EVENT_TYPE, payload })
  return {
    node_run_id: node.node_run_id,
    resolution_basis: basis,
    resolved_at: input.now,
    node_revision: nodeRevision,
    evidence_id: input.evidenceId,
    decision_id: input.decisionId,
    stop_evidence: input.stopEvidence,
    replayed: false,
  }
}

/**
 * 结算写命令（附录 §4）。幂等、作用域、CAS、证据门、落库、事件、回执都在同一笔事务里。
 */
export function resolveEffect(tx: Tx, secret: string, req: EffectResolveRequest): EffectResolutionResult {
  assertSettlementActor(req.actor)
  const requestHash = sha256Hex(canonicalJson({
    command: COMMAND_KIND,
    target: { run_id: req.runId ?? null, node_run_id: req.nodeRunId, basis: req.basis },
    expected: { revision: req.expected?.revision ?? null, decision_revision: req.expected?.decisionRevision ?? null },
    payload: {
      evidence_id: req.evidenceId ?? null,
      decision_id: req.decisionId ?? null,
      stop_evidence: req.stopEvidence ?? null,
      evidence_source: req.evidenceSource ?? null,
    },
  }))
  const { result, replayed } = runIdempotentCommand(
    tx,
    { kind: COMMAND_KIND, operationId: req.operationId, requestHash, now: req.now },
    () => applyEffectCommand(tx, secret, req),
  )
  return { ...result, replayed: replayed || result.replayed }
}

function applyEffectCommand(tx: Tx, secret: string, req: EffectResolveRequest): EffectResolutionResult {
  // 步骤 2：schema 校验
  assertOperationId(req.operationId)
  const allowedStatuses = BASIS_STATUSES[req.basis]
  if (!allowedStatuses) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'basis 只能是 verified_none / evidence / decision', {
      basis: String(req.basis),
    })
  }
  if (typeof req.nodeRunId !== 'string' || req.nodeRunId === '') {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'node_run_id 不能为空', {})
  }
  if (!req.expected || !Number.isInteger(req.expected.revision) || req.expected.revision < 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'expected.revision 必填且是非负整数', {})
  }
  if (req.basis === 'evidence' && !req.evidenceId) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'basis=evidence 必须给 evidence_id', {})
  }
  if (req.basis === 'decision' && !req.decisionId) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'basis=decision 必须给 decision_id', {})
  }
  if (req.basis === 'verified_none' && !req.stopEvidence) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'basis=verified_none 必须给 stop_evidence', {})
  }
  if (req.basis === 'verified_none') {
    assertStopEvidenceShape(req.stopEvidence as string)
  }
  if (req.basis === 'decision' && !Number.isInteger(req.expected.decisionRevision)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'basis=decision 必须给 expected.decision_revision', {})
  }

  // 步骤 3：作用域
  const node = loadNode(tx, req.nodeRunId)
  if (!node) {
    throw new OrchError('NOT_FOUND', '没找到这个节点', { node_run_id: req.nodeRunId })
  }
  if (req.runId && req.runId !== node.run_id) {
    throw new OrchError('NOT_FOUND', '节点不属于这个 run', { node_run_id: req.nodeRunId, run_id: req.runId })
  }
  if (node.side_effect_policy === 'pure') {
    throw new OrchError('SIDE_EFFECT_UNDECLARED', '这个节点声明的是纯节点，没有副作用可结算', {
      node_run_id: node.node_run_id,
    })
  }
  let decision: DecisionRow | undefined
  if (req.basis === 'decision') {
    decision = loadDecision(tx, req.decisionId as string)
    if (!decision) {
      throw new OrchError('NOT_FOUND', '没找到这张 decision', { decision_id: req.decisionId })
    }
  }

  // 步骤 4：CAS —— 结算表已有行
  const existing = loadResolution(tx, node.node_run_id)
  if (existing) {
    if (sameBasis(existing, req)) {
      // 同 basis 同依据：幂等重放，不新增行也不写事件
      return {
        node_run_id: existing.node_run_id,
        resolution_basis: existing.resolution_basis,
        resolved_at: existing.resolved_at,
        node_revision: node.revision,
        evidence_id: existing.evidence_id,
        decision_id: existing.decision_id,
        stop_evidence: existing.stop_evidence,
        replayed: true,
      }
    }
    throw new OrchError('EFFECT_RESOLUTION_CONFLICT', '这个节点已经有结算行，依据和这次不一样', {
      node_run_id: node.node_run_id,
      existing_basis: existing.resolution_basis,
      requested_basis: req.basis,
    })
  }
  if (req.basis === 'decision' && decision) {
    if (decision.revision !== req.expected.decisionRevision) {
      throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 版本对不上', {
        decision_id: decision.decision_id,
        expected: req.expected.decisionRevision,
        actual: decision.revision,
      })
    }
  }
  if (node.revision !== req.expected.revision) {
    throw new OrchError('STALE_GENERATION', '节点版本对不上', {
      node_run_id: node.node_run_id,
      expected: req.expected.revision,
      actual: node.revision,
    })
  }
  if (!allowedStatuses.includes(node.status)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '节点当前状态不能按这个 basis 结算', {
      node_run_id: node.node_run_id,
      status: node.status,
      basis: req.basis,
    })
  }

  // 步骤 5：证据门
  if (req.basis === 'evidence') {
    const gate = checkSystemEvidence(tx, secret, node, req.evidenceId as string, req.evidenceSource)
    if (!gate.ok) throw new OrchError(gate.failure.code, gate.failure.message, gate.failure.details)
  }
  if (req.basis === 'decision' && decision) {
    assertDecisionBasis(tx, secret, node, decision, req.expected.decisionRevision as number, req.evidenceSource)
  }
  if (req.basis === 'verified_none') {
    const value = req.stopEvidence as string
    assertStopEvidenceNodeShape(node, value)
    if (N1_PREFIXES.some((p) => value.startsWith(p))) {
      assertLedgerStopEvidence(tx, secret, node, value)
    } else {
      // N2：一条证明动作未生效的强证据执行 ID，同样过 E1–E5
      const gate = checkSystemEvidence(tx, secret, node, value, req.evidenceSource)
      if (!gate.ok) throw new OrchError(gate.failure.code, gate.failure.message, gate.failure.details)
    }
  }

  // 步骤 7：落库 + 事件
  return writeResolution(tx, secret, {
    node,
    basis: req.basis,
    evidenceId: req.basis === 'evidence' ? (req.evidenceId as string) : null,
    decisionId: req.basis === 'decision' ? (req.decisionId as string) : null,
    stopEvidence: req.basis === 'verified_none' ? (req.stopEvidence as string) : null,
    now: req.now,
    expectedRevision: req.expected.revision,
  })
}

/** decision 分支 D1–D7：只有人的裁决认定「已发生」才成，而且证据要过同一道门 */
function assertDecisionBasis(
  tx: Tx,
  secret: string,
  node: SettlementNode,
  decision: DecisionRow,
  expectedRevision: number,
  source: EvidenceSource | null | undefined,
): void {
  if (decision.revision !== expectedRevision) {
    throw new OrchError('DECISION_REVISION_CONFLICT', 'decision 版本对不上', {
      decision_id: decision.decision_id,
      expected: expectedRevision,
      actual: decision.revision,
    })
  }
  if (decision.kind !== 'verify_human' && decision.kind !== 'action_overrun') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 的 kind 不能作为结算依据', {
      decision_id: decision.decision_id,
      kind: decision.kind,
    })
  }
  if (decision.node_run_id !== node.node_run_id) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 不是这个节点的裁决', {
      decision_id: decision.decision_id,
    })
  }
  if (decision.status !== 'resolved') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 还没收口', {
      decision_id: decision.decision_id,
      status: decision.status,
    })
  }
  if (decision.closed_reason !== 'approved') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 不是批准的结论', {
      decision_id: decision.decision_id,
      closed_reason: decision.closed_reason,
    })
  }
  if (!decision.decided_at) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '这张 decision 没有裁决时间', {
      decision_id: decision.decision_id,
    })
  }
  const payload = parsePayload(decision.payload_json)
  if (payload['effect_verdict'] !== 'applied') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '裁决没有认定副作用已发生', {
      decision_id: decision.decision_id,
    })
  }
  const evidenceIds = payload['evidence_ids']
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '裁决没有引用系统证据', {
      decision_id: decision.decision_id,
    })
  }
  const declared = payload['evidence_source'] === 'tool_result' ? 'tool_result' : source
  for (const id of evidenceIds) {
    if (typeof id !== 'string' || id === '') {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '裁决引用的证据 ID 不是字符串', {
        decision_id: decision.decision_id,
      })
    }
    const gate = checkSystemEvidence(tx, secret, node, id, declared)
    if (!gate.ok) throw new OrchError(gate.failure.code, gate.failure.message, gate.failure.details)
  }
}

/**
 * 报告收口路径的结算（附录 §4）：证据分支由 applyReport 的 done 收口事务内部写。
 * 找不到合格证据就不落行（fail closed），但绝不打断报告本身的收口。
 */
export function settleEvidenceFromReport(tx: Tx, secret: string, input: {
  nodeRunId: string
  executionIds: readonly string[]
  now: string
}): void {
  const node = loadNode(tx, input.nodeRunId)
  if (!node) return
  if (node.side_effect_policy === 'pure') return
  if (node.status !== 'done') return
  if (loadResolution(tx, node.node_run_id)) return
  for (const executionId of input.executionIds) {
    const gate = checkSystemEvidence(tx, secret, node, executionId, null)
    if (!gate.ok) continue
    writeResolution(tx, secret, {
      node,
      basis: 'evidence',
      evidenceId: executionId,
      decisionId: null,
      stopEvidence: null,
      now: input.now,
      expectedRevision: node.revision,
    })
    return
  }
}

/**
 * 人工裁决收口路径的结算（附录 §4）：decision 分支由 resolveDecision 的收口事务内部写。
 * 裁决说「已发生」→ basis=decision；裁决说「没发生」→ basis=verified_none（stop_evidence 取裁决引用的强证据执行 ID）。
 */
export function settleDecisionOutcome(tx: Tx, secret: string, input: {
  decisionId: string
  now: string
}): void {
  const decision = loadDecision(tx, input.decisionId)
  if (!decision) return
  if (decision.kind !== 'verify_human' && decision.kind !== 'action_overrun') return
  if (!decision.node_run_id) return
  if (decision.status !== 'resolved' || decision.closed_reason !== 'approved' || !decision.decided_at) return
  const payload = parsePayload(decision.payload_json)
  const verdict = payload['effect_verdict']
  if (verdict !== 'applied' && verdict !== 'not_applied') return
  const evidenceIds = payload['evidence_ids']
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return
  const node = loadNode(tx, decision.node_run_id)
  if (!node) return
  if (node.run_id !== decision.run_id) return
  if (node.side_effect_policy === 'pure') return
  if (loadResolution(tx, node.node_run_id)) return
  const basis: ResolutionBasis = verdict === 'applied' ? 'decision' : 'verified_none'
  if (!BASIS_STATUSES[basis].includes(node.status)) return
  const declared = payload['evidence_source'] === 'tool_result' ? 'tool_result' : null
  for (const id of evidenceIds) {
    if (typeof id !== 'string' || id === '') {
      throw new OrchError('RESOLUTION_NOT_AVAILABLE', '裁决引用的证据 ID 不是字符串', {
        decision_id: decision.decision_id,
      })
    }
    const gate = checkSystemEvidence(tx, secret, node, id, declared)
    if (!gate.ok) throw new OrchError(gate.failure.code, gate.failure.message, gate.failure.details)
  }
  if (basis === 'decision') {
    writeResolution(tx, secret, {
      node,
      basis: 'decision',
      evidenceId: null,
      decisionId: decision.decision_id,
      stopEvidence: null,
      now: input.now,
      expectedRevision: node.revision,
    })
    return
  }
  // 人工认定「没发生」：029 的 CHECK 让结算行存不了 decision_id，事件里必须带上
  writeResolution(tx, secret, {
    node,
    basis: 'verified_none',
    evidenceId: null,
    decisionId: null,
    stopEvidence: evidenceIds[0] as string,
    eventDecisionId: decision.decision_id,
    now: input.now,
    expectedRevision: node.revision,
  })
}
