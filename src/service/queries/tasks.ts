import { OrchError } from '../../core/errors.ts'
import { readReleaseGateCard, type ReleaseGateCardState } from '../release-workflow.ts'
import type { TaskLane, TaskOrigin } from '../../core/task-workspace.ts'
import type { Autonomy } from '../runs.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { UNVERIFIED_EFFECT } from '../../infra/db/unverified-effects.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { attentionWeight, deriveAttention, maxSideEffectLevel, DELIVERY_ACCEPTANCE, type Attention, type DeliveryAcceptance, type SideEffectLevel } from './attention.ts'
import { withReadTx } from './read-tx.ts'

const TASKS_LIMIT_MAX = 100

export type TaskSummary = {
  task_id: string
  title: string
  workflow_id: string | null
  workflow_version: number | null
  status: string
  display_status: string
  current_run_id: string | null
  session_id: string | null
  run_count: number
  open_decision_count: number
  oldest_open_decision_age_seconds: number | null
  unverified_count: number
  max_side_effect_level: SideEffectLevel | null
  max_heartbeat_age_ms: number | null
  attention: Attention
  attention_reason: string | null
  updated_at: string
  archived_at: string | null
  trigger_kind: TaskOrigin | null
  next_trigger_at?: string | null
  trigger_enabled?: boolean | null
  autonomy: Autonomy
  lane?: TaskLane
  current_run_status: string | null
  delivery_acceptance?: DeliveryAcceptance
  goal_met?: boolean
}

/** 验收结论取值由 SQL 汇总；脏数据一律回落到 not_applicable，视图不因它崩。 */
function deliveryAcceptanceOf(value: unknown): DeliveryAcceptance {
  const raw = value === null || value === undefined ? 'not_applicable' : String(value)
  return (DELIVERY_ACCEPTANCE as readonly string[]).includes(raw)
    ? (raw as DeliveryAcceptance)
    : 'not_applicable'
}

export type ListTaskParams = {
  status?: string
  attention?: Attention
  query?: string
  lane?: TaskLane
  trigger_kind?: TaskOrigin | 'unknown'
  archived?: boolean
  updated_from?: string
  updated_before?: string
  limit?: number
  cursor?: string
  now?: number
}

type TaskRow = Record<string, unknown> & {
  task_id: string
  updated_at: string
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function taskSummary(row: TaskRow, now: number): TaskSummary {
  const currentRunStatus = nullableString(row.current_run_status)
  const openDecisionCount = Number(row.open_decision_count ?? 0)
  const unverifiedCount = Number(row.unverified_count ?? 0)
  const orphanedNodeCount = Number(row.orphaned_node_count ?? 0)
  const oldestDecisionAt = nullableString(row.oldest_open_decision_at)
  const oldestDecisionAge = oldestDecisionAt === null
    ? null
    : Math.max(0, Math.floor((now - Date.parse(oldestDecisionAt)) / 1000))
  const heartbeatAt = nullableString(row.oldest_active_heartbeat_at)
  const heartbeatAge = heartbeatAt === null ? null : Math.max(0, now - Date.parse(heartbeatAt))
  const sideEffectLevels = String(row.side_effect_levels ?? '').split(',').filter(Boolean)
  const taskStatus = String(row.status ?? '')
  const deliveryAcceptance = deliveryAcceptanceOf(row.delivery_acceptance)
  // 有已确认计划时，目标达成看验收汇总（必需交付项必须全部 passed），不能只看 run 终态
  const goalMet = deliveryAcceptance === 'not_applicable'
    ? taskStatus === 'succeeded' || taskStatus === 'succeeded_with_unverified'
    : deliveryAcceptance === 'passed'
  const attention = deriveAttention({
    openDecisionCount,
    oldestOpenDecisionAgeSeconds: oldestDecisionAge,
    unverifiedCount,
    currentRunStatus,
    orphanedNodeCount,
    taskStatus,
    deliveryAcceptance,
  })

  return {
    task_id: String(row.task_id),
    title: String(row.title ?? ''),
    workflow_id: nullableString(row.workflow_id),
    workflow_version: nullableNumber(row.workflow_version),
    status: taskStatus,
    display_status: String(row.display_status ?? taskStatus),
    current_run_id: nullableString(row.current_run_id),
    session_id: nullableString(row.session_id),
    run_count: Number(row.run_count ?? 0),
    open_decision_count: openDecisionCount,
    oldest_open_decision_age_seconds: oldestDecisionAge,
    unverified_count: unverifiedCount,
    max_side_effect_level: maxSideEffectLevel(sideEffectLevels),
    max_heartbeat_age_ms: heartbeatAge,
    attention: attention.attention,
    attention_reason: attention.attention_reason,
    updated_at: String(row.updated_at),
    archived_at: nullableString(row.archived_at),
    trigger_kind: row.trigger_kind as TaskOrigin | null,
    next_trigger_at: nullableString(row.next_trigger_at),
    trigger_enabled: row.trigger_enabled === null || row.trigger_enabled === undefined ? null : row.trigger_enabled === 1,
    autonomy: row.autonomy as Autonomy,
    lane: row.lane as TaskLane,
    current_run_status: currentRunStatus,
    delivery_acceptance: deliveryAcceptance,
    goal_met: goalMet,
  }
}

const OPEN_DECISIONS = `FROM decisions d WHERE d.run_id = t.current_run_id
  AND d.status IN ('pending','acknowledged','blocked_for_human')`
const UNVERIFIED_NODES = `FROM node_runs n WHERE n.run_id = t.current_run_id AND ${UNVERIFIED_EFFECT}`
const ORPHANED_NODES = `FROM node_runs n WHERE n.run_id = t.current_run_id
  AND n.status = 'orphaned' AND n.replacement_node_run_id IS NULL`
const RUN_ACCEPTANCE = `FROM run_acceptance_results a WHERE a.run_id = t.current_run_id`
const CURRENT_RUN_JOINS = `LEFT JOIN runs r ON r.run_id = t.current_run_id
  LEFT JOIN task_triggers tr ON tr.task_id = t.task_id`
// Hydrate only the materialized page while keeping the rank, counts and event waterline in the same read snapshot.
const TASK_SUMMARY_SELECT = `SELECT t.task_id, t.title, t.workflow_id, t.workflow_version, t.status, t.display_status,
  t.current_run_id, t.session_id, t.updated_at, t.archived_at, t.trigger_kind, t.autonomy,
  tr.next_fire_at AS next_trigger_at, tr.enabled AS trigger_enabled, r.status AS current_run_status, p.lane, p.sort_at, p.sort_weight,
  (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.task_id) AS run_count,
  CASE
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE} AND a.outcome = 'failed') THEN 'failed'
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE} AND a.outcome = 'unverifiable') THEN 'unverifiable'
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE}) THEN 'passed'
    WHEN EXISTS (SELECT 1 FROM start_run_operations o JOIN task_plans plan
      ON plan.launch_operation_id = o.operation_id WHERE o.task_id = t.task_id AND o.run_id = t.current_run_id) THEN 'pending'
    ELSE 'not_applicable'
  END AS delivery_acceptance,
  (SELECT COUNT(*) ${OPEN_DECISIONS}) AS open_decision_count,
  (SELECT MIN(d.created_at) ${OPEN_DECISIONS}) AS oldest_open_decision_at,
  (SELECT COUNT(*) ${UNVERIFIED_NODES}) AS unverified_count,
  (SELECT COUNT(*) ${ORPHANED_NODES}) AS orphaned_node_count,
  (SELECT GROUP_CONCAT(DISTINCT n.side_effect_policy) FROM node_runs n WHERE n.run_id = t.current_run_id) AS side_effect_levels,
  (SELECT MIN(n.heartbeat_at) FROM node_runs n WHERE n.run_id = t.current_run_id
    AND n.heartbeat_at IS NOT NULL AND n.status NOT IN ('done','failed','timeout','abandoned_unverified',
      'failed_with_unverified','orphaned','superseded','cancelled')) AS oldest_active_heartbeat_at
FROM task_page p
JOIN tasks t ON t.task_id = p.task_id ${CURRENT_RUN_JOINS}`
const TASK_PAGE_START = `WITH task_page AS MATERIALIZED (
  SELECT task_id, sort_at, sort_weight, lane FROM task_attention_order WHERE `
const TASK_PAGE_ORDER = ' ORDER BY sort_weight DESC, sort_at DESC, task_id DESC'

export type WorkspaceOverview = {
  lanes: Record<TaskLane, number>
  open_decisions: number
  unverified_effects: number
  release_gate?: ReleaseGateCardState
}

export function getWorkspaceOverview(db: Db, includeRelease = false): { item: WorkspaceOverview; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const lanes: WorkspaceOverview['lanes'] = { upcoming: 0, running: 0, attention: 0, finished: 0 }
    const counts = ctx.tx.all<{ lane: TaskLane; count: number }>(
      'SELECT lane, COUNT(*) AS count FROM task_attention_order WHERE archived = 0 GROUP BY lane')
    for (const row of counts) lanes[row.lane] = row.count
    const decisions = ctx.tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM decisions WHERE status IN ('pending','acknowledged','blocked_for_human')")
    const effects = ctx.tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM node_runs n WHERE ' + UNVERIFIED_EFFECT)
    return { item: { lanes, open_decisions: decisions?.count ?? 0, unverified_effects: effects?.count ?? 0,
      ...(includeRelease ? { release_gate: readReleaseGateCard(ctx.tx) } : {}) }, as_of_seq: ctx.as_of_seq }
  })
}

export function listTaskSummaries(db: Db, params: ListTaskParams = {}): { items: TaskSummary[]; next_cursor: string | null; as_of_seq: number } {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > TASKS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(TASKS_LIMIT_MAX) + ' 条', { limit })
  const filter = {
    status: params.status ?? null, attention: params.attention ?? null, query: params.query ?? null,
    lane: params.lane ?? null, trigger_kind: params.trigger_kind ?? null, archived: params.archived === true,
    updated_from: params.updated_from ?? null, updated_before: params.updated_before ?? null,
  }
  return withReadTx(db, (ctx) => {
    const now = params.now ?? Date.now()
    const where = ['archived = ?']
    const values: unknown[] = [filter.archived ? 1 : 0]
    if (filter.status) { where.push('status = ?'); values.push(filter.status) }
    if (filter.attention) { where.push('attention_weight = ?'); values.push(attentionWeight(filter.attention)) }
    if (filter.lane) { where.push('lane = ?'); values.push(filter.lane) }
    if (filter.trigger_kind === 'unknown') where.push('trigger_kind IS NULL')
    else if (filter.trigger_kind) { where.push('trigger_kind = ?'); values.push(filter.trigger_kind) }
    if (filter.updated_from) { where.push('updated_at >= ?'); values.push(filter.updated_from) }
    if (filter.updated_before) { where.push('updated_at < ?'); values.push(filter.updated_before) }
    if (filter.query) {
      where.push(`EXISTS (SELECT 1 FROM tasks search
        WHERE search.task_id = task_attention_order.task_id AND
          (instr(lower(search.title), lower(?)) > 0 OR instr(lower(search.task_id), lower(?)) > 0))`)
      values.push(filter.query, filter.query)
    }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'tasks', filter, now)
      const separator = cursor.last_key.indexOf('\t')
      const lastWeight = Number(cursor.last_key.slice(0, separator))
      const lastUpdatedAt = cursor.last_key.slice(separator + 1)
      if (separator < 1 || !Number.isInteger(lastWeight) || lastWeight < 1 || lastWeight > 6 || !lastUpdatedAt) {
        throw new OrchError('CURSOR_EXPIRED', '游标里的任务位置不合法，请重新加载', { task_id: cursor.last_id })
      }
      where.push('(sort_weight, sort_at, task_id) < (?, ?, ?)')
      values.push(lastWeight, lastUpdatedAt, cursor.last_id)
    }
    const rows = ctx.tx.all<TaskRow & { sort_weight: number; sort_at: string }>(
      TASK_PAGE_START + where.join(' AND ') + TASK_PAGE_ORDER + ' LIMIT ?) '
      + TASK_SUMMARY_SELECT + ' ORDER BY p.sort_weight DESC, p.sort_at DESC, p.task_id DESC',
      [...values, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((row) => taskSummary(row, now))
    const last = page[page.length - 1]
    const nextCursor = hasMore && last
      ? encodeCursor(makeCursor('tasks', filter, `${last.sort_weight}\t${last.sort_at}`, last.task_id, ctx.as_of_seq, now))
      : null
    return { items, next_cursor: nextCursor, as_of_seq: ctx.as_of_seq }
  })
}

export function getTaskSummarySnapshot(db: Db, taskId: string, now = Date.now()): { item: TaskSummary; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<TaskRow>(TASK_PAGE_START + 'task_id = ?) ' + TASK_SUMMARY_SELECT, [taskId])
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个任务', { task_id: taskId })
    return { item: taskSummary(row, now), as_of_seq: ctx.as_of_seq }
  })
}

export function getTaskSummary(db: Db, taskId: string, now = Date.now()): TaskSummary {
  return getTaskSummarySnapshot(db, taskId, now).item
}
