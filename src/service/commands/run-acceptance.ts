// src/service/commands/run-acceptance.ts —— 交付验收阶段（审计 P1-05）
//
// 口径：执行终态与交付验收是两件事。
// - 验收阶段只读执行事实（artifacts / artifact_contents / tool_executions / node_runs）；
// - 只写 run_acceptance_results 与 tasks.display_status；
// - 绝不改写 runs.status / node_runs.status / events / artifacts / tool_executions；
// - 没有已确认计划的任务（通用 Workflow Run）判 not_applicable，不写任何验收行。
import { canonicalJson, sha256Hex } from '../../core/canonical.ts'
import { uuidv7 } from '../../core/ids.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'

export type AcceptanceOutcome = 'passed' | 'failed' | 'unverifiable'
export type AcceptanceSummary = AcceptanceOutcome | 'not_applicable'
export type AcceptanceKind = 'artifact' | 'tool_evidence' | 'chat/text_result'

/** 验收失败与验收待核验要分开说：前者是交付不达标，后者是证据不足。 */
export const ACCEPTANCE_DISPLAY_STATUS = {
  failed: '交付验收失败',
  unverifiable: '交付待核验',
} as const

export type DeliverableResult = {
  deliverable_key: string
  title: string
  node_id: string
  kind: AcceptanceKind | 'unknown'
  outcome: AcceptanceOutcome
  reason: string | null
  rule_version: string
  evidence: Record<string, unknown>
}

export type RunAcceptanceReport = {
  outcome: AcceptanceSummary
  plan_id: string | null
  content_hash: string | null
  results: DeliverableResult[]
}

type PlanRow = { plan_id: string; content_hash: string; proposal_json: string }

type ArtifactRow = {
  artifact_id: string
  sha256: string
  retain_until: string | null
  file_name: string
  content_node_run_id: string | null
  bytes: number
  node_id: string | null
  node_run_run_id: string | null
}

type ToolRow = {
  execution_id: string
  node_run_id: string
  attempt: number
  tool: string
  exit_code: number
  finished_at: string | null
}

type ParsedDeliverable = {
  title: string
  node_id: string
  kind: AcceptanceKind | 'unknown'
  rule: Record<string, unknown>
  parse_error: string | null
}

type HistoryEntry = { outcome: string; evaluated_at: string; evidence_digest: string }

// 计划与运行的连接口径与 task-planning / task-trigger-dispatch 一致：
// start_run_operations.operation_id = task_plans.launch_operation_id，再取 run_id
const PLAN_LOOKUP = 'SELECT p.plan_id AS plan_id, p.content_hash AS content_hash, p.proposal_json AS proposal_json '
  + 'FROM task_plans p JOIN start_run_operations o ON o.operation_id = p.launch_operation_id '
  + 'WHERE o.run_id = ? ORDER BY p.created_at ASC, p.plan_id ASC LIMIT 1'

const ARTIFACT_LOOKUP = 'SELECT a.artifact_id AS artifact_id, a.sha256 AS sha256, a.retain_until AS retain_until, '
  + 'c.file_name AS file_name, c.node_run_id AS content_node_run_id, length(c.bytes) AS bytes, '
  + 'n.node_id AS node_id, n.run_id AS node_run_run_id '
  + 'FROM artifacts a JOIN artifact_contents c ON c.artifact_id = a.artifact_id '
  + 'LEFT JOIN node_runs n ON n.node_run_id = c.node_run_id '
  + 'WHERE a.run_id = ? AND c.file_name = ? AND n.replacement_node_run_id IS NULL'

const TOOL_LOOKUP = 'SELECT t.execution_id AS execution_id, t.node_run_id AS node_run_id, t.attempt AS attempt, '
  + 't.tool AS tool, t.exit_code AS exit_code, t.finished_at AS finished_at '
  + 'FROM tool_executions t JOIN node_runs n ON n.node_run_id = t.node_run_id '
  + 'WHERE n.run_id = ? AND n.node_id = ? AND t.tool = ? AND n.replacement_node_run_id IS NULL AND t.attempt=n.attempt ORDER BY t.tool_seq ASC'

const ACCEPTANCE_ROW_LOOKUP = 'SELECT evidence_json FROM run_acceptance_results '
  + 'WHERE run_id = ? AND plan_id = ? AND content_hash = ? AND deliverable_key = ?'

/** 汇总优先级：失败 > 待核验 > 通过。 */
function summarize(results: DeliverableResult[]): AcceptanceSummary {
  if (results.length === 0) return 'unverifiable'
  if (results.some((item) => item.outcome === 'failed')) return 'failed'
  if (results.some((item) => item.outcome === 'unverifiable')) return 'unverifiable'
  return 'passed'
}

function rank(outcome: AcceptanceOutcome): number {
  if (outcome === 'passed') return 3
  if (outcome === 'failed') return 2
  return 1
}

/** 交付项主键：node_id + 标题，同名重复时补序号，保证稳定可重放且不撞唯一键。 */
function deliverableKeys(items: ParsedDeliverable[]): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = item.node_id + '|' + item.title
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : base + '#' + String(count + 1)
  })
}

function parseDeliverable(entry: unknown): ParsedDeliverable {
  const fallback: ParsedDeliverable = { title: '', node_id: '', kind: 'unknown', rule: {}, parse_error: 'deliverable_not_object' }
  if (typeof entry !== 'object' || entry === null) return fallback
  const raw = entry as { title?: unknown; node_id?: unknown; acceptance?: unknown }
  const title = typeof raw.title === 'string' ? raw.title : ''
  const nodeId = typeof raw.node_id === 'string' ? raw.node_id : ''
  const rule = typeof raw.acceptance === 'object' && raw.acceptance !== null
    ? raw.acceptance as Record<string, unknown>
    : {}
  const kind: AcceptanceKind | 'unknown' = rule.kind === 'artifact' || rule.kind === 'tool_evidence' || rule.kind === 'chat/text_result'
    ? rule.kind
    : 'unknown'
  let parseError: string | null = null
  if (title === '') parseError = 'deliverable_title_missing'
  else if (nodeId === '') parseError = 'deliverable_node_id_missing'
  else if (kind === 'unknown') parseError = 'acceptance_kind_unknown'
  else if (kind === 'artifact' && (typeof rule.file_name !== 'string' || rule.file_name === '')) parseError = 'acceptance_file_name_missing'
  else if (kind === 'artifact' && (typeof rule.minimum_bytes !== 'number' || !Number.isFinite(rule.minimum_bytes))) {
    parseError = 'acceptance_minimum_bytes_missing'
  } else if (kind === 'tool_evidence' && (typeof rule.tool !== 'string' || rule.tool === '')) parseError = 'acceptance_tool_missing'
  return { title, node_id: nodeId, kind, rule, parse_error: parseError }
}

/** 解析计划里的交付物：结构不符合预期不崩，记 unverifiable 并写明原因。 */
function parseDeliverables(proposalJson: string): { items: ParsedDeliverable[] | null; reason: string | null } {
  let proposal: unknown
  try {
    proposal = JSON.parse(proposalJson)
  } catch {
    return { items: null, reason: 'proposal_json_unparsable' }
  }
  if (typeof proposal !== 'object' || proposal === null) return { items: null, reason: 'proposal_json_not_object' }
  const raw = (proposal as { deliverables?: unknown }).deliverables
  if (!Array.isArray(raw)) return { items: null, reason: 'deliverables_missing' }
  return { items: raw.map((entry) => parseDeliverable(entry)), reason: null }
}

function evaluateArtifact(
  tx: Tx,
  runId: string,
  now: string,
  item: ParsedDeliverable,
  deliverableKey: string,
  ruleVersion: string,
): DeliverableResult {
  const fileName = String(item.rule.file_name)
  const minimumBytes = Number(item.rule.minimum_bytes)
  const base = {
    deliverable_key: deliverableKey,
    title: item.title,
    node_id: item.node_id,
    kind: 'artifact' as const,
    rule_version: ruleVersion,
  }
  const rows = tx.all<ArtifactRow>(ARTIFACT_LOOKUP, [runId, fileName])
  if (rows.length === 0) {
    return {
      ...base,
      outcome: 'unverifiable',
      reason: 'artifact_not_registered',
      evidence: { file_name: fileName, minimum_bytes: minimumBytes, matches: 0 },
    }
  }
  const owned = rows.filter((row) => row.node_run_run_id === runId && row.node_id === item.node_id)
  if (owned.length === 0) {
    const unbound = rows.filter((row) => row.content_node_run_id === null).length
    const outcome: AcceptanceOutcome = unbound > 0 ? 'unverifiable' : 'failed'
    return {
      ...base,
      outcome,
      reason: unbound > 0 ? 'artifact_source_node_unbound' : 'artifact_source_node_mismatch',
      evidence: {
        file_name: fileName,
        minimum_bytes: minimumBytes,
        matches: rows.length,
        owned: 0,
        candidates: rows.map((row) => ({
          artifact_id: row.artifact_id,
          node_run_id: row.content_node_run_id,
          node_id: row.node_id,
          bytes: Number(row.bytes ?? 0),
        })),
      },
    }
  }
  const verdicts = owned.map((row) => {
    const bytes = Number(row.bytes ?? 0)
    const expired = row.retain_until !== null && Date.parse(row.retain_until) <= Date.parse(now)
    const outcome: AcceptanceOutcome = bytes < minimumBytes ? 'failed' : expired ? 'unverifiable' : 'passed'
    const reason = bytes < minimumBytes ? 'artifact_below_minimum_bytes' : expired ? 'artifact_retain_until_expired' : null
    return { row, bytes, expired, outcome, reason }
  })
  const best = verdicts.reduce((a, b) => (rank(b.outcome) > rank(a.outcome) ? b : a))
  return {
    ...base,
    outcome: best.outcome,
    reason: best.reason,
    evidence: {
      file_name: fileName,
      minimum_bytes: minimumBytes,
      matches: rows.length,
      owned: owned.length,
      artifact_id: best.row.artifact_id,
      sha256: best.row.sha256,
      bytes: best.bytes,
      node_run_id: best.row.content_node_run_id,
      node_id: best.row.node_id,
      retain_until: best.row.retain_until,
      expired: best.expired,
    },
  }
}

function evaluateToolEvidence(
  tx: Tx,
  runId: string,
  item: ParsedDeliverable,
  deliverableKey: string,
  ruleVersion: string,
): DeliverableResult {
  const tool = String(item.rule.tool)
  const expectedExitCode = typeof item.rule.exit_code === 'number' ? item.rule.exit_code : 0
  const base = {
    deliverable_key: deliverableKey,
    title: item.title,
    node_id: item.node_id,
    kind: 'tool_evidence' as const,
    rule_version: ruleVersion,
  }
  const rows = tx.all<ToolRow>(TOOL_LOOKUP, [runId, item.node_id, tool])
  if (rows.length === 0) {
    return {
      ...base,
      outcome: 'unverifiable',
      reason: 'tool_evidence_missing',
      evidence: { tool, node_id: item.node_id, expected_exit_code: expectedExitCode, executions: 0 },
    }
  }
  const matched = rows.find((row) => Number(row.exit_code) === expectedExitCode)
  return {
    ...base,
    outcome: matched ? 'passed' : 'failed',
    reason: matched ? null : 'tool_exit_code_mismatch',
    evidence: {
      tool,
      node_id: item.node_id,
      expected_exit_code: expectedExitCode,
      executions: rows.length,
      matched_execution_id: matched ? matched.execution_id : null,
      exit_codes: rows.map((row) => Number(row.exit_code)),
    },
  }
}

function evaluateDeliverable(
  tx: Tx,
  runId: string,
  now: string,
  item: ParsedDeliverable,
  deliverableKey: string,
): DeliverableResult {
  const ruleVersion = sha256Hex(canonicalJson(item.rule))
  if (item.parse_error !== null) {
    return {
      deliverable_key: deliverableKey,
      title: item.title,
      node_id: item.node_id,
      kind: item.kind,
      outcome: 'unverifiable',
      reason: item.parse_error,
      rule_version: ruleVersion,
      evidence: { rule: item.rule },
    }
  }
  if (item.kind === 'artifact') return evaluateArtifact(tx, runId, now, item, deliverableKey, ruleVersion)
  if (item.kind === 'chat/text_result') {
    // 会话结果已落成真实 UTF-8 文件（chat-result.md）时可自动核验，否则如实说不能（P05）。
    const file = tx.get<{ artifact_id: string; sha256: string }>(
      `SELECT a.artifact_id, a.sha256 FROM artifacts a JOIN artifact_contents c USING(artifact_id)
        WHERE a.run_id = ? AND c.file_name = 'chat-result.md' ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT 1`, [runId],
    )
    return {
      deliverable_key: deliverableKey,
      title: item.title,
      node_id: item.node_id,
      kind: 'chat/text_result',
      rule_version: ruleVersion,
      outcome: file ? 'passed' : 'unverifiable',
      reason: file ? null : 'chat_text_result_not_exported',
      evidence: file
        ? { artifact_id: file.artifact_id, sha256: file.sha256, note: '会话结果已导出为 chat-result.md' }
        : { title: item.title, note: '会话结果尚未导出为可下载的 UTF-8 文件' },
    }
  }
  return evaluateToolEvidence(tx, runId, item, deliverableKey, ruleVersion)
}

/**
 * 只读地评一遍交付物：不做任何写入。
 * 没有已确认计划的任务（通用 Workflow Run）判 not_applicable，plan_id / content_hash 为空。
 */
export function evaluateRunAcceptance(tx: Tx, runId: string, now: string): RunAcceptanceReport {
  const plan = tx.get<PlanRow>(PLAN_LOOKUP, [runId])
  if (!plan) return { outcome: 'not_applicable', plan_id: null, content_hash: null, results: [] }
  const parsed = parseDeliverables(plan.proposal_json)
  if (parsed.items === null) {
    // 计划结构本身不可解析：整体记待核验，但不产出交付物行（表结构按交付物粒度）
    return { outcome: 'unverifiable', plan_id: plan.plan_id, content_hash: plan.content_hash, results: [] }
  }
  const keys = deliverableKeys(parsed.items)
  const results = parsed.items.map((item, index) => evaluateDeliverable(tx, runId, now, item, keys[index] ?? ''))
  return { outcome: summarize(results), plan_id: plan.plan_id, content_hash: plan.content_hash, results }
}

function readHistory(evidenceJson: string | null): HistoryEntry[] {
  if (!evidenceJson) return []
  try {
    const parsed = JSON.parse(evidenceJson) as { history?: unknown }
    if (!Array.isArray(parsed.history)) return []
    return parsed.history.filter((item): item is HistoryEntry => {
      if (typeof item !== 'object' || item === null) return false
      const row = item as { outcome?: unknown; evaluated_at?: unknown; evidence_digest?: unknown }
      return typeof row.outcome === 'string' && typeof row.evaluated_at === 'string' && typeof row.evidence_digest === 'string'
    })
  } catch {
    return []
  }
}

/** 落库：同一 (run_id, plan_id, content_hash, deliverable_key) 重放只更新同一行。 */
function persistResults(
  tx: Tx,
  runId: string,
  planId: string,
  contentHash: string,
  results: DeliverableResult[],
  now: string,
): void {
  for (const result of results) {
    if (result.kind === 'unknown') continue
    const evidenceDigest = sha256Hex(canonicalJson(result.evidence))
    const existing = tx.get<{ evidence_json: string }>(ACCEPTANCE_ROW_LOOKUP, [runId, planId, contentHash, result.deliverable_key])
    const history = readHistory(existing?.evidence_json ?? null)
    const entry: HistoryEntry = { outcome: result.outcome, evaluated_at: now, evidence_digest: evidenceDigest }
    const evidenceJson = JSON.stringify({ evidence: result.evidence, history: history.concat([entry]) })
    tx.run(
      'INSERT INTO run_acceptance_results (result_id, run_id, plan_id, content_hash, rule_version, deliverable_key, '
      + 'kind, outcome, reason, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(run_id, plan_id, content_hash, deliverable_key) DO UPDATE SET '
      + 'rule_version = excluded.rule_version, kind = excluded.kind, outcome = excluded.outcome, reason = excluded.reason, '
      + 'evidence_json = excluded.evidence_json, evaluated_at = excluded.evaluated_at',
      [
        uuidv7(),
        runId,
        planId,
        contentHash,
        result.rule_version,
        result.deliverable_key,
        result.kind,
        result.outcome,
        result.reason,
        evidenceJson,
        now,
      ],
    )
  }
}

/** run 自身失败时以执行失败为准，验收阶段不覆盖展示状态。 */
function runFailed(tx: Tx, runId: string): boolean {
  const row = tx.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', [runId])
  const status = row?.status ?? ''
  return status === 'failed' || status === 'failed_with_unverified'
}

/** 任务展示状态：验收失败与待核验各有文案，通过时不覆盖别人的展示状态。 */
function updateTaskDisplay(tx: Tx, runId: string, outcome: AcceptanceSummary, now: string): void {
  // 执行已经失败时以执行失败为准：别把「运行失败」显示成「交付待核验」
  if (runFailed(tx, runId)) return
  if (outcome === 'failed') {
    tx.run(
      'UPDATE tasks SET display_status = ?, updated_at = ?, revision = revision + 1 WHERE current_run_id = ?',
      [ACCEPTANCE_DISPLAY_STATUS.failed, now, runId],
    )
    return
  }
  if (outcome === 'unverifiable') {
    tx.run(
      'UPDATE tasks SET display_status = ?, updated_at = ?, revision = revision + 1 WHERE current_run_id = ?',
      [ACCEPTANCE_DISPLAY_STATUS.unverifiable, now, runId],
    )
    return
  }
  if (outcome === 'passed') {
    // 只清掉验收阶段自己写过的标签，别动别的展示状态
    tx.run(
      'UPDATE tasks SET display_status = NULL, updated_at = ?, revision = revision + 1 '
      + 'WHERE current_run_id = ? AND display_status IN (?, ?)',
      [now, runId, ACCEPTANCE_DISPLAY_STATUS.failed, ACCEPTANCE_DISPLAY_STATUS.unverifiable],
    )
  }
}

/**
 * 验收阶段入口：评一遍、落一行结论、按结论改任务展示状态。
 * 幂等：同一 run 重放只更新同一行结论，不新增行，也不碰任何执行事实。
 */
export function applyRunAcceptance(tx: Tx, runId: string, now: string): RunAcceptanceReport {
  const report = evaluateRunAcceptance(tx, runId, now)
  if (report.outcome === 'not_applicable' || report.plan_id === null || report.content_hash === null) return report
  persistResults(tx, runId, report.plan_id, report.content_hash, report.results, now)
  updateTaskDisplay(tx, runId, report.outcome, now)
  return report
}
