import { OrchError } from '../../core/errors.ts'
import { DECISION_PRIORITY_RANK, priorityRank } from '../../core/decision-priority.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx } from './read-tx.ts'
import { DECISION_CHOICE_COLUMNS, panelDecisionOptions, withOrdinaryRecovery, type DecisionChoiceContext, type MemoryDecisionAccess,
  type RecoveryOutcomes } from '../decision/choices.ts'
import type { OrdinaryLiveRecovery } from '../decision/ordinary-live-recovery.ts'
import type { DecisionDisplaySource } from '../../core/decision-display.ts'

const DECISIONS_LIMIT_MAX = 100
const PRIORITY_ORDER = "CASE priority " + Object.entries(DECISION_PRIORITY_RANK)
  .map(([priority, rank]) => `WHEN '${priority}' THEN ${rank}`).join(' ') + ' ELSE 0 END'
const ACTIVE_DECISIONS = "status IN ('pending','acknowledged','blocked_for_human')"
const PRIORITY_CURSOR = 'priority:'

export type DecisionView = {
  decision_id: string
  run_id: string
  node_run_id: string | null
  kind: string
  status: string
  current_revision: number
  closed_reason: string | null
  payload: unknown
  content_hash: string | null
  expires_at: string | null
  confirm_required: boolean
  created_at: string
  decided_at: string | null
  resolved_by?: string | null
  // These fields are intentionally nullable until their policy is persisted by the command layer.
  priority: string | null
  priority_reason: string | null
  allowed_resolutions: string[] | null
  resolution_unavailable_reason?: string | null
  required_evidence: string[] | null
  available_effect_evidence?: { applied?: string; not_applied?: string }
  available_recovery_outcomes?: RecoveryOutcomes
  target_summary: string | null
  task_title?: string | null
  step_title?: string | null
  attempt?: number | null
  execution_observation?: DecisionDisplaySource['execution_observation']
  approver?: string | null
  expiry_effect?: string | null
  projection_missing: string[]
}

type DecisionRow = Record<string, unknown> & DecisionChoiceContext & {
  decision_id: string
  run_id: string
  created_at: string
  node_run_id: string | null
  kind: string
  status: string
  payload_json: string
}

export type ListDecisionParams = {
  run_id?: string
  status?: string
  humanInbox?: boolean
  limit?: number
  cursor?: string
  now?: number
  memoryEnabled?: MemoryDecisionAccess
  liveRecovery?: OrdinaryLiveRecovery
}

function parsePayload(raw: unknown): { payload: unknown; missing: boolean } {
  if (typeof raw !== 'string') return { payload: null, missing: true }
  try { return { payload: JSON.parse(raw) as unknown, missing: false } } catch { return { payload: null, missing: true } }
}

const DECISION_SELECT = 'SELECT decision_id, run_id, node_run_id, kind, status, revision, closed_reason, payload_json, content_hash, '
  + 'expires_at, confirm_required, created_at, decided_at, resolved_by, priority, priority_reason, expiry_effect, approver, '
  + DECISION_CHOICE_COLUMNS + ' FROM decisions d'

function displayContext(tx: Parameters<typeof withOrdinaryRecovery>[0], row: DecisionRow,
  payload: Record<string, unknown>): Pick<DecisionView, 'task_title' | 'step_title' | 'attempt' | 'execution_observation'> {
  const context = tx.get<{ task_title: string; node_id: string | null; seq: number | null; attempt: number | null;
    doc_json: string | null }>(`SELECT t.title AS task_title,
      n.node_id, n.seq, n.attempt, w.doc_json
    FROM runs r JOIN tasks t ON t.task_id=r.task_id
    LEFT JOIN node_runs n ON n.run_id=r.run_id AND n.node_run_id=?
    LEFT JOIN workflow_versions w ON w.workflow_id=r.workflow_id AND w.version=r.workflow_version
      AND (r.workflow_definition_hash IS NULL OR w.content_hash=r.workflow_definition_hash)
    WHERE r.run_id=?`, [row.node_run_id, row.run_id])
  let stepTitle: string | null = null
  if (context?.doc_json && context.node_id) {
    try {
      const doc = JSON.parse(context.doc_json) as { nodes?: { node_id?: unknown; title?: unknown }[] } | null
      const node = Array.isArray(doc?.nodes) ? doc.nodes.find(node => node?.node_id === context.node_id) : undefined
      if (typeof node?.title === 'string' && node.title.trim()) stepTitle = node.title.trim().slice(0, 500)
    } catch { /* A missing or damaged workflow document cannot supply a step title. */ }
  }
  const recovery = payload.ordinary_recovery && typeof payload.ordinary_recovery === 'object'
    ? payload.ordinary_recovery as Record<string, unknown> : undefined
  const bound = recovery?.node_run_id === row.node_run_id && Number.isSafeInteger(recovery?.attempt)
    && Number(recovery?.attempt) > 0 && Number.isSafeInteger(recovery?.action_generation) && Number(recovery?.action_generation) >= 0
  const attempt = bound ? recovery!.attempt as number : Number.isSafeInteger(payload.report_attempt) && Number(payload.report_attempt) > 0
    ? payload.report_attempt as number : context?.attempt ?? null
  // A later attempt's observation must not change the explanation of an older, unbound decision.
  const event = bound && row.node_run_id && context?.node_id
    ? tx.get<{ payload: string }>(`SELECT payload FROM node_run_events WHERE node_run_id=?
      AND type='executor.observation_only' AND json_valid(payload)
      AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?
      ORDER BY seq DESC LIMIT 1`, [row.node_run_id, attempt, recovery!.action_generation]) : undefined
  let observation: DecisionDisplaySource['execution_observation']
  if (event) {
    const data = JSON.parse(event.payload) as Record<string, unknown>
    observation = {
      reason: data.reason === 'action_timeout' || data.reason === 'lease_lost' ? data.reason : null,
      observed_running: data.observed_running === true,
      has_tool_call: data.has_tool_call === true,
      timeout_ms: typeof data.timeout_ms === 'number' && Number.isSafeInteger(data.timeout_ms) && data.timeout_ms > 0 ? data.timeout_ms : null,
    }
  }
  const stepFallback = typeof context?.seq === 'number' && Number.isSafeInteger(context.seq) && context.seq > 0
    ? `第 ${context.seq} 步（名称未记录）` : null
  return { task_title: context?.task_title?.trim().slice(0, 500) || null, step_title: stepTitle ?? stepFallback, attempt,
    ...(observation && { execution_observation: observation }) }
}

function toDecisionView(tx: Parameters<typeof withOrdinaryRecovery>[0], row: DecisionRow, now: number,
  memoryEnabled: MemoryDecisionAccess, liveRecovery?: OrdinaryLiveRecovery): DecisionView {
  const parsed = parsePayload(row.payload_json)
  const payload = parsed.payload !== null && typeof parsed.payload === 'object' ? parsed.payload as Record<string, unknown> : {}
  const asText = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 500) : null
  const priority = asText(row.priority)
  const priorityReason = asText(row.priority_reason)
  const target = asText(payload.target_summary) ?? asText(payload.title) ?? asText(payload.summary)
  const required = Array.isArray(payload.required_evidence) ? payload.required_evidence.filter((item): item is string => typeof item === 'string').slice(0, 12) : null
  const { choices, unavailableReason } = panelDecisionOptions(withOrdinaryRecovery(tx, row, liveRecovery), now, memoryEnabled)
  return {
    decision_id: row.decision_id,
    run_id: row.run_id,
    node_run_id: typeof row.node_run_id === 'string' ? row.node_run_id : null,
    kind: String(row.kind ?? ''),
    status: String(row.status ?? ''),
    current_revision: Number(row.revision ?? 0),
    closed_reason: typeof row.closed_reason === 'string' ? row.closed_reason : null,
    payload: parsed.payload,
    content_hash: typeof row.content_hash === 'string' ? row.content_hash : null,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    confirm_required: Number(row.confirm_required ?? 0) === 1,
    created_at: row.created_at,
    decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
    resolved_by: asText(row.resolved_by),
    priority, priority_reason: priorityReason, allowed_resolutions: choices, resolution_unavailable_reason: unavailableReason,
    required_evidence: required, target_summary: target,
    ...displayContext(tx, row, payload),
    ...(row.ordinary_effect_evidence && { available_effect_evidence: row.ordinary_effect_evidence }),
    ...(row.ordinary_recovery_outcomes && { available_recovery_outcomes: row.ordinary_recovery_outcomes }),
    approver: asText(row.approver),
    // The memory approval sweep uses the card's deadline even when its task is supervised.
    expiry_effect: row.memory_approval_status != null && typeof row.expires_at === 'string'
      ? 'auto_resolve' : asText(row.expiry_effect),
    projection_missing: Object.entries({ priority, priority_reason: priorityReason,
      required_evidence: required, target_summary: target, ...(parsed.missing ? { payload: null } : {}) })
      .filter(([, value]) => value === null).map(([field]) => field),
  }
}

export function getDecisionSnapshot(db: Db, decisionId: string, now = Date.now(), memoryEnabled: MemoryDecisionAccess = false,
  liveRecovery?: OrdinaryLiveRecovery): { item: DecisionView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<DecisionRow>(
      DECISION_SELECT + ' WHERE decision_id = ?',
      [decisionId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这条决定', { decision_id: decisionId })
    return { item: toDecisionView(ctx.tx, row, now, memoryEnabled, liveRecovery), as_of_seq: ctx.as_of_seq }
  })
}

export function listDecisions(db: Db, params: ListDecisionParams = {}): {
  items: DecisionView[]
  next_cursor: string | null
  as_of_seq: number
} {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > DECISIONS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(DECISIONS_LIMIT_MAX) + ' 条', { limit })
  const filter = { run_id: params.run_id ?? null, status: params.status ?? null,
    ...(params.humanInbox ? { inbox: 'human' } : {}) }
  const now = params.now ?? Date.now()
  const cursor = params.cursor ? decodeCursor(params.cursor, 'decisions', filter, now) : undefined
  if (cursor && (typeof cursor.last_key !== 'string' || typeof cursor.last_id !== 'string')) {
    throw new OrchError('CURSOR_EXPIRED', '审批游标缺少排序位置，请刷新列表')
  }
  // An issued chronological cursor must finish in its original order to avoid duplicates and omissions.
  const byPriority = !cursor || cursor.last_key.startsWith(PRIORITY_CURSOR)
  return withReadTx(db, (ctx) => {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.run_id) { where.push('run_id = ?'); values.push(filter.run_id) }
    if (filter.status) { where.push('status = ?'); values.push(filter.status) }
    else {
      where.push(ACTIVE_DECISIONS)
    }
    if (params.humanInbox) {
      where.push('EXISTS (SELECT 1 FROM human_decision_inbox WHERE decision_id = d.decision_id)')
    }
    if (cursor && byPriority) {
      const match = /^priority:(\d{1,3}):(.+)$/.exec(cursor.last_key)
      const rank = Number(match?.[1])
      if (!match || (rank !== 0 && !Object.values<number>(DECISION_PRIORITY_RANK).includes(rank))) {
        throw new OrchError('CURSOR_EXPIRED', '审批游标缺少排序位置，请刷新列表')
      }
      where.push(`((${PRIORITY_ORDER}) < ? OR ((${PRIORITY_ORDER}) = ? AND (created_at, decision_id) > (?, ?)))`)
      values.push(rank, rank, match[2], cursor.last_id)
    } else if (cursor) {
      where.push('(created_at, decision_id) < (?, ?)')
      values.push(cursor.last_key, cursor.last_id)
    }
    const rows = ctx.tx.all<DecisionRow>(
      DECISION_SELECT
      + ' WHERE ' + where.join(' AND ')
      + ' ORDER BY ' + (byPriority ? PRIORITY_ORDER + ' DESC, created_at, decision_id' : 'created_at DESC, decision_id DESC')
      + ' LIMIT ?',
      [...values, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    const next_cursor = hasMore && last
      ? encodeCursor(makeCursor('decisions', filter,
        byPriority ? `${PRIORITY_CURSOR}${priorityRank(last.priority)}:${last.created_at}` : last.created_at, last.decision_id, ctx.as_of_seq, now))
      : null
    return { items: page.map((row) => toDecisionView(ctx.tx, row, now, params.memoryEnabled ?? false, params.liveRecovery)), next_cursor, as_of_seq: ctx.as_of_seq }
  })
}
