// src/service/commands/apply-report.ts —— applyReport 六步收口（规格 4.2 行 286-305）
import { OrchError } from '../../core/errors.ts'
import { isReportRegistryState, type ApplyResult, type Report } from '../../core/report.ts'
import type { PassCondition } from '../../core/policy.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { transitionNode } from './node-state.ts'
import { assertLeaseValid, loadNodeRun, type NodeRunRow } from './lease.ts'
import { chainBreakOf, readChain } from '../../infra/db/ledger.ts'
import { evaluateEvidence, evaluatePassConditions } from '../../core/policy.ts'
import { canTransition } from '../../core/state-machine.ts'
import type { WorkflowCatalog } from '../workflows.ts'

export type ApplyReportParams = {
  nodeRunId: string
  attempt: number
  report: Report
  expectedStatus: string
  // 动作代：执行器回写时带自己看到的 Ga，对不上就是过期写（规格 4.3 行 309）
  generation: number
  now: string
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

// 同一个 report_id 的同类事件只留一条：账本不许被重试刷膨胀（审计 R3-04）
function hasNodeRunEvent(tx: Tx, nodeRunId: string, type: string, reportId: string): boolean {
  const row = tx.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ? AND payload LIKE ?",
    [nodeRunId, type, '%"report_id":"' + reportId + '"%'],
  )
  return (row?.n ?? 0) > 0
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
    const dup = tx.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ? AND type = ? AND payload LIKE ? AND payload LIKE ?",
      [params.nodeRunId, 'report_rejected', '%"report_id":"' + params.report.report_id + '"%', '%"reason":"' + params.reason + '"%'],
    )
    if ((dup?.n ?? 0) > 0) {
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
  })
  return { accepted: false, reason: params.reason, registry_state: 'rejected' }
}

// 判定条件由服务端按 run 绑定的工作流版本取：调用方传不进来，执行器也改不了（规格 4.2 行 293、6.1 行 839）
function policyForReport(tx: Tx, row: NodeRunRow, catalog: WorkflowCatalog): ApplyPolicy {
  const run = tx.get<{ workflow_version: number | string | null; workflow_definition_hash: string | null }>(
    'SELECT workflow_version, workflow_definition_hash FROM runs WHERE run_id = ?',
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
  const current = catalog.definitionHash(run.workflow_version)
  if (current !== run.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', 'run 绑定的工作流定义与当前版本不一致，判定条件不许中途换', {
      nodeRunId: row.node_run_id,
      workflow_version: String(run.workflow_version),
      bound: run.workflow_definition_hash,
      current,
    })
  }
  return catalog.policyFor(run.workflow_version, row.node_id)
}

// 六步固定顺序，全部在同一笔 BEGIN IMMEDIATE 事务里（规格 4.2 行 294-300）
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
  if (!canTransition(row.status, report.status)) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'illegal_transition', now: params.now })
  }
  // 第四、五步只对“完成”上报做证据与判定：失败、阻塞的回报不该被要求带通过证据
  let evidenceDigest: string | null = null
  if (report.status === 'done') {
    // 判定条件只从 run 绑定的工作流版本取，不在请求体、也不在函数参数里（规格 4.2 行 293）
    const policy = policyForReport(tx, row, catalog)
    // 证据强度先按模板要求校验：不可逆节点只给 exitCode 不许收口（规格 4.7 行 380）
    const evidence = evaluateEvidence(report, policy.requiredHashes ?? [])
    if (!evidence.ok) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: evidence.reason ?? 'evidence_rejected', now: params.now })
    }
    // 系统级证据门：弱证据、工具失败都不许直落 done（审计 R3-03）
    const systemReason = systemEvidenceGate(report)
    if (systemReason) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: systemReason, now: params.now })
    }
    // 判定条件：模板条件是基线，节点只能追加更严的条件（规格 4.7 行 390）
    const verdict = evaluatePassConditions(policy.passConditions, evidence.normalized)
    if (!verdict.pass) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: verdict.reason ?? 'verdict_unmet', now: params.now })
    }
    // 证据要跟账本里的工具执行痕迹对得上：伪造的 done 与真跑出来的 done 分得开（审计 R3-03）
    const bindReason = traceBindingGate(tx, params, report)
    if (bindReason) {
      return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: bindReason, now: params.now })
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

// 痕迹绑定门：证据要跟账本里的工具执行痕迹对得上，伪造的 done 与真跑出来的 done 分得开（审计 R3-03）
function traceBindingGate(tx: Tx, params: ApplyReportParams, report: Report): string | null {
  const ev = report.evidence
  if (!ev) return 'evidence_missing'
  const rows = tx.all<{ exit_code: number; stdout_hash: string | null }>(
    'SELECT exit_code, stdout_hash FROM tool_executions WHERE node_run_id = ? AND attempt = ?',
    [params.nodeRunId, params.attempt],
  )
  const matched = rows.some((r) => r.exit_code === ev.exitCode && (r.stdout_hash ?? '') === (ev.stdoutHash ?? ''))
  if (!matched) return 'evidence_unverifiable'
  return null
}