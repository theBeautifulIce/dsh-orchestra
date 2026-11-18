// src/service/commands/apply-report.ts —— applyReport 六步收口（规格 4.2 行 286-305）
import { OrchError } from '../../core/errors.ts'
import { isReportRegistryState, type ApplyResult, type Report } from '../../core/report.ts'
import type { PassCondition } from '../../core/policy.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { transitionNode } from './node-state.ts'
import { settleEvidenceFromReport } from './effects.ts'
import { applyTransition, createNodeRun } from './nodes.ts'
import { loadNodeRun, assertLeaseValid, type NodeRunRow } from './lease.ts'
import { openDecision, resolveDecision, type Resolution } from './decisions.ts'
import { HANG_REASON_REPORT_CONTRADICTED, type NodeStatus } from '../../core/state-machine.ts'
import { uuidv7 } from '../../core/ids.ts'
import { chainBreakOf, readChain } from '../../infra/db/ledger.ts'
import { evaluateEvidence, evaluatePassConditions } from '../../core/policy.ts'
import { canReportTransition } from '../../core/state-machine.ts'
import type { WorkflowCatalog } from '../workflows.ts'

export type ApplyReportParams = {
  nodeRunId: string
  attempt: number
  report: Report
  expectedStatus: string
  // 动作代：执行器回写时带自己看到的 Ga，对不上就是过期写（规格 4.3 行 309）
  generation: number
  now: string
  // 只在挂起冲突的收口口上传；普通出口不许带（S3 Task 12）
  decision?: ApplyDecision
}

export type ApplyDecision = {
  decisionId: string
  revision: number
  resolution: 'confirm_applied' | 'confirm_not_applied' | 'uphold_report' | 'uphold_decision'
}

type ContradictionDecisionRow = {
  decision_id: string
  node_run_id: string | null
  kind: string
  status: string
  revision: number
}

export type ApplyPolicy = { passConditions: PassCondition[]; requiredHashes?: string[] }

type RegistryRow = {
  report_id: string
  node_run_id: string
  attempt: number
  report_seq: number
  state: string
}

function readRegistry(tx: Tx, reportId: string): RegistryRow | undefined {
  return tx.get<RegistryRow>('SELECT * FROM report_registry WHERE report_id = ?', [reportId])
}

// report_seq 在同一笔事务里按 node_run 内最大值加一算，不建触发器
function nextReportSeq(tx: Tx, nodeRunId: string): number {
  const row = tx.get<{ max_seq: number | null }>(
    'SELECT MAX(report_seq) AS max_seq FROM report_registry WHERE node_run_id = ?',
    [nodeRunId],
  )
  return (row?.max_seq ?? 0) + 1
}

// 事件 payload 是 JSON 文本，判重一律按里面的结构化字段比对，不拼字符串模式：
// report_id 带引号或反斜杠时 JSON 会转义，拼出来的 LIKE 永远配不上原文，判重就失效（第三十四轮审计 P1-1）
// CASE 包住 json_extract：payload 万一不是合法 JSON 也让这一行判不成，而不是把查询打挂
function countReportEvent(tx: Tx, nodeRunId: string, type: string, field: 'report_id' | 'reason', value: string): number {
  const row = tx.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ? "
    + "AND CASE WHEN json_valid(payload) THEN json_extract(payload, ?) END = ?",
    [nodeRunId, type, '$.' + field, value],
  )
  return Number(row?.n ?? 0)
}

// 同一个 report_id 的同类事件只留一条：账本不许被重试刷膨胀（审计 R3-04）
function hasNodeRunEvent(tx: Tx, nodeRunId: string, type: string, reportId: string): boolean {
  return countReportEvent(tx, nodeRunId, type, 'report_id', reportId) > 0
}

// 拒绝也要留痕：registry 落 rejected，哈希链追加 report_rejected（规格 4.2 行 298）
function rejectReport(tx: Tx, secret: string, params: {
  nodeRunId: string
  attempt: number
  report: Report
  reportSeq: number
  reason: string
  now: string
}): ApplyResult {
  const existing = readRegistry(tx, params.report.report_id)
  if (existing) {
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['rejected', params.now, params.report.report_id])
    // 同一条报告同因重复被拒：只更新 registry，不再追加事件，账本不许被重试刷膨胀
    if (
      countReportEvent(tx, params.nodeRunId, 'report_rejected', 'report_id', params.report.report_id) > 0
      && countReportEvent(tx, params.nodeRunId, 'report_rejected', 'reason', params.reason) > 0
    ) {
      return { accepted: false, reason: params.reason, registry_state: 'rejected' }
    }
  } else {
    tx.run(
      'INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [params.report.report_id, params.nodeRunId, params.attempt, params.reportSeq, 'rejected', params.now, params.now],
    )
  }
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_rejected', {
    report_id: params.report.report_id,
    report_seq: params.reportSeq,
    reason: params.reason,
    // 被挡下的报告原样留在链上：围栏撤销后要按队头重放，registry 只是投影
    report: params.report,
  })
  return { accepted: false, reason: params.reason, registry_state: 'rejected' }
}

// 判定条件由服务端按 run 绑定的工作流版本取：调用方传不进来，执行器也改不了（规格 4.2 行 293、6.1 行 839）
function policyForReport(tx: Tx, row: NodeRunRow, catalog: WorkflowCatalog): ApplyPolicy {
  const run = tx.get<{ workflow_id: string | null; workflow_version: number | string | null; workflow_definition_hash: string | null }>(
    'SELECT workflow_id, workflow_version, workflow_definition_hash FROM runs WHERE run_id = ?',
    [row.run_id],
  )
  if (!run) throw new OrchError('NOT_FOUND', 'node_run 没有对应的 run', { nodeRunId: row.node_run_id })
  if (run.workflow_version === null) {
    throw new OrchError('VERDICT_UNSUPPORTED', '这个 run 没有绑定工作流版本', { nodeRunId: row.node_run_id })
  }
  if (run.workflow_definition_hash === null) {
    throw new OrchError('VERDICT_UNSUPPORTED', '这个 run 没有绑定工作流定义哈希', { nodeRunId: row.node_run_id })
  }
  // 定义哈希必须与创建 run 时一致：重启后同版本换内容，在飞 run 的判定条件就变了（第六轮审计 P1-1）
  // 旧 run 的 workflow_id 为空，归到 default 命名空间；新 run 的判定条件只认自己工作流里的那个版本
  const current = catalog.definitionHash(run.workflow_id ?? 'default', run.workflow_version)
  if (current !== run.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', 'run 绑定的工作流定义与当前版本不一致，判定条件不许中途换', {
      nodeRunId: row.node_run_id,
      workflow_version: String(run.workflow_version),
      bound: run.workflow_definition_hash,
      current,
    })
  }
  return catalog.policyFor(run.workflow_id ?? 'default', run.workflow_version, row.node_id)
}

/**
 * 把节点挂到「报告与人裁决冲突」：开 report_contradicted 卡，写 hang_reason 与卡号，
 * 节点状态不前进；新 attempt 与普通出口都被挂起闸挡住。
 */
export function raiseReportContradiction(
  tx: Tx,
  secret: string,
  args: { nodeRunId: string; attempt: number; runId: string; reportId: string; now: string; decisionId?: string },
): { decisionId: string; created: boolean } {
  const row = loadNodeRun(tx, args.nodeRunId)
  if (row.status !== 'startup_unknown' && row.status !== 'indeterminate_side_effect') {
    throw new OrchError('STALE_GENERATION', '只有 startup_unknown / indeterminate_side_effect 能挂报告冲突', {
      nodeRunId: args.nodeRunId,
      status: row.status,
    })
  }
  const existing = tx.get<{ decision_id: string }>(
    "SELECT decision_id FROM decisions WHERE node_run_id = ? AND kind = 'report_contradicted' AND status IN ('pending','acknowledged','blocked_for_human') LIMIT 1",
    [args.nodeRunId],
  )
  const decisionId = existing?.decision_id ?? args.decisionId ?? 'dec_' + uuidv7()
  if (!existing) {
    openDecision(tx, {
      decisionId,
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      kind: 'report_contradicted',
      payload: { report_id: args.reportId, hung_status: row.status },
      createdAt: args.now,
    })
  }
  applyTransition(tx, secret, {
    nodeRunId: args.nodeRunId,
    from: [row.status as NodeStatus],
    to: row.status as NodeStatus,
    attempt: args.attempt,
    now: args.now,
    allowHung: true,
    patch: {
      hang_reason: HANG_REASON_REPORT_CONTRADICTED,
      contradiction_decision_id: decisionId,
      startup_unknown_deadline_at: null,
      startup_unknown_remaining_ns: null,
    },
  })
  appendNodeRunEvent(tx, secret, args.nodeRunId, 'report.contradicted', {
    report_id: args.reportId,
    decision_id: decisionId,
    hung_status: row.status,
  })
  return { decisionId, created: !existing }
}

function loadContradictionDecision(tx: Tx, params: ApplyReportParams): ContradictionDecisionRow {
  const decision = tx.get<ContradictionDecisionRow>(
    'SELECT decision_id, node_run_id, kind, status, revision FROM decisions WHERE decision_id = ?',
    [params.decision?.decisionId ?? ''],
  )
  if (!decision) throw new OrchError('DECISION_REQUIRED', '冲突收口没有对应的裁决卡', {})
  if (decision.kind !== 'report_contradicted' || decision.node_run_id !== params.nodeRunId) {
    throw new OrchError('DECISION_REQUIRED', '裁决卡不是这个节点的报告冲突卡', {
      decisionId: decision.decision_id,
      kind: decision.kind,
    })
  }
  if (!['pending', 'acknowledged', 'blocked_for_human'].includes(decision.status)) {
    throw new OrchError('DECISION_REVISION_CONFLICT', '裁决卡已经收口', { status: decision.status })
  }
  if (decision.revision !== params.decision?.revision) {
    throw new OrchError('DECISION_REVISION_CONFLICT', '裁决卡 revision 已过期', {
      expected: params.decision?.revision,
      actual: decision.revision,
    })
  }
  return decision
}

/**
 * uphold_decision：维持人的原裁决，迟到报告永久标 stale，旧行 superseded，新 attempt 从旧行接班。
 * 裁决 CAS 与节点更新在同一事务里；revision 过期时节点一个字节不动。
 */
function upholdDecision(
  tx: Tx,
  secret: string,
  params: ApplyReportParams,
  row: NodeRunRow,
  reportSeq: number,
): ApplyResult {
  const decision = loadContradictionDecision(tx, params)
  resolveDecision(tx, secret, {
    decisionId: decision.decision_id,
    revision: decision.revision,
    resolution: 'uphold_decision' satisfies Resolution,
    now: params.now,
    actor: { kind: 'human', id: 'human:uphold' },
  })
  const newNodeRunId = 'nrun_' + uuidv7()
  applyTransition(tx, secret, {
    nodeRunId: params.nodeRunId,
    from: [row.status as NodeStatus],
    to: 'superseded',
    // 人维持原裁决 → 旧行作废，固定走 M-60；不能落到无守卫的 M-06
    ruleId: 'M-60',
    attempt: params.attempt,
    now: params.now,
    allowHung: true,
    patch: {
      hang_reason: null,
      contradiction_decision_id: null,
      startup_unknown_deadline_at: null,
      startup_unknown_remaining_ns: null,
    },
  })
  createNodeRun(tx, {
    newNodeRunId,
    runId: row.run_id,
    nodeId: row.node_id,
    seq: row.seq,
    nodeType: row.node_type,
    attempt: params.attempt + 1,
    originNodeRunId: params.nodeRunId,
    now: params.now,
  })
  const stale = tx.run(
    'UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?',
    ['stale', params.now, params.report.report_id],
  )
  if (stale.changes === 0) {
    tx.run(
      'INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [params.report.report_id, params.nodeRunId, params.attempt, reportSeq, 'stale', params.now, params.now],
    )
  }
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'report.stale', {
    report_id: params.report.report_id,
    report_seq: reportSeq,
    decision_id: decision.decision_id,
    reason: 'uphold_decision',
  })
  return { accepted: false, reason: 'uphold_decision', next_status: 'superseded', registry_state: 'stale' }
}


export function applyReport(
  tx: Tx,
  secret: string,
  params: ApplyReportParams,
  catalog: WorkflowCatalog,
): ApplyResult {
  const report = params.report
  // 第一步：幂等查重
  const existing = readRegistry(tx, report.report_id)
  if (existing) {
    if (!isReportRegistryState(existing.state)) {
      throw new OrchError('STALE_GENERATION', 'registry 状态不在枚举里', { state: existing.state })
    }
    // 同一个 report_id 只能属于一个 node_run：跨节点重放按结构错拒（审计 N-05）
    if (existing.node_run_id !== params.nodeRunId) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'report_id 已经属于别的节点，不能跨节点重放', {
        report_id: report.report_id,
        registered: existing.node_run_id,
        requested: params.nodeRunId,
      })
    }
    if (existing.state === 'applied') {
      // 已经落过账：不许再落一次，只把状态记成 replayed
      tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
      // 同一条报告反复重发：事件只留一条，账本不许被重试刷膨胀（审计 R3-04）
      if (!hasNodeRunEvent(tx, params.nodeRunId, 'report_replayed', report.report_id)) {
        appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
          report_id: report.report_id,
          report_seq: existing.report_seq,
          reason: 'already_applied',
        })
      }
      return { accepted: false, reason: 'already_applied', registry_state: 'replayed' }
    }
    if (existing.state === 'replayed') {
      // 同一条报告反复重发：事件只留一条，账本不许被重试刷膨胀（审计 N-06）
      if (!hasNodeRunEvent(tx, params.nodeRunId, 'report_replayed', report.report_id)) {
        appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
          report_id: report.report_id,
          report_seq: existing.report_seq,
          reason: 'already_replayed',
        })
      }
      return { accepted: false, reason: 'already_replayed', registry_state: 'replayed' }
    }
    // 已 rejected 的走重放路径：先验哈希链，再确认是当前 attempt 的队头（规格 4.2 行 304）
    if (existing.attempt !== params.attempt) {
      return { accepted: false, reason: 'replay_stale_attempt', registry_state: 'rejected' }
    }
    const brk = chainBreakOf(secret, readChain(tx, params.nodeRunId))
    if (brk) {
      // 链断了的账本不许再写：重放一律拒，等人工核
      return { accepted: false, reason: 'replay_chain_broken', registry_state: 'rejected' }
    }
    const head = tx.get<{ min_seq: number | null }>(
      'SELECT MIN(report_seq) AS min_seq FROM report_registry WHERE node_run_id = ? AND attempt = ? AND state = ?',
      [params.nodeRunId, params.attempt, 'rejected'],
    )
    if ((head?.min_seq ?? null) !== existing.report_seq) {
      // 不是队头：这次先不重放，保持 rejected
      return { accepted: false, reason: 'replay_not_head', registry_state: 'rejected' }
    }
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
    // 重放事件同一 report_id 只留一条：rejected↔replayed 来回翻也不许把账本刷膨胀（审计 R3-04）
    if (!hasNodeRunEvent(tx, params.nodeRunId, 'report_replayed', report.report_id)) {
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
        report_id: report.report_id,
        report_seq: existing.report_seq,
        reason: 'replay_after_reject',
      })
    }
  }
  // 第二步：schema 校验
  if (!report.report_id || report.report_id.length === 0) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'report_id 不能为空', { report })
  }
  if (report.node_run_id !== params.nodeRunId) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'report 的 node_run_id 与请求不一致', { report })
  }
  const reportSeq = existing ? existing.report_seq : nextReportSeq(tx, params.nodeRunId)
  // 第三步：status + attempt + generation 三样 CAS（含租约校验）
  const row: NodeRunRow = loadNodeRun(tx, params.nodeRunId)
  // 控制节点没有宿主执行实例：任何执行器上报都不该落到它们身上。
  // 否则 waiting→failed 可以借 M-48 这条无守卫规则绕开 controlCompletion（G3 r11 P1-1）。
  if (row.node_type === 'wait' || row.node_type === 'subworkflow') {
    return rejectReport(tx, secret, {
      nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq,
      reason: 'control_node_report_not_allowed', now: params.now,
    })
  }
  // 报告自己写的 attempt 必须和请求一致：执行器报 999、请求报 1 不许被当成同一笔（审计 N-07）
  if (report.attempt !== params.attempt) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'attempt_mismatch', now: params.now })
  }
  if (row.attempt !== params.attempt) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'attempt_mismatch', now: params.now })
  }
  if (row.fence_state === 'armed') {
    // 围栏立着时上报一律排队，撤销后只重放队头（规格 4.5 行 358）
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'fence_armed', now: params.now })
  }
  if (row.status !== params.expectedStatus) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'status_mismatch', now: params.now })
  }
  // 挂起闸：报告与人裁决冲突时，普通出口一律 STALE_HANG；
  // 只有 uphold_report / uphold_decision 两张明确的收口口能穿过（M-59/M-60）。
  let upholdReport = false
  if (row.hang_reason === HANG_REASON_REPORT_CONTRADICTED) {
    if (!params.decision) {
      throw new OrchError('STALE_HANG', '节点挂在报告冲突上，普通出口不许推进', {
        nodeRunId: params.nodeRunId,
        hangReason: row.hang_reason,
        decisionId: row.contradiction_decision_id,
      })
    }
    if (params.decision.resolution === 'uphold_decision') {
      return upholdDecision(tx, secret, params, row, reportSeq)
    }
    if (params.decision.resolution !== 'uphold_report') {
      throw new OrchError('STALE_HANG', '挂起冲突只能用 uphold_report / uphold_decision 收口', {
        nodeRunId: params.nodeRunId,
        resolution: params.decision.resolution,
      })
    }
    const decision = loadContradictionDecision(tx, params)
    resolveDecision(tx, secret, {
      decisionId: decision.decision_id,
      revision: decision.revision,
      resolution: 'uphold_report',
      now: params.now,
      actor: { kind: 'human', id: 'human:uphold' },
    })
    upholdReport = true
  }
  if (row.action_generation !== params.generation) {
    // 动作代对不上：旧执行器的过期写，按 STALE_GENERATION 处理（规格 4.3 行 309）
    throw new OrchError('STALE_GENERATION', '动作代对不上，旧执行器的写要丢掉', {
      nodeRunId: params.nodeRunId,
      expected: params.generation,
      actual: row.action_generation,
    })
  }
  assertLeaseValid(row, params.now)
  // 目标状态必须在合法迁移表里：非法迁移按拒绝处理，不许绕过状态机
  if (!canReportTransition(row.status, report.status)) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'illegal_transition', now: params.now })
  }
  // 失败/超时终态也要有可核对的服务端证据：证据必须与同 attempt 的工具痕迹与 tool_finished 对齐，
  // 不能凭一条自报的 exitCode 收口（S2 第二十三轮 P1-1、第二十四轮 P1-2）。
  if (report.status === 'failed' || report.status === 'timeout') {
    const terminal = traceBindingGate(tx, params, report, {
      allowFailed: true,
      // 失败与超时都必须对一条失败行：超时也要在账本里留下失败/被杀的工具痕迹，
      // 只拿一条成功行收口会把超时盖过去（S2 第二十五轮 P1-2、第二十八轮 P2-1）。
      requireFailure: true,
    })
    if (terminal.reason) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: terminal.reason, now: params.now })
    }
  }
  // 第四、五步只对“完成”上报做通过证据与判定：失败、阻塞的回报不该被要求带通过证据
  let evidenceDigest: string | null = null
  if (report.status === 'done') {
    // 判定条件只从 run 绑定的工作流版本取，不在请求体、也不在函数参数里（规格 4.2 行 293）
    const policy = policyForReport(tx, row, catalog)
    // 系统级证据门：弱证据、工具失败都不许直落 done（审计 R3-03）
    const systemReason = systemEvidenceGate(report)
    if (systemReason) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: systemReason, now: params.now })
    }
    // 证据要跟账本里的工具执行痕迹对得上：伪造的 done 与真跑出来的 done 分得开（审计 R3-03）
    const trace = traceBindingGate(tx, params, report)
    if (trace.reason) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: trace.reason, now: params.now })
    }
    // 证据强度按模板要求校验：requiredHashes 的每个键都必须在 report.output 里有同名字段，
    // 且证据值等于该字段的产物哈希；命令哈希、stdout 哈希、整个 output 的摘要都不能冒充
    // 某个具名产物（S2 第二十五轮 P1-1）。
    const evidence = evaluateEvidence(report, policy.requiredHashes ?? [], { output: report.output })
    if (!evidence.ok) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: evidence.reason ?? 'evidence_rejected', now: params.now })
    }
    // 判定条件：模板条件是基线，节点只能追加更严的条件（规格 4.7 行 390）
    const verdict = evaluatePassConditions(policy.passConditions, evidence.normalized)
    if (!verdict.pass) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: verdict.reason ?? 'verdict_unmet', now: params.now })
    }
    evidenceDigest = evidence.digest
  }
  // 第六步：节点迁移也必须走状态机（审计 P0-2：这里曾经直接 UPDATE，绕过 blocked 的裁决卡检查）
  // S2 没有 decisions 表：阻塞凭据就是一条 verify_human 请求（理由 + 缺什么），error_code 只作兜底
  // 两样都没有就是「裸卡住」：按 decision_required 拒掉，节点留在原状态等人来看（审计 N-01）
  const request = (report.output as { request?: { reason?: unknown; missing?: unknown } } | undefined)?.request
  const requestReason = typeof request?.reason === 'string' && request.reason.trim() !== '' ? request.reason.trim() : null
  const codeReason = typeof report.error_code === 'string' && report.error_code.trim() !== '' ? report.error_code.trim() : null
  const blocking = report.status === 'blocked_post' || report.status === 'blocked_pre'
  const reason = requestReason ?? codeReason
  let verifyHuman: { reason: string; missing: string[] } | undefined
  if (blocking) {
    if (reason === null) {
      return rejectReport(tx, secret, {
        nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq,
        reason: 'decision_required', now: params.now,
      })
    }
    verifyHuman = {
      reason,
      missing: Array.isArray(request?.missing) ? request.missing.map(String) : [],
    }
  }
  if (upholdReport) {
    applyTransition(tx, secret, {
      nodeRunId: params.nodeRunId,
      from: [row.status as NodeStatus],
      to: report.status as NodeStatus,
      // 迟到报告的两条出口各自有明确规则：startup_unknown 走 M-11，indeterminate 走 M-59。
      // 不写死就会撞上同一对状态的通用失败边（M-48），把“维持报告”变成普通失败。
      ruleId: row.status === 'startup_unknown' ? 'M-11' : 'M-59',
      attempt: params.attempt,
      now: params.now,
      allowHung: true,
      patch: {
        hang_reason: null,
        contradiction_decision_id: null,
        startup_unknown_deadline_at: null,
        startup_unknown_remaining_ns: null,
      },
    })
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'status_changed', {
      from: row.status,
      to: report.status,
      reason: 'uphold_report',
      decision_id: params.decision?.decisionId,
    })
  } else {
    transitionNode(tx, secret, {
      nodeRunId: params.nodeRunId,
      from: row.status,
      to: report.status,
      attempt: params.attempt,
      revision: row.revision,
      now: params.now,
      reason: 'report_applied',
      verifyHuman,
    })
  }
  if (existing) {
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['applied', params.now, report.report_id])
  } else {
    tx.run(
      'INSERT INTO report_registry (report_id, node_run_id, attempt, report_seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [report.report_id, params.nodeRunId, params.attempt, reportSeq, 'applied', params.now, params.now],
    )
  }
  appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_applied', {
    report_id: report.report_id,
    report_seq: reportSeq,
    next_status: report.status,
    evidence_digest: evidenceDigest,
  })
  // 副作用结算：done 收口的同一笔事务里落 evidence 分支结算行（附录 §4）。
  // 证据不合格就不落行（fail closed），但绝不打断报告本身的收口。
  settleEvidenceFromReport(tx, secret, {
    nodeRunId: params.nodeRunId,
    executionIds: traceEntriesOf(report).map((entry) => entry.executionId),
    now: params.now,
  })
  return { accepted: true, next_status: report.status, registry_state: 'applied' }
}

// 系统级证据门：done 报告的证据必须来自执行器真跑出来的工具，而且工具本身得成功
// 空证据、弱证据（模型侧 tool_result）、工具失败都不许直落终态（审计 R3-03）
function systemEvidenceGate(report: Report): string | null {
  const ev = report.evidence
  if (!ev) return 'evidence_missing'
  // 只有执行器跑出来的强证据能收口（规格 4.7 行 380-383）
  if (ev.source !== 'run_tool') return 'verification_too_weak'
  if (typeof ev.exitCode !== 'number') return 'evidence_missing'
  if (ev.exitCode !== 0) return 'tool_execution_failed'
  return null
}

type ToolExecutionRow = {
  // 每次工具执行的唯一身份：认的是「哪一次执行」，不再只看工具名（评审《第二次意见.md》P1）
  execution_id: string
  tool_seq: number
  tool: string
  exit_code: number
  stdout_hash: string | null
  stderr_hash: string | null
  command_hash: string | null
}

type TraceBinding = {
  reason: string | null
}

// 报告里的工具执行回执：执行器把 execution_id 写进 report.output.evidence_trace，
// 收口时按它回查痕迹行；只有带 execution_id 的条目才算「带执行身份」
type TraceEntry = {
  executionId: string
  toolSeq: number | null
  tool: string | null
  exitCode: number | null
  stdoutHash: string | null
  stderrHash: string | null
  commandHash: string | null
}

// 取报告里的执行回执：字段名与执行器写的一致（tool / exitCode / stdoutHash / stderrHash / commandHash）
function traceEntriesOf(report: Report): TraceEntry[] {
  const output = report.output
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return []
  const trace = (output as { evidence_trace?: unknown }).evidence_trace
  if (!Array.isArray(trace)) return []
  const entries: TraceEntry[] = []
  for (const item of trace) {
    if (item === null || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.executionId !== 'string' || e.executionId.length === 0) continue
    entries.push({
      executionId: e.executionId,
      toolSeq: typeof e.toolSeq === 'number' ? e.toolSeq : null,
      tool: typeof e.tool === 'string' ? e.tool : null,
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
      stdoutHash: typeof e.stdoutHash === 'string' ? e.stdoutHash : null,
      stderrHash: typeof e.stderrHash === 'string' ? e.stderrHash : null,
      commandHash: typeof e.commandHash === 'string' ? e.commandHash : null,
    })
  }
  return entries
}

// 痕迹绑定门：证据要跟账本里的工具执行痕迹对得上，伪造的 done 与真跑出来的 done 分得开（审计 R3-03）
// 同一 attempt 只要有一行工具失败就不许 done；证据的命令名、退出码、stdout/stderr、命令哈希
// 都要和同一行以及对应的 tool_finished 事件对齐（S2 第二十三轮 P0-2/P0-4）。
// 失败/超时终态允许同 attempt 有失败行，但仍要求证据与其中一行及 tool_finished 全等，
// 不能拿一条自报的 exitCode 收口（S2 第二十四轮 P1-2）。
// 报告带了执行身份时按 execution_id 认行：同名工具跑两次也不许张冠李戴（评审《第二次意见.md》P1）。
function traceBindingGate(
  tx: Tx,
  params: ApplyReportParams,
  report: Report,
  opts: { allowFailed?: boolean; requireFailure?: boolean } = {},
): TraceBinding {
  const ev = report.evidence
  if (!ev) return { reason: 'evidence_missing' }
  if (ev.source !== 'run_tool') return { reason: 'verification_too_weak' }
  if (typeof ev.tool !== 'string' || ev.tool.length === 0) return { reason: 'evidence_unverifiable' }
  if (typeof ev.commandHash !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.commandHash)) return { reason: 'evidence_unverifiable' }
  if (typeof ev.producedAt !== 'string' || Number.isNaN(Date.parse(ev.producedAt))) return { reason: 'evidence_missing' }
  const rows = tx.all<ToolExecutionRow>(
    'SELECT execution_id, tool_seq, tool, exit_code, stdout_hash, stderr_hash, command_hash FROM tool_executions WHERE node_run_id = ? AND attempt = ? ORDER BY tool_seq ASC',
    [params.nodeRunId, params.attempt],
  )
  if (rows.length === 0) return { reason: 'evidence_unverifiable' }
  // 同一次尝试里出现过失败的工具，整次尝试就不许以 done 收口；失败/超时终态本身就要对失败行。
  const failedRows = rows.filter((r) => r.exit_code !== 0)
  if (!opts.allowFailed && failedRows.length > 0) return { reason: 'tool_execution_failed' }
  // 失败终态但账本里没有失败行：证据仍自称成功时是“拿成功行收口”，
  // 证据自称失败时则根本没有可核对的失败痕迹。两者都必须拒绝，但归因分开。
  if (opts.requireFailure && failedRows.length === 0) {
    return { reason: ev.exitCode === 0 ? 'tool_execution_failed' : 'evidence_unverifiable' }
  }
  // 失败/超时终态只要同 attempt 出现过失败行，证据就必须绑定失败行；
  // 不能拿一条成功行把异常盖过去（S2 第二十五轮 P1-2）。
  const candidates = failedRows.length > 0 ? failedRows : rows
  const hashes = ev.hashes ?? {}
  const rowMatches = (r: ToolExecutionRow): boolean => {
    if (r.exit_code !== ev.exitCode) return false
    if (r.tool !== ev.tool) return false
    if ((r.stdout_hash ?? '') !== (ev.stdoutHash ?? '')) return false
    if ((r.stderr_hash ?? '') !== (ev.stderrHash ?? '')) return false
    if ((r.command_hash ?? '') !== ev.commandHash) return false
    if (hashes.stdout !== undefined && hashes.stdout !== r.stdout_hash) return false
    if (hashes.stderr !== undefined && hashes.stderr !== r.stderr_hash) return false
    return true
  }
  // 报告带了执行身份：按 execution_id 认「哪一次执行」，认不出、对不上都不许收口
  const entries = traceEntriesOf(report)
  let boundExecutionId: string | null = null
  if (entries.length > 0) {
    const entry = entries.find((e) => (
      e.tool === ev.tool
      && e.exitCode === ev.exitCode
      && (e.stdoutHash ?? '') === (ev.stdoutHash ?? '')
      && (e.stderrHash ?? '') === (ev.stderrHash ?? '')
      && (e.commandHash ?? '') === ev.commandHash
    ))
    if (!entry) return { reason: 'evidence_unverifiable' }
    const row = candidates.find((r) => r.execution_id === entry.executionId)
    if (!row) return { reason: 'evidence_unverifiable' }
    // 序号对不上就是另一条执行：回执不许改序号顶替
    if (entry.toolSeq !== null && row.tool_seq !== entry.toolSeq) return { reason: 'evidence_unverifiable' }
    if (!rowMatches(row)) return { reason: 'evidence_unverifiable' }
    boundExecutionId = row.execution_id
  } else if (!candidates.find(rowMatches)) {
    // 老上报路径没有执行身份：仍按命令名与哈希逐字段对齐（既有语义不变）
    return { reason: 'evidence_unverifiable' }
  }
  // 事件面也要对得上：只有工具执行表有行、没有 tool_finished 留痕，仍按证据不可核
  const events = tx.all<{ payload: string }>(
    "SELECT payload FROM node_run_events WHERE node_run_id = ? AND type = 'tool_finished'",
    [params.nodeRunId],
  )
  const eventMatched = events.some((event) => {
    try {
      const p = JSON.parse(event.payload) as Record<string, unknown>
      if (p.attempt !== params.attempt) return false
      if (p.tool !== ev.tool) return false
      if (p.exit_code !== ev.exitCode) return false
      if ((p.stdout_hash ?? '') !== (ev.stdoutHash ?? '')) return false
      if ((p.stderr_hash ?? '') !== (ev.stderrHash ?? '')) return false
      if ((p.command_hash ?? '') !== ev.commandHash) return false
      // 带执行身份时，事件面必须是同一个 execution_id：只对上工具名不算
      if (boundExecutionId !== null && p.execution_id !== boundExecutionId) return false
      return true
    } catch {
      return false
    }
  })
  if (!eventMatched) return { reason: 'evidence_unverifiable' }
  return { reason: null }
}