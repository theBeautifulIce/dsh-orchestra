// src/service/commands/apply-report.ts —— applyReport 六步收口（规格 4.2 行 286-305）
import { OrchError } from '../../core/errors.ts'
import { isReportRegistryState, type ApplyResult, type Report } from '../../core/report.ts'
import type { PassCondition } from '../../core/policy.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { runCas } from '../../infra/db/tx.ts'
import { appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { assertLeaseValid, loadNodeRun, type NodeRunRow } from './lease.ts'
import { evaluateEvidence, evaluatePassConditions } from '../../core/policy.ts'
import { canTransition } from '../../core/state-machine.ts'

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

// 六步固定顺序，全部在同一笔 BEGIN IMMEDIATE 事务里（规格 4.2 行 294-300）
export function applyReport(
  tx: Tx,
  secret: string,
  params: ApplyReportParams,
  policy: ApplyPolicy,
): ApplyResult {
  const report = params.report
  // 第一步：幂等查重
  const existing = readRegistry(tx, report.report_id)
  if (existing) {
    if (!isReportRegistryState(existing.state)) {
      throw new OrchError('STALE_GENERATION', 'registry 状态不在枚举里', { state: existing.state })
    }
    if (existing.state === 'applied') {
      // 已经落过账：不许再落一次，只把状态记成 replayed
      tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
        report_id: report.report_id,
        report_seq: existing.report_seq,
        reason: 'already_applied',
      })
      return { accepted: false, reason: 'already_applied', registry_state: 'replayed' }
    }
    if (existing.state === 'replayed') {
      appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
        report_id: report.report_id,
        report_seq: existing.report_seq,
        reason: 'already_replayed',
      })
      return { accepted: false, reason: 'already_replayed', registry_state: 'replayed' }
    }
    // 已 rejected 的走重放路径：先验哈希链，再把状态推到 replayed，继续往下走
    const chainOk = tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = ?',
      [params.nodeRunId],
    )
    if (!chainOk || chainOk.n === 0) {
      throw new OrchError('STALE_GENERATION', '重放前哈希链为空，链路不完整', { nodeRunId: params.nodeRunId })
    }
    tx.run('UPDATE report_registry SET state = ?, updated_at = ? WHERE report_id = ?', ['replayed', params.now, report.report_id])
    appendNodeRunEvent(tx, secret, params.nodeRunId, 'report_replayed', {
      report_id: report.report_id,
      report_seq: existing.report_seq,
      reason: 'replay_after_reject',
    })
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
  if (row.attempt !== params.attempt) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'attempt_mismatch', now: params.now })
  }
  if (row.status !== params.expectedStatus) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'status_mismatch', now: params.now })
  }
  if (row.action_generation !== params.generation) {
    // 动作代对不上：旧执行器的写，按过期写拒
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'generation_mismatch', now: params.now })
  }
  assertLeaseValid(row, params.now)
  // 目标状态必须在合法迁移表里：非法迁移按拒绝处理，不许绕过状态机
  if (!canTransition(row.status, report.status)) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: 'illegal_transition', now: params.now })
  }
  // 第四步：证据评估
  const evidence = evaluateEvidence(report, policy.requiredHashes ?? [])
  if (!evidence.ok) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: evidence.reason ?? 'evidence_rejected', now: params.now })
  }
  // 第五步：按模板判定规则求值
  const verdict = evaluatePassConditions(policy.passConditions, evidence.normalized)
  if (!verdict.pass) {
    return rejectReport(tx, secret, { nodeRunId: params.nodeRunId, attempt: params.attempt, report, reportSeq, reason: verdict.reason ?? 'verdict_unmet', now: params.now })
  }
  // 第六步：节点 CAS + registry 标 applied + 哈希链留痕
  runCas(
    tx,
    'UPDATE node_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE node_run_id = ? AND status = ? AND attempt = ? AND action_generation = ?',
    [report.status, params.now, params.nodeRunId, params.expectedStatus, params.attempt, params.generation],
    { rows: 1, what: 'applyReport-node' },
  )
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
    evidence_digest: evidence.digest,
  })
  return { accepted: true, next_status: report.status, registry_state: 'applied' }
}
